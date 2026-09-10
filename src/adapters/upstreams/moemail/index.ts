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
  requireApiKey,
  stripTrailingSlash,
  upstreamGetJson,
  upstreamSend,
  filterAfterCursor,
  randomLocalPart,
  parseUpstreamDate,
} from "../_shared/http";

/**
 * MoeMail（beilunyang/moemail）API 适配器。
 * 端点与字段以 2026-09-07 读到的参考项目源码为准（app/api/emails/**），并对真实实例实测：
 *   GET    /api/config                       → { emailDomains: "a.com,b.com" }（X-API-Key）
 *   POST   /api/emails/generate              → { id, email }（body: {name, domain, expiryTime(ms)}）
 *   GET    /api/emails                       → { emails, nextCursor, total }（游标分页，PAGE_SIZE=20，按 expiresAt>now 过滤）
 *   GET    /api/emails/{emailId}             → { messages, nextCursor, total }（游标分页 PAGE_SIZE=20，正文内联，默认排除 type=sent）
 *   GET    /api/emails/{emailId}/{messageId} → { message }（专用详情端点）
 *   DELETE /api/emails/{emailId}             → 删邮箱
 *   DELETE /api/emails/{emailId}/{messageId} → 删单封
 *
 * 单封删除的鉴权链路：middleware.ts 的 matcher 覆盖 /api/emails/:path*，先读 X-API-Key
 * 命中即短路（不走 session），handleApiKeyAuth 的前缀白名单正是 /api/emails* 与
 * /api/config*，所以账号级 key 可直接调用。此前本文件注明"上游无单封删除端点"是错的
 * ——只是参考实现 floatmail 不用这个功能，适配器跟着漏了。
 * 仍无原始报文端点（正文以 content/html 内联返回）→ getSource 不支持。
 *
 * 有效期（完全可选配置，最大兼容）：
 *   - 请求 expiresInSeconds > settings.defaultExpiryMs > 内置默认 24h，永不为空（真实实例校验必填）；
 *   - 真实 MoeMail 只接受固定档位，因此发送前自动"就近吸附"到档位表；
 *   - settings.expiryPresetsMs 可覆盖档位表；设为 [] 则原样透传不吸附（适配接受任意值的分支版本）；
 *   - 上游响应的 expiresAt（毫秒时间戳）回填为网关侧权威到期时间。
 *
 * 档位取值以上游源码 `app/types/email.ts` 的 EXPIRY_OPTIONS 为准，并已对用户的真实
 * 实例逐档实测（2026-09-07）：1h / 24h / 3d 通过，**7d 与任意值一律 400「无效的过期时间」**。
 * 此前档位表误含 7d（604800000），导致请求 3 天以上有效期时吸附到 7d → 建箱直接失败
 * （实测请求 5 天 / 30 天均 400）。
 *
 * expiryTime === 0 在上游表示**永久**（写入 expiresAt = 9999-01-01），是合法档位；
 * 但它不能参与"就近吸附"——否则请求 1 小时会被算成距离 0 更近而变成永久。
 * 因此 0 只在调用方显式要求永久时使用，见 resolveExpiryMs。
 */
export const MOEMAIL_DEFAULT_EXPIRY_PRESETS_MS = [3_600_000, 86_400_000, 259_200_000];
/** 上游的"永久"档位：expiryTime=0 → expiresAt 9999-01-01 */
export const MOEMAIL_PERMANENT_EXPIRY = 0;
const MOEMAIL_FALLBACK_EXPIRY_MS = 86_400_000;

interface MoeMessage {
  id?: number | string;
  message_id?: string;
  subject?: string;
  from_address?: string;
  to_address?: string;
  received_at?: string | number;
  content?: string;
  html?: string;
}

/** 游标分页翻页上限：上游每页 20 条，20 页 = 400 条，够任何临时邮箱用 */
const MOEMAIL_MAX_LIST_PAGES = 20;

/** GET /api/emails/{id}：消息列表页（游标分页，默认排除 type=sent） */
interface MoeMessageListPage {
  messages?: MoeMessage[];
  nextCursor?: string | null;
  total?: number;
}

/** GET /api/emails：邮箱列表页（游标分页，上游按 expiresAt > now 过滤） */
interface MoeMailboxListPage {
  emails?: { id?: unknown; address?: unknown; expiresAt?: unknown }[];
  nextCursor?: string | null;
  total?: number;
}

export class MoeMailAdapter implements UpstreamAdapter {
  readonly type = "moemail";

  private readonly deps: UpstreamHttpDeps;

  constructor(deps: UpstreamAdapterDeps = {}) {
    this.deps = {
      fetchFn: deps.fetchFn ?? ((input, init) => fetch(input as never, init)),
      logger: deps.logger,
    };
  }

  async listDomains(cfg: UpstreamConfig): Promise<DomainInfo[]> {
    const apiKey = requireApiKey(cfg, "X-API-Key");
    const base = stripTrailingSlash(cfg.baseUrl);
    const data = await upstreamGetJson<{ emailDomains?: string }>(
      this.deps, cfg, `${base}/api/config`, { "X-API-Key": apiKey }, "/api/config",
    );
    return String(data.emailDomains ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0)
      .map((domain) => ({ domain }));
  }

  async createMailbox(cfg: UpstreamConfig, req: CreateMailboxRequest): Promise<MailboxRef> {
    const apiKey = requireApiKey(cfg, "X-API-Key");
    const base = stripTrailingSlash(cfg.baseUrl);

    const body: Record<string, unknown> = {
      name: req.localPart ?? randomLocalPart(),
      domain: req.domain,
    };
    const expiryTimeMs = resolveExpiryMs(req, cfg);
    body.expiryTime = expiryTimeMs;

    const res = await upstreamSend(
      this.deps, cfg, `${base}/api/emails/generate`, "POST",
      { "X-API-Key": apiKey },
      body,
      "/api/emails/generate",
    );
    const data = (await res.json().catch(() => ({}))) as {
      id?: number | string;
      email?: string;
      expiresAt?: unknown;
    };
    if (!data.email) {
      throw new UpstreamError("UNKNOWN", cfg.id, {
        message: "上游 /api/emails/generate 响应缺少 email 字段",
      });
    }
    // 权威到期时间：优先上游响应字段（新版本可能返回，毫秒时间戳或 ISO）；
    // 实测多数版本仅返回 {id, email}，此时用实际发送给上游的档位值推算——
    // 即使请求值被吸附改写（如 2h→1h），网关记录也与上游真实有效期一致。
    const upstreamExpiresAt = parseUpstreamDate(data.expiresAt);
    const expiresAt =
      upstreamExpiresAt.getTime() > 0
        ? upstreamExpiresAt
        : expiryTimeMs === MOEMAIL_PERMANENT_EXPIRY
          ? undefined // 永久：网关侧不写到期时间，与 expiresAt=null 的语义一致
          : new Date(Date.now() + expiryTimeMs);
    return {
      upstreamMailboxId: String(data.id ?? data.email),
      address: data.email,
      expiresAt,
    };
  }

  async deleteMailbox(cfg: UpstreamConfig, ref: MailboxRef): Promise<void> {
    const apiKey = requireApiKey(cfg, "X-API-Key");
    const base = stripTrailingSlash(cfg.baseUrl);
    await upstreamSend(
      this.deps, cfg, `${base}/api/emails/${encodeURIComponent(ref.upstreamMailboxId)}`, "DELETE",
      { "X-API-Key": apiKey }, undefined, "/api/emails",
    );
  }

  async listMessages(
    cfg: UpstreamConfig,
    ref: MailboxRef,
    opts?: { since?: string },
  ): Promise<MessageSummary[]> {
    const messages = await this.fetchMessages(cfg, ref, "/api/emails");
    const summaries = messages.map((m) => this.toSummary(ref, m)).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    return filterAfterCursor(summaries, opts?.since);
  }

  /**
   * 读单封走专用端点 GET /api/emails/{emailId}/{messageId}。
   * 早先是「重新列表再按 id 过滤」，有两个毛病：列表分页只覆盖最近 20 封（第 21 封起
   * 读不到），且为读一封要把整页正文全搬回来。上游对不存在的消息返回 404、
   * 邮箱不属于调用者返回 403，都映射成 NOT_FOUND。
   */
  async getMessage(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<MessageDetail> {
    const apiKey = requireApiKey(cfg, "X-API-Key");
    const base = stripTrailingSlash(cfg.baseUrl);
    const data = await upstreamGetJson<{ message?: MoeMessage }>(
      this.deps, cfg,
      `${base}/api/emails/${encodeURIComponent(ref.upstreamMailboxId)}/${encodeURIComponent(messageId)}`,
      { "X-API-Key": apiKey },
      "/api/emails/{id}/{messageId}",
    );
    const match = data.message;
    if (!match) {
      throw new UpstreamError("NOT_FOUND", cfg.id, { message: `消息不存在: ${messageId}` });
    }
    return {
      ...this.toSummary(ref, match),
      text: match.content ?? undefined,
      html: match.html ? [match.html] : [],
      attachments: [],
    };
  }

  /**
   * 纳管：GET /api/emails 列出该账号名下全部邮箱，按地址反查出 id。
   * MoeMail 的 upstreamMailboxId 是 uuid 而非地址，必须走这一步映射；
   * 列表响应里带 expiresAt（与 generate 不同），顺带回填权威到期时间。
   */
  async resolveByAddress(cfg: UpstreamConfig, address: string): Promise<MailboxRef> {
    const apiKey = requireApiKey(cfg, "X-API-Key");
    const base = stripTrailingSlash(cfg.baseUrl);
    const normalized = address.trim().toLowerCase();

    // /api/emails 是游标分页（上游 PAGE_SIZE=20），必须翻页找——只看第一页的话，
    // 账号下邮箱超过 20 个时会把存在的地址误报成「不存在」。
    let cursor: string | null = null;
    for (let page = 0; page < MOEMAIL_MAX_LIST_PAGES; page += 1) {
      const url: string = cursor
        ? `${base}/api/emails?cursor=${encodeURIComponent(cursor)}`
        : `${base}/api/emails`;
      const data: MoeMailboxListPage = await upstreamGetJson<MoeMailboxListPage>(
        this.deps, cfg, url, { "X-API-Key": apiKey }, "/api/emails",
      );
      const hit = (data.emails ?? []).find(
        (e: { id?: unknown; address?: unknown; expiresAt?: unknown }) =>
          String(e?.address ?? "").trim().toLowerCase() === normalized,
      );
      if (hit?.id) {
        const expiresAt = parseUpstreamDate(hit.expiresAt);
        return {
          upstreamMailboxId: String(hit.id),
          address: normalized,
          expiresAt:
            Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > 0 ? expiresAt : undefined,
        };
      }
      cursor = typeof data.nextCursor === "string" && data.nextCursor ? data.nextCursor : null;
      if (!cursor) break;
    }
    throw new UpstreamError("NOT_FOUND", cfg.id, {
      // 上游列表按 expiresAt > now 过滤，已过期的邮箱查不到——提示里点明，
      // 否则用户会以为地址写错了
      message: `该 MoeMail 账号下不存在 ${normalized}（已过期的邮箱不会出现在上游列表中）`,
    });
  }

  /** 删单封：DELETE /api/emails/{emailId}/{messageId}（账号级 X-API-Key 即可） */
  async deleteMessage(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<void> {
    const apiKey = requireApiKey(cfg, "X-API-Key");
    const base = stripTrailingSlash(cfg.baseUrl);
    await upstreamSend(
      this.deps, cfg,
      `${base}/api/emails/${encodeURIComponent(ref.upstreamMailboxId)}/${encodeURIComponent(messageId)}`,
      "DELETE",
      { "X-API-Key": apiKey }, undefined, "/api/emails/{id}/{messageId}",
    );
  }

  authHeaders(cfg: UpstreamConfig): Record<string, string> {
    const apiKey = requireApiKey(cfg, "X-API-Key");
    return { "X-API-Key": apiKey };
  }

  passthroughMailboxId(path: string): string | null {
    const match = /^\/api\/emails\/([^/]+)(?:\/[^/]+)?$/.exec(path);
    return match ? decodeURIComponent(match[1]!) : null;
  }

  /**
   * 透传副作用观察：POST /api/emails/generate 2xx → 登记；DELETE /api/emails/{id} 2xx → 注销。
   * expiresAt 优先取响应字段（未来版本），否则用请求里的 expiryTime 推算。
   */
  inspectPassthrough(input: PassthroughInspectInput): PassthroughObservation | null {
    if (input.status < 200 || input.status >= 300) return null;

    if (input.method === "POST" && input.path === "/api/emails/generate") {
      try {
        const body = JSON.parse(input.responseBodyText ?? "{}") as {
          id?: number | string;
          email?: string;
          expiresAt?: unknown;
        };
        if (!body.email) return null;
        const upstreamExpiresAt = parseUpstreamDate(body.expiresAt);
        let expiresAt: Date | undefined;
        if (upstreamExpiresAt.getTime() > 0) {
          expiresAt = upstreamExpiresAt;
        } else {
          const req = JSON.parse(input.requestBodyText ?? "{}") as { expiryTime?: unknown };
          const expiryMs = Number(req.expiryTime);
          if (Number.isFinite(expiryMs) && expiryMs > 0) expiresAt = new Date(Date.now() + expiryMs);
        }
        return {
          action: "created",
          ref: { upstreamMailboxId: String(body.id ?? body.email), address: body.email, expiresAt },
        };
      } catch {
        return null;
      }
    }

    if (input.method === "DELETE") {
      const match = /^\/api\/emails\/([^/]+)$/.exec(input.path);
      if (match) return { action: "deleted", upstreamMailboxId: decodeURIComponent(match[1]!) };
    }
    return null;
  }

  // ---------- internals ----------

  /**
   * 透传列表过滤（floatmail MoeMail 渠道的数据来源）：
   *   - GET /api/emails → { emails: [{id, address, ...}] }，按可用域名剔除邮箱条目；
   *   - GET /api/config → { emailDomains: "a.com,b.com" }，改写为可用域名的 CSV
   *     （floatmail 的域名下拉来源，避免展示已停用/白名单外的域名）。
   * 无 address/domain 的条目保守保留；解析失败返回 null（body 原样返回）。
   */
  filterPassthroughList(input: {
    path: string;
    responseBodyText: string;
    isDomainAllowed: (domain: string) => boolean;
  }): string | null {
    try {
      const parsed: unknown = JSON.parse(input.responseBodyText);
      if (!parsed || typeof parsed !== "object") return null;

      if (input.path === "/api/emails") {
        const rows: Record<string, unknown>[] | null = Array.isArray(parsed)
          ? (parsed as Record<string, unknown>[])
          : Array.isArray((parsed as { emails?: unknown }).emails)
            ? ((parsed as { emails: Record<string, unknown>[] }).emails)
            : null;
        if (!rows) return null;
        const filtered = rows.filter((row) => {
          const address = typeof row?.address === "string" ? row.address : "";
          const domain = address.split("@")[1]?.toLowerCase();
          return !domain || input.isDomainAllowed(domain);
        });
        const body = Array.isArray(parsed) ? filtered : { ...(parsed as object), emails: filtered };
        return JSON.stringify(body);
      }

      if (input.path === "/api/config") {
        const config = parsed as { emailDomains?: unknown };
        if (typeof config.emailDomains !== "string") return null;
        const allowed = config.emailDomains
          .split(",")
          .map((d) => d.trim())
          .filter((d) => d.length > 0 && input.isDomainAllowed(d.toLowerCase()));
        return JSON.stringify({ ...config, emailDomains: allowed.join(",") });
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * 拉取消息列表。上游 GET /api/emails/{id} 是游标分页（PAGE_SIZE=20），
   * 只读第一页会静默丢掉更早的消息——收件箱超过 20 封时，第 21 封起既列不出来、
   * 也读不到详情（getMessage 早先靠重新列表再按 id 过滤）。这里跟随 nextCursor 翻页。
   */
  private async fetchMessages(cfg: UpstreamConfig, ref: MailboxRef, endpoint: string): Promise<MoeMessage[]> {
    const apiKey = requireApiKey(cfg, "X-API-Key");
    const base = stripTrailingSlash(cfg.baseUrl);
    const mailboxPath = `${base}/api/emails/${encodeURIComponent(ref.upstreamMailboxId)}`;
    const all: MoeMessage[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < MOEMAIL_MAX_LIST_PAGES; page += 1) {
      const url: string = cursor ? `${mailboxPath}?cursor=${encodeURIComponent(cursor)}` : mailboxPath;
      const data: MoeMessageListPage = await upstreamGetJson<MoeMessageListPage>(
        this.deps, cfg, url, { "X-API-Key": apiKey }, endpoint,
      );
      all.push(...(data.messages ?? []));
      cursor = typeof data.nextCursor === "string" && data.nextCursor ? data.nextCursor : null;
      if (!cursor) break;
    }
    return all;
  }

  private toSummary(ref: MailboxRef, m: MoeMessage): MessageSummary {
    const text = m.content ?? "";
    return {
      id: messageIdOf(m),
      from: m.from_address ?? "",
      to: [m.to_address ?? ref.address],
      subject: m.subject ?? "",
      intro: text ? text.slice(0, 128) : undefined,
      seen: false,
      hasAttachments: false,
      createdAt: new Date(messageTime(m)),
    };
  }
}

function messageIdOf(m: MoeMessage): string {
  return String(m.id ?? m.message_id ?? "");
}

function messageTime(m: MoeMessage): number {
  return parseUpstreamDate(m.received_at).getTime();
}

/**
 * 决定发送给上游的 expiryTime（毫秒）。
 * 取值链：显式请求 > settings.defaultExpiryMs > 内置默认 24h（上游校验必填，不能缺省）。
 *
 * 「永久」只能显式表达，绝不由吸附推导出来：
 *   - settings.defaultExpiryMs === 0 → 该渠道默认建永久邮箱；
 *   - 调用方 expiresInSeconds 不可能表达永久（统一 API 限定为正整数），
 *     所以显式请求一律走档位吸附。
 */
export function resolveExpiryMs(
  req: { expiresInSeconds?: number },
  cfg: { settings: Record<string, unknown> },
): number {
  const requestedSeconds = req.expiresInSeconds && req.expiresInSeconds > 0 ? req.expiresInSeconds : 0;
  if (requestedSeconds > 0) {
    return snapToPresets(requestedSeconds * 1000, cfg.settings.expiryPresetsMs);
  }
  // 未显式请求：settings 里显式写 0 表示永久（上游合法档位），其余走吸附
  const configured = cfg.settings.defaultExpiryMs;
  if (configured === 0 || configured === "0") return MOEMAIL_PERMANENT_EXPIRY;
  const configuredMs = Number(configured);
  return snapToPresets(
    Number.isFinite(configuredMs) && configuredMs > 0 ? configuredMs : MOEMAIL_FALLBACK_EXPIRY_MS,
    cfg.settings.expiryPresetsMs,
  );
}

/**
 * 就近吸附到档位表，返回发送给上游的毫秒值。
 * presetsOverride 为空数组时关闭吸附、原样透传（适配接受任意过期值的实例分支）。
 * 距离相同时取更长的档位（宁可多留收信时间）。
 */
export function snapToPresets(valueMs: number, presetsOverride?: unknown): number {
  const raw = Array.isArray(presetsOverride) ? presetsOverride : MOEMAIL_DEFAULT_EXPIRY_PRESETS_MS;
  const presets = raw
    .map((p) => Number(p))
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b);
  if (presets.length === 0) return valueMs;
  let best = presets[0]!;
  for (const p of presets) {
    const currentGap = Math.abs(p - valueMs);
    const bestGap = Math.abs(best - valueMs);
    if (currentGap < bestGap || (currentGap === bestGap && p > best)) best = p;
  }
  return best;
}
