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
  type UpstreamErrorCode,
  UpstreamError,
} from "../../../ports/upstream";
import {
  type UpstreamHttpDeps,
  requireApiKey,
  stripTrailingSlash,
  upstreamGetJson,
  upstreamSend,
  filterAfterCursor,
  parseUpstreamDate,
} from "../_shared/http";

/**
 * YYDS Mail API 适配器（https://vip.215.im/docs，OpenAPI 规范见上游 /v1/openapi.json）。
 * 端点（相对 API 根 /v1，全部响应为 {success, data, error, errorCode} 信封）：
 *   GET    /v1/domains                    → Domain[]（.domain 字符串）
 *   POST   /v1/accounts                   → CreateAccountResponse（body: {domain, localPart?}，支持 Idempotency-Key）
 *   DELETE /v1/accounts/{id}              → 停用临时邮箱（接受 X-API-Key）
 *   GET    /v1/messages?address=          → {messages: MessageListItem[], total, unreadCount}（API Key 必须显式带 address）
 *   GET    /v1/messages/{id}?address=     → MessageDetail（text/html[]/attachments/intro）
 *   DELETE /v1/messages/{id}?address=     → 删除单封
 *   GET    /v1/sources/{id}?address=      → {id, data: 原始 RFC822 字符串}
 *
 * 鉴权：X-API-Key（AC- 前缀，管理端填入 apiKey）；响应中的 temp token（data.token）
 * 存入 ref.credentials 备用，消息读写统一走 API Key + address 查询参数。
 *
 * 有效期：响应 expiresAt 为权威；缺失时按官方留存策略（邮件 24h 自动删除）
 * 以 createdAt（或当前时间）+24h 推算，保证网关侧永远有到期时间。
 * 上游有效期不可配置 → CreateMailboxRequest.expiresInSeconds 忽略。
 */
const YYDS_MAIL_RETENTION_MS = 86_400_000;
/** 上游单页消息上限（GET /v1/messages limit 最大 200） */
const YYDS_LIST_LIMIT = 200;
/** 20 页 × 200 = 4000 封，临时邮箱足够；再多宁可不完整也不打爆上游 */
const YYDS_LIST_MAX_PAGES = 20;

interface YydsEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}

interface YydsEmailAddress {
  name?: string;
  address?: string;
}

interface YydsAttachment {
  id?: string;
  filename?: string;
  contentType?: string;
  size?: number;
}

interface YydsMessage {
  id?: string;
  from?: YydsEmailAddress | string;
  to?: (YydsEmailAddress | string)[];
  subject?: string;
  intro?: string;
  text?: string;
  html?: string[] | string;
  seen?: boolean;
  size?: number;
  hasAttachments?: boolean;
  createdAt?: string;
  attachments?: YydsAttachment[];
}

interface YydsCreateAccount {
  id?: string;
  address?: string;
  token?: string;
  expiresAt?: string | null;
  createdAt?: string;
}

/** YYDS Mail 建邮箱的原生端点（含 legacy 别名），用于透传副作用识别 */
const YYDS_CREATE_PATHS = new Set([
  "/v1/accounts",
  "/v1/accounts/wildcard",
  "/v1/emails",
  "/v1/inboxes",
  "/v1/mailboxes",
]);

export class YydsMailAdapter implements UpstreamAdapter {
  readonly type = "yydsmail";

  private readonly deps: UpstreamHttpDeps;

  constructor(deps: UpstreamAdapterDeps = {}) {
    this.deps = {
      fetchFn: deps.fetchFn ?? ((input, init) => fetch(input as never, init)),
      logger: deps.logger,
    };
  }

  authHeaders(cfg: UpstreamConfig): Record<string, string> {
    return { "X-API-Key": requireApiKey(cfg, "X-API-Key（AC- 前缀）") };
  }

  async listDomains(cfg: UpstreamConfig): Promise<DomainInfo[]> {
    const data = await this.getApi<{ id?: string; domain?: string; isPublic?: boolean }[]>(
      cfg, "/domains", "/v1/domains",
    );
    return (data ?? [])
      .map((d) => ({
        domain: String(d?.domain ?? "").trim().toLowerCase(),
        isPrivate: d?.isPublic === false ? true : undefined,
      }))
      .filter((d) => d.domain.length > 0);
  }

  async createMailbox(cfg: UpstreamConfig, req: CreateMailboxRequest): Promise<MailboxRef> {
    const body: Record<string, unknown> = { domain: req.domain };
    if (req.localPart) body.localPart = req.localPart;

    const env = await this.sendEnvelope(cfg, "/accounts", "POST", body, "/v1/accounts", {
      // 官方强烈建议：建邮箱带幂等键，重试不会意外开出第二个邮箱
      "Idempotency-Key": crypto.randomUUID(),
    });
    const data = envelopeData<YydsCreateAccount>(env, cfg.id, "/v1/accounts");
    if (!data?.address) {
      throw new UpstreamError("UNKNOWN", cfg.id, {
        message: "上游 /v1/accounts 响应缺少 address 字段",
      });
    }
    return {
      // 官方文档要求后续操作使用接口返回的最终 address（wildcard 子域场景可能带子域前缀）
      upstreamMailboxId: String(data.id ?? data.address),
      address: data.address,
      credentials: data.token ?? undefined,
      expiresAt: resolveExpiresAt(data),
    };
  }

  async deleteMailbox(cfg: UpstreamConfig, ref: MailboxRef): Promise<void> {
    // 删除同样要校验信封：2xx 但 success=false（如 NOT_FOUND）是业务失败，只查 HTTP
    // 状态会把删除误报成功、让上游资源静默残留（force=1 时也不会记孤儿）；空 body/204 合法
    await this.sendEnvelope(
      cfg, `/accounts/${encodeURIComponent(ref.upstreamMailboxId)}`, "DELETE", undefined, "/v1/accounts",
    );
  }

  async listMessages(
    cfg: UpstreamConfig,
    ref: MailboxRef,
    opts?: { since?: string },
  ): Promise<MessageSummary[]> {
    // 上游单页最多 200。早先只打一枪，第 201 封起既列不出也读不到。
    // offset 按官方信封的 total 翻页；若上游忽略 offset（第二页又回到第一页），
    // 用首条 id 去重后立刻停，避免死循环。
    const collected: YydsMessage[] = [];
    let offset = 0;
    for (let page = 0; page < YYDS_LIST_MAX_PAGES; page += 1) {
      const data = await this.getApi<{ messages?: YydsMessage[]; total?: number }>(
        cfg,
        `/messages?address=${encodeURIComponent(ref.address)}&limit=${YYDS_LIST_LIMIT}&offset=${offset}`,
        "/v1/messages",
      );
      const batch = data?.messages ?? [];
      if (page > 0 && batch[0]?.id && collected[0]?.id === batch[0].id) break;
      collected.push(...batch);
      if (batch.length < YYDS_LIST_LIMIT) break;
      if (typeof data?.total === "number" && collected.length >= data.total) break;
      offset += YYDS_LIST_LIMIT;
    }
    const summaries = collected
      .map((m) => toSummary(ref, m))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return filterAfterCursor(summaries, opts?.since);
  }

  async getMessage(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<MessageDetail> {
    const data = await this.getApi<YydsMessage>(
      cfg,
      `/messages/${encodeURIComponent(messageId)}?address=${encodeURIComponent(ref.address)}`,
      "/v1/messages",
    );
    const attachments = (data?.attachments ?? []).map((a) => ({
      id: String(a?.id ?? ""),
      filename: a?.filename ?? "",
      contentType: a?.contentType ?? "",
      size: Number(a?.size ?? 0),
    }));
    return {
      ...toSummary(ref, data ?? {}),
      text: data?.text ?? undefined,
      html: htmlOf(data?.html),
      attachments,
    };
  }

  async deleteMessage(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<void> {
    // 同上：DELETE 的 2xx 只代表 HTTP 层成功，信封 success=false 仍按失败处理
    await this.sendEnvelope(
      cfg,
      `/messages/${encodeURIComponent(messageId)}?address=${encodeURIComponent(ref.address)}`,
      "DELETE", undefined, "/v1/messages",
    );
  }

  async getSource(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<Uint8Array> {
    const data = await this.getApi<{ id?: string; data?: string }>(
      cfg,
      `/sources/${encodeURIComponent(messageId)}?address=${encodeURIComponent(ref.address)}`,
      "/v1/sources",
    );
    const raw = typeof data?.data === "string" ? data.data : "";
    return new TextEncoder().encode(raw);
  }

  passthroughMailboxId(path: string): string | null {
    const match = /^\/v1\/accounts\/([^/]+)$/.exec(path);
    return match && match[1] !== "wildcard" ? decodeURIComponent(match[1]!) : null;
  }

  /**
   * 透传副作用观察：
   *   POST /v1/accounts（含 /accounts/wildcard 与 legacy 别名）2xx → 登记；
   *   DELETE /v1/accounts/{id} 2xx → 注销。
   */
  inspectPassthrough(input: PassthroughInspectInput): PassthroughObservation | null {
    if (input.status < 200 || input.status >= 300) return null;

    if (input.method === "POST" && YYDS_CREATE_PATHS.has(input.path)) {
      try {
        const data = envelopeData<YydsCreateAccount>(
          JSON.parse(input.responseBodyText ?? "{}"), "", input.path,
        );
        if (!data?.address) return null;
        return {
          action: "created",
          ref: {
            upstreamMailboxId: String(data.id ?? data.address),
            address: data.address,
            credentials: data.token ?? undefined,
            expiresAt: resolveExpiresAt(data),
          },
        };
      } catch {
        return null;
      }
    }

    if (input.method === "DELETE") {
      const match = /^\/v1\/accounts\/([^/]+)$/.exec(input.path);
      if (match && match[1] !== "wildcard") {
        try {
          if (input.responseBodyText?.trim()) {
            const env: unknown = JSON.parse(input.responseBodyText);
            if (env && typeof env === "object" && (env as YydsEnvelope<unknown>).success === false) return null;
          }
        } catch {
          return null;
        }
        return { action: "deleted", upstreamMailboxId: decodeURIComponent(match[1]!) };
      }
    }
    return null;
  }

  /**
   * 透传列表过滤：GET /v1/domains → { success, data: [{domain, ...}] }（公开端点），
   * 按可用域名剔除 Domain 条目，其余信封字段原样保留。
   */
  filterPassthroughList(input: {
    path: string;
    responseBodyText: string;
    isDomainAllowed: (domain: string) => boolean;
  }): string | null {
    if (input.path !== "/v1/domains") return null;
    try {
      const parsed: unknown = JSON.parse(input.responseBodyText);
      if (!parsed || typeof parsed !== "object") return null;
      const env = parsed as { data?: unknown };
      if (!Array.isArray(env.data)) return null;
      const filtered = (env.data as Record<string, unknown>[]).filter((item) => {
        const domain = typeof item?.domain === "string" ? item.domain.toLowerCase() : "";
        return !domain || input.isDomainAllowed(domain);
      });
      return JSON.stringify({ ...(parsed as object), data: filtered });
    } catch {
      return null;
    }
  }

  // ---------- internals ----------

  /** GET + 信封解包；2xx 但 success=false 或缺 data 也视为失败 */
  private async getApi<T>(cfg: UpstreamConfig, pathWithQuery: string, endpoint: string): Promise<T> {
    const env = await upstreamGetJson<YydsEnvelope<T>>(
      this.deps, cfg, `${apiBase(cfg)}${pathWithQuery}`, this.authHeaders(cfg), endpoint,
    );
    return envelopeData<T>(env, cfg.id, endpoint);
  }

  private async sendEnvelope(
    cfg: UpstreamConfig,
    path: string,
    method: "POST" | "DELETE",
    body: unknown,
    endpoint: string,
    extraHeaders?: Record<string, string>,
  ): Promise<YydsEnvelope<unknown>> {
    const res = await upstreamSend(
      this.deps, cfg, `${apiBase(cfg)}${path}`, method,
      { ...this.authHeaders(cfg), ...extraHeaders }, body, endpoint,
    );
    const env = (await res.json().catch(() => ({}))) as YydsEnvelope<unknown>;
    // 2xx 但信封 success=false（errorCode 如 NOT_FOUND）仍是业务失败——
    // 只查 HTTP 状态会让读/写路径吞掉上游明确报告的失败
    if (env.success === false) throw envelopeFailure(env, cfg.id, endpoint);
    return env;
  }
}

// ---------- module helpers ----------

/** baseUrl 允许带或不带 /v1：统一归一为以 /v1 结尾的 API 根 */
function apiBase(cfg: UpstreamConfig): string {
  const base = stripTrailingSlash(cfg.baseUrl);
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

/** 上游信封 errorCode → 网关错误码：含 NOT_FOUND（忽略大小写）视为「已不存在」
 *  （读路径映射 404、删除路径交给网关幂等删除），其余一律 UNKNOWN 保持既有语义 */
function envelopeErrorCode(errorCode: string | undefined): UpstreamErrorCode {
  return errorCode && /NOT_FOUND/i.test(errorCode) ? "NOT_FOUND" : "UNKNOWN";
}

/** 信封 success=false → 构造 UpstreamError（2xx 不代表业务成功） */
function envelopeFailure(env: YydsEnvelope<unknown>, upstreamId: string, endpoint: string): UpstreamError {
  return new UpstreamError(envelopeErrorCode(env.errorCode), upstreamId, {
    message: `上游 ${endpoint} 返回失败：${env.error ?? "未知错误"}${env.errorCode ? ` (${env.errorCode})` : ""}`,
  });
}

/** 解开 {success, data, error, errorCode} 信封；success=false 视为上游业务失败 */
function envelopeData<T>(env: unknown, upstreamId: string, endpoint: string): T {
  if (env && typeof env === "object" && (env as YydsEnvelope<T>).success === false) {
    // 读一封已被上游清理的邮件等：errorCode 带 NOT_FOUND 时应是 404 而非笼统的 502
    throw envelopeFailure(env as YydsEnvelope<T>, upstreamId, endpoint);
  }
  const data = (env as YydsEnvelope<T> | undefined)?.data;
  if (data === undefined) {
    throw new UpstreamError("UNKNOWN", upstreamId, {
      message: `上游 ${endpoint} 响应缺少 data 字段`,
    });
  }
  return data;
}

/** 到期时间：响应 expiresAt 优先；否则按官方 24h 留存策略推算 */
function resolveExpiresAt(data: YydsCreateAccount): Date {
  const explicit = parseUpstreamDate(data.expiresAt);
  if (explicit.getTime() > 0) return explicit;
  const created = parseUpstreamDate(data.createdAt);
  const base = created.getTime() > 0 ? created.getTime() : Date.now();
  return new Date(base + YYDS_MAIL_RETENTION_MS);
}

function toSummary(ref: MailboxRef, m: YydsMessage): MessageSummary {
  const to = addressList(m.to);
  return {
    id: String(m.id ?? ""),
    from: formatAddress(m.from),
    to: to.length > 0 ? to : [ref.address],
    subject: m.subject ?? "",
    intro: m.intro ?? (m.text ? m.text.slice(0, 128) : undefined),
    seen: Boolean(m.seen),
    hasAttachments: Boolean(m.hasAttachments) || (m.attachments?.length ?? 0) > 0,
    createdAt: parseUpstreamDate(m.createdAt),
  };
}

function formatAddress(a: YydsEmailAddress | string | undefined): string {
  if (!a) return "";
  if (typeof a === "string") return a;
  const addr = a.address ?? "";
  return a.name ? `${a.name} <${addr}>` : addr;
}

function addressList(to: (YydsEmailAddress | string)[] | undefined): string[] {
  return (Array.isArray(to) ? to : [])
    .map((a) => formatAddress(a))
    .filter((s) => s.length > 0);
}

function htmlOf(html: string[] | string | undefined): string[] {
  if (Array.isArray(html)) return html.map(String);
  return html ? [String(html)] : [];
}
