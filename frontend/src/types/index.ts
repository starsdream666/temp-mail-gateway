export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message || `请求失败 (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload.code || 'UNKNOWN_ERROR';
    this.details = payload.details;
  }
}

export interface AdapterCapabilities {
  deleteMessage: boolean;
  getSource: boolean;
}

export interface AdapterTypeInfo {
  type: string;
  displayName: string;
  description: string;
  capabilities: AdapterCapabilities;
}

export interface UpstreamSummary {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  enabled: boolean;
  hasApiKey: boolean;
  domainCount: number;
  createdAt: string;
}

export interface UpstreamDomain {
  domain: string;
  isPrivate: boolean;
  /** 调用开关：停用后统一 API 不再路由/列出该域名 */
  enabled: boolean;
  syncedAt: string;
}

export interface UpstreamDetail extends UpstreamSummary {
  settings: Record<string, unknown>;
  domains: UpstreamDomain[];
}

export interface CreateUpstreamPayload {
  name: string;
  type: string;
  baseUrl: string;
  apiKey?: string;
  settings?: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpdateUpstreamPayload {
  name?: string;
  baseUrl?: string;
  apiKey?: string | null;
  settings?: Record<string, unknown>;
  enabled?: boolean;
}

export interface SyncDomainsResult {
  added: string[];
  removed: string[];
  total: number;
  warning?: string;
}

export interface GlobalSettings {
  mailboxCleanupEnabled: boolean;
  mailboxCleanupImmediate: boolean;
  mailboxCleanupIntervalMs: number;
  healthCheckEnabled: boolean;
  healthCheckIntervalMs: number;
  mailboxesPerKeyPerHour: number;
  maxConcurrentRequestsPerKey: number;
}

export type UpdateGlobalSettingsPayload = Partial<GlobalSettings> & {
  currentPassword?: string;
  newPassword?: string;
};

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  /** 域名白名单；null = 不限制（可调用全部启用域名） */
  domains: string[] | null;
  /** 渠道（上游实例）白名单；null = 不限渠道；与域名白名单同时生效取交集 */
  channels: string[] | null;
  /** 每小时邮箱创建请求上限；null = 系统默认，0 = 不限 */
  mailboxesPerHour: number | null;
  maxConcurrentRequests: number | null;
  effectiveMaxConcurrentRequests: number;
  /** 包含系统默认值的实际生效上限；0 = 不限 */
  effectiveMailboxesPerHour: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey extends ApiKeyInfo {
  key: string;
}

/** 更新 key（PATCH /admin/keys/:id）：domains/channels 传 null 清除限制 */
export interface UpdateApiKeyPayload {
  name?: string;
  enabled?: boolean;
  domains?: string[] | null;
  channels?: string[] | null;
  /** null 恢复系统默认；0 不限；缺省保持不变 */
  mailboxesPerHour?: number | null;
  maxConcurrentRequests?: number | null;
}

/** GET /admin/domains 返回的全量域名（key 域名编辑器候选 / 域名总览页） */
export interface AdminDomainInfo {
  domain: string;
  upstreamId: string;
  upstreamName: string;
  upstreamType: string;
  upstreamEnabled: boolean;
  isPrivate: boolean;
  enabled: boolean;
}

export interface Mailbox {
  id: string;
  address: string;
  localPart: string;
  domain: string;
  upstreamId: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface MailboxesResponse {
  total: number;
  mailboxes: Mailbox[];
}

/** 纳管结果：逐地址独立结算，部分失败不影响其余地址 */
export interface ImportMailboxesResult {
  imported: { address: string; id: string; upstreamId: string }[];
  failed: { address: string; code: string; message: string }[];
}

/** 尽力删除留下的残留：网关记录已删、上游可能仍保留该邮箱 */
export interface OrphanEntry {
  id: string;
  upstreamId: string;
  upstreamName: string;
  address: string;
  upstreamMailboxId: string;
  errorCode: string | null;
  error: string | null;
  detectedAt: string;
}

export interface AuthState {
  authenticated: boolean;
  checking: boolean;
}

/** 上游健康检查单点（状态监控时间线上的一根条） */
export interface HealthCheckPoint {
  checkedAt: string;
  status: 'up' | 'down';
  latencyMs: number | null;
}

/** 状态监控页的渠道卡片数据 */
export interface HealthChannel {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  status: 'up' | 'down' | 'unknown';
  lastCheckedAt: string | null;
  latencyMs: number | null;
  domainCount: number;
  uptimePct: number | null;
  /** 渠道独立测活间隔（毫秒）；null = 跟随全局默认 */
  monitorIntervalMs: number | null;
  /** 该渠道已关闭自动监控 */
  monitorDisabled: boolean;
  /** 实际生效的测活间隔（毫秒）；关闭监控时为 null */
  effectiveIntervalMs: number | null;
  /** 测活检测到域名增删时是否自动同步进注册表（缺省开启） */
  autoSyncDomains: boolean;
  domainChange: {
    checkedAt: string;
    added: string[];
    removed: string[];
    /** applied 已自动同步 / detected 仅检测 / blocked:<原因> 触发安全闸未应用 */
    syncAction: string | null;
  } | null;
  /** 安全闸拦下、等待人工确认的同步（点一次手动同步即可应用） */
  pendingSync: { checkedAt: string; reason: string; added: string[]; removed: string[] } | null;
  lastError: string | null;
  timeline: HealthCheckPoint[];
}
