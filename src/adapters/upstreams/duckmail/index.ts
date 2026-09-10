import {
  type UpstreamAdapter,
  type UpstreamConfig,
  type CreateMailboxRequest,
  type MailboxRef,
  type DomainInfo,
  type MessageSummary,
  type MessageDetail,
  type UpstreamAdapterDeps,
  type PassthroughInspectInput,
  type PassthroughObservation,
  UpstreamError,
} from "../../../ports/upstream";
import {
  type UpstreamHttpDeps,
  stripTrailingSlash,
  upstreamGetJson,
  upstreamSend,
  filterAfterCursor,
  randomLocalPart,
  parseUpstreamDate,
  networkError,
  upstreamHttpError,
} from "../_shared/http";

/**
 * DuckMail API 适配器（文档：仓库 public/llm-api-docs.txt，Base URL https://api.duckmail.sbs）。
 *   GET    /domains?page=N            → { hydra:member: [{domain, ownerId}], hydra:totalItems }（公开；带 dk_ API Key 可见私有域名，30 条/页）
 *   POST   /accounts {address, password, expiresIn?} → 201 {id, address}（expiresIn 秒：缺省 24h，0/-1 永久）
 *   POST   /token {address, password} → {id, token}（每邮箱独立的 Bearer 凭证）
 *   GET    /messages?page=N           → { hydra:member: [...headers only] }（Bearer = 邮箱 token，新到旧）
 *   GET    /messages/{id}             → 全文（text/html[]/attachments）
 *   DELETE /messages/{id}             → 204
 *   GET    /sources/{id}              → {data: 原始 RFC822}
 *   DELETE /accounts/{id}             → 204（Bearer 只能删自己）
 *
 * 鉴权映射：cfg.apiKey（dk_ API Key）用于域名列表与私有域名建箱；每个邮箱的临时
 * Bearer token 存入 ref.credentials、密码存入 ref.password（均加密落库）。
 * 注意：上游要求用户名 ≥3 字符、密码 ≥6 字符，校验失败原样返回 422。
 */
const DEFAULT_RETENTION_MS = 86_400_000; // 上游缺省 24h 自动清理
const DOMAIN_PAGE_SIZE = 30;
const DOMAIN_MAX_PAGES = 20; // 20 页 × 30 = 600 个域名的读取上限
const MESSAGE_PAGES = 20; // 20 页 × 30 = 600 封最新消息；再多宁可不完整也不打爆上游

interface HydraList<T> {
  "hydra:member"?: T[];
  "hydra:totalItems"?: number;
}

interface DuckMailMessage {
  id?: string;
  from?: { name?: string; address?: string } | string;
  to?: { name?: string; address?: string }[];
  subject?: string;
  seen?: boolean;
  hasAttachments?: boolean;
  createdAt?: string;
  text?: string;
  html?: string[];
  attachments?: { id?: string; filename?: string; contentType?: string; size?: number }[];
}

export class DuckMailAdapter implements UpstreamAdapter {
  readonly type = "duckmail";

  /**
   * 邮箱操作依赖每邮箱独立凭证：密码在建箱时随机生成、只以密文存在网关库里。
   * Bearer token 过期（或建箱时 /token 失败）可以用这份密码再换一次；
   * 但删掉网关记录就连密码也没了，上游邮箱永久不可读、也无法再清理，
   * 所以尽力删除（?force=1）遇到上游删除失败时会被网关拒绝（409）。
   */
  readonly requiresMailboxCredentials = true;

  private readonly deps: UpstreamHttpDeps;

  constructor(deps: UpstreamAdapterDeps = {}) {
    this.deps = {
      fetchFn: deps.fetchFn ?? ((input, init) => fetch(input as never, init)),
      logger: deps.logger,
    };
  }

  /** dk_ API Key（可选）：私有域名可见与私有域名建箱需要 */
  private authHeader(cfg: UpstreamConfig): Record<string, string> {
    return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
  }

  async listDomains(cfg: UpstreamConfig): Promise<DomainInfo[]> {
    const base = stripTrailingSlash(cfg.baseUrl);
    const headers = this.authHeader(cfg);
    const seen = new Set<string>();
    const out: DomainInfo[] = [];

    // 域名列表分页（30 条/页）：翻页直到取满 totalItems 或空页
    for (let page = 1; page <= DOMAIN_MAX_PAGES; page++) {
      const data = await upstreamGetJson<HydraList<{ domain?: string; ownerId?: string | null }>>(
        this.deps, cfg, `${base}/domains?page=${page}`, headers, "/domains",
      );
      const rows = data["hydra:member"] ?? [];
      for (const row of rows) {
        const domain = String(row?.domain ?? "").trim().toLowerCase();
        if (!domain || seen.has(domain)) continue;
        seen.add(domain);
        out.push({ domain, isPrivate: row?.ownerId != null ? true : undefined });
      }
      const total = Number(data["hydra:totalItems"] ?? 0);
      if (rows.length < DOMAIN_PAGE_SIZE || (total > 0 && seen.size >= total)) break;
    }
    return out;
  }

  async createMailbox(cfg: UpstreamConfig, req: CreateMailboxRequest): Promise<MailboxRef> {
    const base = stripTrailingSlash(cfg.baseUrl);
    const localPart = (req.localPart ?? randomLocalPart()).toLowerCase();
    const password = randomPassword();
    const address = `${localPart}@${req.domain}`;

    const body: Record<string, unknown> = {
      address,
      password,
    };
    // 上游语义：缺省 = 24h 自动清理；正数秒 = 自定义有效期
    if (req.expiresInSeconds && req.expiresInSeconds > 0) body.expiresIn = req.expiresInSeconds;

    const created = await upstreamSend(
      this.deps, cfg, `${base}/accounts`, "POST",
      { "Content-Type": "application/json", ...this.authHeader(cfg) }, body, "/accounts",
    );
    const createdBody = (await created.json().catch(() => ({}))) as { id?: string; address?: string };

    // 创建响应不含 token，需用 address+password 换取邮箱的 Bearer 凭证。
    // /token 失败时**不要**把整次建箱打成失败——账户已经在上游建好了，
    // 打成失败会留下网关没有记录的孤儿。密码已经拿到，读信时再换 token。
    const finalAddress = createdBody.address ?? address;
    let token: string | undefined;
    try {
      token = await this.fetchMailboxToken(cfg, finalAddress, password);
    } catch (cause) {
      this.deps.logger?.("warn", "DuckMail /token 在建箱后失败，将在首次读信时重试", {
        address: finalAddress,
        error: (cause as Error)?.message ?? String(cause),
      });
    }

    return {
      upstreamMailboxId: createdBody.id ?? address, // DELETE /accounts/{id} 用创建时返回的账号 id
      address: finalAddress,
      credentials: token,
      password,
      expiresAt: req.expiresInSeconds && req.expiresInSeconds > 0
        ? new Date(Date.now() + req.expiresInSeconds * 1000)
        : new Date(Date.now() + DEFAULT_RETENTION_MS),
    };
  }

  async deleteMailbox(cfg: UpstreamConfig, ref: MailboxRef): Promise<void> {
    await this.withMailboxAuth(cfg, ref, (token) =>
      upstreamSend(
        this.deps, cfg,
        `${stripTrailingSlash(cfg.baseUrl)}/accounts/${encodeURIComponent(ref.upstreamMailboxId)}`,
        "DELETE", { Authorization: `Bearer ${token}` }, undefined, "/accounts",
      ),
    );
  }

  async listMessages(
    cfg: UpstreamConfig,
    ref: MailboxRef,
    opts?: { since?: string },
  ): Promise<MessageSummary[]> {
    const messages = await this.withMailboxAuth(cfg, ref, async (token) => {
      const base = stripTrailingSlash(cfg.baseUrl);
      const headers = { Authorization: `Bearer ${token}` };
      const out: DuckMailMessage[] = [];
      // 新到旧分页：最多取 MESSAGE_PAGES 页，翻页后统一按时间升序交给游标过滤
      for (let page = 1; page <= MESSAGE_PAGES; page++) {
        const data = await upstreamGetJson<HydraList<DuckMailMessage>>(
          this.deps, cfg, `${base}/messages?page=${page}`, headers, "/messages",
        );
        const rows = data["hydra:member"] ?? [];
        out.push(...rows);
        if (rows.length < DOMAIN_PAGE_SIZE) break;
      }
      return out;
    });

    const summaries = messages
      .map((m) => this.toSummary(ref, m))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return filterAfterCursor(summaries, opts?.since);
  }

  async getMessage(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<MessageDetail> {
    const data = await this.withMailboxAuth(cfg, ref, (token) =>
      upstreamGetJson<DuckMailMessage>(
        this.deps, cfg,
        `${stripTrailingSlash(cfg.baseUrl)}/messages/${encodeURIComponent(messageId)}`,
        { Authorization: `Bearer ${token}` }, "/messages",
      ),
    );
    return {
      ...this.toSummary(ref, data ?? {}),
      text: data?.text ?? undefined,
      html: Array.isArray(data?.html) ? data.html.map(String) : data?.html ? [String(data.html)] : [],
      attachments: (data?.attachments ?? []).map((a) => ({
        id: String(a?.id ?? ""),
        filename: a?.filename ?? "",
        contentType: a?.contentType ?? "",
        size: Number(a?.size ?? 0),
      })),
    };
  }

  async deleteMessage(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<void> {
    await this.withMailboxAuth(cfg, ref, (token) =>
      upstreamSend(
        this.deps, cfg,
        `${stripTrailingSlash(cfg.baseUrl)}/messages/${encodeURIComponent(messageId)}`,
        "DELETE", { Authorization: `Bearer ${token}` }, undefined, "/messages",
      ),
    );
  }

  async getSource(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<Uint8Array> {
    const data = await this.withMailboxAuth(cfg, ref, (token) =>
      upstreamGetJson<{ data?: string }>(
        this.deps, cfg,
        `${stripTrailingSlash(cfg.baseUrl)}/sources/${encodeURIComponent(messageId)}`,
        { Authorization: `Bearer ${token}` }, "/sources",
      ),
    );
    return new TextEncoder().encode(typeof data?.data === "string" ? data.data : "");
  }

  /** 透传注入：dk_ API Key（域名列表/私有域名建箱可用；消息面需要各邮箱自己的 token） */
  authHeaders(cfg: UpstreamConfig): Record<string, string> {
    return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
  }

  passthroughMailboxId(path: string): string | null {
    const match = /^\/accounts\/([^/]+)$/.exec(path);
    return match ? decodeURIComponent(match[1]!) : null;
  }

  /**
   * 透传副作用观察：POST /accounts 2xx → 登记（expiresIn>0 → 按其推算到期，
   * 缺省 → 24h，0/-1 → 永不）；DELETE /accounts/{id} 2xx → 注销。
   */
  inspectPassthrough(input: PassthroughInspectInput): PassthroughObservation | null {
    if (input.status < 200 || input.status >= 300) return null;

    if (input.method === "POST" && input.path === "/accounts") {
      try {
        const req = JSON.parse(input.requestBodyText ?? "{}") as { address?: string; expiresIn?: number };
        const res = JSON.parse(input.responseBodyText ?? "{}") as { id?: string; address?: string };
        const address = (res.address ?? req.address ?? "").toLowerCase();
        if (!address.includes("@")) return null;
        const expiresIn = Number(req.expiresIn);
        const expiresAt =
          Number.isFinite(expiresIn) && expiresIn > 0
            ? new Date(Date.now() + expiresIn * 1000)
            : Number.isFinite(expiresIn) && expiresIn <= 0
              ? undefined // 0/-1 = 永久
              : new Date(Date.now() + DEFAULT_RETENTION_MS);
        return {
          action: "created",
          ref: {
            upstreamMailboxId: res.id ?? address,
            address,
            credentials: undefined, // 透传建箱的 token 由客户端持有，网关侧无凭证
            expiresAt,
          },
        };
      } catch {
        return null;
      }
    }

    if (input.method === "DELETE") {
      const match = /^\/accounts\/([^/]+)$/.exec(input.path);
      if (match) return { action: "deleted", upstreamMailboxId: decodeURIComponent(match[1]!) };
    }
    return null;
  }

  /** 透传列表过滤：GET /domains 的 hydra:member 按可用域名过滤 */
  filterPassthroughList(input: {
    path: string;
    responseBodyText: string;
    isDomainAllowed: (domain: string) => boolean;
  }): string | null {
    if (input.path !== "/domains") return null;
    try {
      const parsed: unknown = JSON.parse(input.responseBodyText);
      if (!parsed || typeof parsed !== "object") return null;
      const list = parsed as HydraList<{ domain?: string }>;
      if (!Array.isArray(list["hydra:member"])) return null;
      const filtered = list["hydra:member"]!.filter((item) => {
        const domain = typeof item?.domain === "string" ? item.domain.toLowerCase() : "";
        return !domain || input.isDomainAllowed(domain);
      });
      return JSON.stringify({ ...(parsed as object), "hydra:member": filtered });
    } catch {
      return null;
    }
  }

  // ---------- internals ----------

  /**
   * 消息面一律走「当前 token → 401 则用密码换新 token 再试一次」。
   * 建箱时 /token 失败、或上游 token 过期，只要 password 还在就能自愈。
   * 新 token 只写回本次 ref（进程内），不回写网关库——下一次请求若再 401 会再换一次。
   */
  private async withMailboxAuth<T>(
    cfg: UpstreamConfig,
    ref: MailboxRef,
    run: (token: string) => Promise<T>,
  ): Promise<T> {
    let token = ref.credentials;
    if (!token) {
      if (!ref.password) {
        throw new UpstreamError("CAPABILITY_MISSING", cfg.id, {
          message: "缺少邮箱 token 与密码，无法操作该 DuckMail 邮箱（透传创建的记录没有凭证）",
        });
      }
      token = await this.fetchMailboxToken(cfg, ref.address, ref.password);
      ref.credentials = token;
    }
    try {
      return await run(token);
    } catch (err) {
      if (!(err instanceof UpstreamError) || err.code !== "AUTH_FAILED" || !ref.password) throw err;
      token = await this.fetchMailboxToken(cfg, ref.address, ref.password);
      ref.credentials = token;
      return await run(token);
    }
  }

  private async fetchMailboxToken(cfg: UpstreamConfig, address: string, password: string): Promise<string> {
    const url = `${stripTrailingSlash(cfg.baseUrl)}/token`;
    let res: Response;
    try {
      res = await this.deps.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, password }),
      });
    } catch (cause) {
      throw networkError(cfg, "/token", cause);
    }
    if (!res.ok) {
      throw upstreamHttpError(cfg, res.status, await res.text().catch(() => ""), "/token POST");
    }
    const body = (await res.json().catch(() => ({}))) as { token?: string };
    if (!body.token) {
      throw new UpstreamError("UNKNOWN", cfg.id, { message: "上游 /token 响应缺少 token 字段" });
    }
    return body.token;
  }

  private toSummary(ref: MailboxRef, m: DuckMailMessage): MessageSummary {
    const from = typeof m.from === "string" ? m.from : `${m.from?.name ? `${m.from.name} ` : ""}${m.from?.address ?? ""}`.trim();
    const to = Array.isArray(m.to)
      ? m.to.map((t) => (typeof t === "string" ? t : t?.address ?? "")).filter((s) => s.length > 0)
      : [ref.address];
    return {
      id: String(m.id ?? ""),
      from,
      to: to.length > 0 ? to : [ref.address],
      subject: m.subject ?? "",
      seen: Boolean(m.seen),
      hasAttachments: Boolean(m.hasAttachments),
      createdAt: parseUpstreamDate(m.createdAt),
    };
  }
}

/** 生成 ≥6 字符的随机密码（网关代管，加密落库） */
function randomPassword(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
