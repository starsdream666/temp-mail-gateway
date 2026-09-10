/**
 * 存储抽象接口。实现位于 src/adapters/stores/。
 * 所有时间戳用 Date；敏感字段在实现层负责加解密（传入已加密列名的原始值）。
 */

export interface UpstreamRow {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  /** AES-GCM 密文（base64），无 key 的上游为 null */
  apiKeyEnc: string | null;
  settingsJson: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
}

export interface NewUpstream {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  apiKeyEnc: string | null;
  settingsJson: Record<string, unknown>;
  enabled?: boolean;
}

export interface DomainRow {
  domain: string;
  upstreamId: string;
  isPrivate: boolean;
  /** 管理端开关：停用后统一 API 不路由/不列出该域名 */
  enabled: boolean;
  syncedAt: Date;
}

export interface UpstreamWithDomain extends UpstreamRow {
  domain: string;
  isPrivate: boolean;
  /** 该域名自身的启用状态（与上游实例 enabled 独立） */
  domainEnabled: boolean;
}

export interface MailboxRow {
  id: string;
  upstreamId: string;
  address: string;
  localPart: string;
  domain: string;
  upstreamMailboxId: string;
  credentialsEnc: string | null;
  passwordEnc: string | null;
  apiKeyId: string | null;
  webhookUrl: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface NewMailbox {
  id: string;
  upstreamId: string;
  address: string;
  localPart: string;
  domain: string;
  upstreamMailboxId: string;
  credentialsEnc: string | null;
  passwordEnc: string | null;
  apiKeyId: string | null;
  expiresAt: Date | null;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  keyHash: string;
  prefix: string;
  /** 完整密钥明文的密文（AES-GCM base64）；旧版本创建的 key 为 null（明文不可找回） */
  keyEnc: string | null;
  enabled: boolean;
  /** 域名白名单（小写域名）；null = 不限制 */
  domains: string[] | null;
  /** 渠道（上游实例）白名单（upstream id）；null = 不限渠道；与域名白名单同时生效取交集 */
  channels: string[] | null;
  /** 每小时邮箱创建请求上限；null = 继承系统默认，0 = 不限 */
  mailboxesPerHour: number | null;
  maxConcurrentRequests: number | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface UpstreamStore {
  create(input: NewUpstream): Promise<UpstreamRow>;
  update(id: string, patch: Partial<Pick<UpstreamRow, "name" | "baseUrl" | "apiKeyEnc" | "settingsJson" | "enabled">>): Promise<void>;
  /** 有存活邮箱时抛 StoreError("UPSTREAM_IN_USE") */
  delete(id: string): Promise<void>;
  get(id: string): Promise<UpstreamRow | null>;
  list(): Promise<UpstreamRow[]>;
  /** 仅启用实例（供健康监控遍历） */
  listEnabled(): Promise<UpstreamRow[]>;

  /** 同步域名：差异化替换该上游的域名集合（已存在的域名保留 enabled 开关状态） */
  replaceDomains(upstreamId: string, domains: DomainRow[]): Promise<void>;
  /** 该上游的全部域名（无论启用与否），供管理端详情使用 */
  listDomainsByUpstream(upstreamId: string): Promise<DomainRow[]>;
  countDomains(upstreamId: string): Promise<number>;
  /**
   * 某域名的全部登记行（多渠道共享同一域名时的全部候选，按「上游创建时间升序、
   * id 升序」排序——最早创建者在最前，供选主逻辑取首元素）。
   * 返回行不过滤启用状态：上游/域名是否启用由调用方（routing 选主）判定。
   */
  listUpstreamsByDomain(domain: string): Promise<UpstreamWithDomain[]>;
  /** 查询某个渠道名下的单个域名行；不属于该渠道时返回 null */
  getDomain(upstreamId: string, domain: string): Promise<DomainRow | null>;
  /** 仅「启用上游 × 启用域名」的域名合集（供统一挑选与 /v1/domains 使用） */
  listActiveDomains(): Promise<UpstreamWithDomain[]>;
  /** 全部域名（含停用与停用上游的），供管理端 key 域名编辑器使用 */
  listAllDomains(): Promise<UpstreamWithDomain[]>;
  /** 开关某个域名的调用；域名不属于该上游时返回 false */
  setDomainEnabled(upstreamId: string, domain: string, enabled: boolean): Promise<boolean>;
  /** 批量开关某渠道（上游实例）的全部域名，返回受影响域名数 */
  setAllDomainsEnabled(upstreamId: string, enabled: boolean): Promise<number>;
  countMailboxes(upstreamId: string): Promise<number>;
}

export interface MailboxListFilter {
  upstreamId?: string;
  /**
   * 严格归属过滤：只返回该 key 创建的邮箱。
   * 注意与读取口径的区别——requireMailbox 允许任何 key 读 apiKeyId 为 null 的共享记录
   * （透传自动登记），但**列表默认不列出它们**，否则批量注册的邮箱会灌进普通客户端。
   */
  apiKeyId?: string;
  /** 与 apiKeyId 同用时，额外并入 apiKeyId 为 null 的共享记录（透传自动登记） */
  includeShared?: boolean;
  /** 缺省 true；传 false 时排除 expiresAt 早于 now 的记录 */
  includeExpired?: boolean;
  /** 过期判定基准时间，缺省取调用时刻（便于测试注入） */
  now?: Date;
}

export interface MailboxStore {
  create(input: NewMailbox): Promise<MailboxRow>;
  get(id: string): Promise<MailboxRow | null>;
  findByAddress(address: string): Promise<MailboxRow | null>;
  /** 透传副作用注销用：定位某个上游实例下的指定邮箱 */
  findByUpstreamMailboxId(upstreamId: string, upstreamMailboxId: string): Promise<MailboxRow | null>;
  delete(id: string): Promise<void>;
  /** 按到期时间清理网关侧记录（不触碰上游），返回删除条数 */
  deleteExpired(before: Date): Promise<number>;
  list(opts?: MailboxListFilter & { limit?: number; offset?: number }): Promise<MailboxRow[]>;
  /** 总数；过滤条件与 list 一致（与分页列表同口径） */
  count(opts?: MailboxListFilter): Promise<number>;
}

export interface ApiKeyStore {
  create(input: {
    id: string;
    name: string;
    keyHash: string;
    prefix: string;
    /** 完整密钥明文的密文；null = 旧格式（明文不可找回） */
    keyEnc: string | null;
    /** 域名白名单；null = 不限制 */
    domains: string[] | null;
    /** 渠道白名单；null = 不限渠道 */
    channels: string[] | null;
    /** 每小时邮箱创建请求上限；缺省/null = 继承系统默认，0 = 不限 */
    mailboxesPerHour?: number | null;
    maxConcurrentRequests?: number | null;
  }): Promise<ApiKeyRow>;
  /** 按 hash 查找启用的 key；命中时顺带更新 lastUsedAt（尽力而为） */
  verify(keyHash: string): Promise<ApiKeyRow | null>;
  get(id: string): Promise<ApiKeyRow | null>;
  /** 吊销 = 直接删除（列表不再保留占位） */
  delete(id: string): Promise<void>;
  update(
    id: string,
    patch: Partial<Pick<ApiKeyRow, "name" | "enabled" | "domains" | "channels" | "mailboxesPerHour" | "maxConcurrentRequests">>,
  ): Promise<ApiKeyRow | null>;
  list(): Promise<ApiKeyRow[]>;
}

export interface HealthCheckRow {
  id: string;
  upstreamId: string;
  checkedAt: Date;
  status: "up" | "down";
  latencyMs: number | null;
  domainsTotal: number | null;
  domainsAdded: string[] | null;
  domainsRemoved: string[] | null;
  error: string | null;
  /**
   * 域名差异的处置：'applied' 已同步 / 'detected' 仅检测（渠道关闭了自动同步）/
   * 'blocked:<原因>' 触发安全闸未应用。无差异时为 null。
   */
  syncAction: string | null;
}

export interface NewHealthCheck {
  id: string;
  upstreamId: string;
  status: "up" | "down";
  latencyMs?: number | null;
  domainsTotal?: number | null;
  domainsAdded?: string[] | null;
  domainsRemoved?: string[] | null;
  error?: string | null;
  syncAction?: string | null;
}

export interface HealthStore {
  insert(check: NewHealthCheck): Promise<void>;
  /** 某渠道最近 N 条检查（按时间倒序），供状态监控页渲染时间线 */
  listByUpstream(upstreamId: string, limit: number): Promise<HealthCheckRow[]>;
  /** 每个渠道只保留最近 keep 条，防止无限增长 */
  prune(upstreamId: string, keep: number): Promise<void>;
  deleteByUpstream(upstreamId: string): Promise<void>;
}

export interface OrphanMailboxRow {
  id: string;
  upstreamId: string;
  upstreamName: string;
  address: string;
  upstreamMailboxId: string;
  errorCode: string | null;
  error: string | null;
  detectedAt: Date;
}

export interface NewOrphanMailbox {
  id: string;
  upstreamId: string;
  upstreamName: string;
  address: string;
  upstreamMailboxId: string;
  errorCode?: string | null;
  error?: string | null;
}

/**
 * 尽力删除的残留线索（网关记录已删、上游可能仍保留）。
 * 只做记录与人工消账，不做自动重试队列——个人自建规模下重试队列的复杂度不划算。
 */
export interface OrphanStore {
  insert(row: NewOrphanMailbox): Promise<void>;
  /** 最近 N 条（按发现时间倒序），供管理端提示 */
  list(limit: number): Promise<OrphanMailboxRow[]>;
  /** 手工清理完成后消账 */
  delete(id: string): Promise<void>;
  /** 全部消账，返回条数 */
  clear(): Promise<number>;
}

export interface StoredSettings {
  adminPasswordHash: string | null;
  healthCheckEnabled: boolean | null;
  healthCheckIntervalMs: number | null;
  mailboxesPerKeyPerHour: number | null;
  maxConcurrentRequestsPerKey: number | null;
}

export interface SettingsStore {
  get(): Promise<StoredSettings | null>;
  /** 单条语句按字段更新，避免并行保存不同设置时相互覆盖。 */
  update(patch: Partial<StoredSettings>): Promise<void>;
}

export class StoreError extends Error {
  constructor(readonly code: "UPSTREAM_IN_USE" | "NOT_FOUND" | "CONFLICT", message: string) {
    super(message);
    this.name = "StoreError";
  }
}
