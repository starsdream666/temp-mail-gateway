/**
 * 上游适配器契约 —— 网关与上游服务之间的唯一边界。
 * 适配器无状态：所有依赖（配置、邮箱引用）显式传参。
 * 任何失败抛 UpstreamError，由网关中间件统一映射 HTTP 状态码。
 */

/** 数据库中的一条上游配置（apiKey 已解密后传入适配器） */
export interface UpstreamConfig {
  id: string;
  type: string;
  baseUrl: string;
  apiKey?: string;
  settings: Record<string, unknown>;
}

export interface DomainInfo {
  domain: string;
  isPrivate?: boolean;
}

export interface CreateMailboxRequest {
  localPart?: string;
  domain: string;
  password?: string;
  /** 期望的邮箱有效期（秒）；上游支持则传递，不支持可忽略 */
  expiresInSeconds?: number;
}

/** 适配器返回的邮箱引用，网关原样加密入库 */
export interface MailboxRef {
  upstreamMailboxId: string;
  address: string;
  credentials?: string;
  password?: string;
  expiresAt?: Date;
}

export interface MessageSummary {
  id: string;
  from: string;
  to: string[];
  subject: string;
  intro?: string;
  seen: boolean;
  hasAttachments: boolean;
  createdAt: Date;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface MessageDetail extends MessageSummary {
  text?: string;
  html?: string[];
  attachments: AttachmentMeta[];
}

export type UpstreamErrorCode =
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CAPABILITY_MISSING"
  | "UNKNOWN";

export class UpstreamError extends Error {
  readonly code: UpstreamErrorCode;
  readonly upstreamId: string;
  readonly retryable: boolean;
  readonly upstreamCause?: unknown;

  constructor(
    code: UpstreamErrorCode,
    upstreamId: string,
    opts: { message: string; retryable?: boolean; cause?: unknown },
  ) {
    super(opts.message);
    this.name = "UpstreamError";
    this.code = code;
    this.upstreamId = upstreamId;
    this.retryable = opts.retryable ?? false;
    this.upstreamCause = opts.cause;
  }
}

export interface ListMessagesOptions {
  /** 游标：只返回晚于该消息 ID 的消息（适配器可自行解释） */
  since?: string;
}

export interface UpstreamAdapterDeps {
  /** 出网请求统一走这里，便于测试录制回放与将来接代理 */
  fetchFn?: typeof fetch;
  logger?: (level: "info" | "warn" | "error", message: string, meta?: unknown) => void;
}

export interface UpstreamAdapter {
  readonly type: string;

  /**
   * 该上游的邮箱操作是否依赖「每邮箱独立凭证」（MailboxRef.credentials / password）。
   * true 时网关记录一旦删除，上游那个邮箱就永久不可读、也无法再重试删除
   * （例如 DuckMail：密码建箱时随机生成、只存在网关库里；token 过期可用这份密码再换，
   * 但删掉记录就连密码也没了，事后无法再换 token）。
   * 因此尽力删除（?force=1）对这类上游会被拒绝，避免制造不可回收的孤儿。
   * 缺省 false：账号级凭证的上游（cf-temp-email / MoeMail / YYDS）删记录不影响上游可达性。
   */
  readonly requiresMailboxCredentials?: boolean;

  listDomains(cfg: UpstreamConfig): Promise<DomainInfo[]>;

  createMailbox(cfg: UpstreamConfig, req: CreateMailboxRequest): Promise<MailboxRef>;

  /**
   * 按地址反查上游已存在的邮箱，返回网关登记所需的 MailboxRef（可选能力）。
   * 用于「纳管」：把上游早已存在、但网关注册表里没有的邮箱补登记进来
   * （典型场景是客户端从直连模式切到走网关，存量邮箱否则读不到）。
   *
   * 只有账号级凭证的上游能实现——同一套凭证就能读任意地址。
   * 依赖每邮箱独立凭证的上游（DuckMail：密码建箱时随机生成）实现不了，
   * 不提供该方法即表示不支持，网关返回 501。
   * 上游确实没有这个地址时抛 UpstreamError("NOT_FOUND")。
   */
  resolveByAddress?(cfg: UpstreamConfig, address: string): Promise<MailboxRef>;

  deleteMailbox(cfg: UpstreamConfig, ref: MailboxRef): Promise<void>;

  listMessages(
    cfg: UpstreamConfig,
    ref: MailboxRef,
    opts?: ListMessagesOptions,
  ): Promise<MessageSummary[]>;

  getMessage(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<MessageDetail>;

  deleteMessage?(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<void>;

  /** 原始报文（含附件），附件代理依赖；可选能力 */
  getSource?(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<Uint8Array>;

  /**
   * 原生格式透传（/upstream/{upstreamId}/**）时注入的鉴权头。
   * 未实现该方法的适配器类型不支持透传（网关返回 501）。
   * 例如 MoeMail："X-API-Key"；cloudflare_temp_email 管理端："x-admin-auth"。
   * cfg.apiKey 已解密。
   */
  authHeaders?(cfg: UpstreamConfig): Record<string, string>;

  /** 从原生删除路径提取所属邮箱 ID；不含邮箱 ID 的路径返回 null。 */
  passthroughMailboxId?(path: string): string | null;

  /**
   * 透传副作用观察：识别"经透传创建/删除了邮箱"的请求，让网关自动登记/注销，
   * 使原生客户端创建的邮箱在管理端可见、可管理。
   * input 提供 2xx JSON 响应或 DELETE 204 的 method/子路径/请求体/响应体（原文）。
   * 无法识别时返回 null（如 cf-temp_email 的删除接口只含上游内部记录 ID，无法映射）。
   */
  inspectPassthrough?(input: PassthroughInspectInput): PassthroughObservation | null;

  /**
   * 透传列表过滤（可选能力）：GET 命中"枚举型"端点（列出邮箱 / 列出可用域名）
   * 时，网关按调用方可用域名（启用域名 ∩ key 域名白名单 ∩ key 渠道白名单）
   * 过滤响应条目，让原生客户端"看到的邮箱/域名"与"能创建的域名"保持一致。
   * 实现识别自己熟悉的端点与响应形状，返回改写后的响应体文本；
   * 返回 null 表示该端点不在此能力范围内（body 原样返回）。
   */
  filterPassthroughList?(input: {
    path: string;
    responseBodyText: string;
    isDomainAllowed: (domain: string) => boolean;
  }): string | null;
}

/** 透传副作用观察的输入（2xx JSON 的 POST/DELETE，以及无响应体的 DELETE 204） */
export interface PassthroughInspectInput {
  method: string;
  /** /upstream/{id} 之后的子路径，如 /api/emails/generate */
  path: string;
  status: number;
  requestBodyText?: string;
  responseBodyText?: string;
}

export type PassthroughObservation =
  | { action: "created"; ref: MailboxRef }
  | { action: "deleted"; upstreamMailboxId: string };

/** 注册表条目的展示元数据，供管理端表单使用 */
export interface AdapterMeta {
  type: string;
  displayName: string;
  description: string;
  capabilities: {
    deleteMessage: boolean;
    getSource: boolean;
  };
}
