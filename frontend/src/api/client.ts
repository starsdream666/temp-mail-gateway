import {
  ApiError,
  AdapterTypeInfo,
  UpstreamSummary,
  UpstreamDetail,
  UpstreamDomain,
  CreateUpstreamPayload,
  UpdateUpstreamPayload,
  SyncDomainsResult,
  ApiKeyInfo,
  CreatedApiKey,
  UpdateApiKeyPayload,
  AdminDomainInfo,
  MailboxesResponse,
  ImportMailboxesResult,
  OrphanEntry,
  HealthChannel,
  GlobalSettings,
  UpdateGlobalSettingsPayload,
} from '../types';

const rawBaseUrl = import.meta.env.VITE_API_BASE_URL || '';
const API_BASE_URL = rawBaseUrl.replace(/\/+$/, '');

let unauthorizedListener: (() => void) | null = null;

export function setUnauthorizedListener(listener: (() => void) | null) {
  unauthorizedListener = listener;
}

export async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const headers = new Headers(options.headers);

  if (options.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const config: RequestInit = {
    ...options,
    headers,
    credentials: 'include',
  };

  let response: Response;
  try {
    response = await fetch(url, config);
  } catch (networkError) {
    throw new ApiError(0, {
      code: 'NETWORK_ERROR',
      message: '网络连接失败，请检查网络或后端服务状态',
      details: networkError,
    });
  }

  // 401 统一处理：会话失效。
  // 例外：POST /admin/session 的 401 是「密码错误」（登录被拒），不是会话过期——
  // 触发监听器会把「登录被拒」误判成「会话失效」，页面表现与错误提示互相矛盾。
  const isLoginAttempt = response.status === 401 && endpoint === '/admin/session' && options.method !== 'DELETE';
  if (response.status === 401 && !isLoginAttempt) {
    if (unauthorizedListener) {
      unauthorizedListener();
    }
  }

  // 处理 204 无内容
  if (response.status === 204) {
    return undefined as unknown as T;
  }

  // 非 2xx 响应处理
  if (!response.ok) {
    let errorData: { error?: { code?: string; message?: string; details?: unknown } } | null = null;
    try {
      errorData = await response.json();
    } catch {
      // 无法解析 JSON
    }

    const code = errorData?.error?.code || `HTTP_${response.status}`;
    const message = errorData?.error?.message || response.statusText || '请求异常';
    const details = errorData?.error?.details;

    throw new ApiError(response.status, { code, message, details });
  }

  // 正常解析 JSON；空 body 的 2xx 按无内容处理（否则抛裸 SyntaxError，绕过 ApiError 分支）
  const text = await response.text();
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

// ==================== 公共信息 ====================

export interface ServiceInfo {
  name: string;
  version: string;
  docs: string;
  ui: string;
}

export async function getServiceInfo(): Promise<ServiceInfo> {
  return apiFetch<ServiceInfo>('/api/info', { cache: 'no-store' });
}

// ==================== 认证相关 ====================

export async function login(password: string): Promise<void> {
  await apiFetch<void>('/admin/session', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function logout(): Promise<void> {
  await apiFetch<void>('/admin/session', {
    method: 'DELETE',
  });
}

export async function checkMe(): Promise<{ authenticated: boolean }> {
  return await apiFetch<{ authenticated: boolean }>('/admin/me');
}

export async function getGlobalSettings(): Promise<GlobalSettings> {
  const res = await apiFetch<{ settings: GlobalSettings }>('/admin/settings');
  return res.settings;
}

export async function updateGlobalSettings(payload: UpdateGlobalSettingsPayload): Promise<{ settings: GlobalSettings; reauthenticationRequired: boolean }> {
  return apiFetch('/admin/settings', { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function getAdapterTypes(): Promise<AdapterTypeInfo[]> {
  const res = await apiFetch<{ types: AdapterTypeInfo[] }>('/admin/adapter-types');
  return res.types;
}

// ==================== 上游管理 ====================

export async function getUpstreams(): Promise<UpstreamSummary[]> {
  const res = await apiFetch<{ upstreams: UpstreamSummary[] }>('/admin/upstreams');
  return res.upstreams;
}

export async function getUpstream(id: string): Promise<UpstreamDetail> {
  const res = await apiFetch<{ upstream: UpstreamDetail }>(`/admin/upstreams/${encodeURIComponent(id)}`);
  return res.upstream;
}

export async function createUpstream(
  payload: CreateUpstreamPayload,
): Promise<{ upstream: UpstreamDetail; sync?: SyncDomainsResult }> {
  return await apiFetch<{ upstream: UpstreamDetail; sync?: SyncDomainsResult }>('/admin/upstreams', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateUpstream(
  id: string,
  payload: UpdateUpstreamPayload,
): Promise<UpstreamDetail> {
  const res = await apiFetch<{ upstream: UpstreamDetail }>(`/admin/upstreams/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  return res.upstream;
}

export async function deleteUpstream(id: string): Promise<void> {
  await apiFetch<void>(`/admin/upstreams/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function syncUpstreamDomains(id: string): Promise<SyncDomainsResult> {
  const res = await apiFetch<{ sync: SyncDomainsResult }>(`/admin/upstreams/${encodeURIComponent(id)}/sync-domains`, {
    method: 'POST',
  });
  return res.sync;
}

/** 开启/关闭某域名的调用（停用后统一 API 不再路由/列出该域名） */
export async function setDomainEnabled(
  id: string,
  domain: string,
  enabled: boolean,
): Promise<UpstreamDomain> {
  const res = await apiFetch<{ domain: UpstreamDomain }>(
    `/admin/upstreams/${encodeURIComponent(id)}/domains/${encodeURIComponent(domain)}`,
    { method: 'PUT', body: JSON.stringify({ enabled }) },
  );
  return res.domain;
}

/** 批量开启/关闭某渠道（上游实例）的全部域名调用（不同于停用上游实例：读信与透传 GET 不受影响） */
export async function setChannelDomainsEnabled(id: string, enabled: boolean): Promise<number> {
  const res = await apiFetch<{ upstreamId: string; enabled: boolean; affected: number }>(
    `/admin/upstreams/${encodeURIComponent(id)}/domains`,
    { method: 'PUT', body: JSON.stringify({ enabled }) },
  );
  return res.affected;
}

// ==================== API Key 管理 ====================

export async function getApiKeys(): Promise<ApiKeyInfo[]> {
  const res = await apiFetch<{ keys: ApiKeyInfo[] }>('/admin/keys');
  return res.keys;
}

export async function createApiKey(
  name: string,
  domains?: string[],
  channels?: string[],
  mailboxesPerHour?: number | null,
  maxConcurrentRequests?: number | null,
): Promise<CreatedApiKey> {
  const body: Record<string, unknown> = { name };
  if (domains && domains.length > 0) body.domains = domains;
  if (channels && channels.length > 0) body.channels = channels;
  if (mailboxesPerHour !== undefined) body.mailboxesPerHour = mailboxesPerHour;
  if (maxConcurrentRequests !== undefined) body.maxConcurrentRequests = maxConcurrentRequests;
  const res = await apiFetch<{ key: CreatedApiKey }>('/admin/keys', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.key;
}

export async function updateApiKey(id: string, payload: UpdateApiKeyPayload): Promise<ApiKeyInfo> {
  const res = await apiFetch<{ key: ApiKeyInfo }>(`/admin/keys/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  return res.key;
}

/** 全部域名（含停用与停用上游的），供 key 域名白名单编辑 */
export async function getAllDomains(): Promise<AdminDomainInfo[]> {
  const res = await apiFetch<{ domains: AdminDomainInfo[] }>('/admin/domains');
  return res.domains;
}

/** 取回 key 完整明文（加密存储；旧版本创建的 key 返回 409 无法取回） */
export async function revealApiKey(id: string): Promise<string> {
  const res = await apiFetch<{ key: string }>(`/admin/keys/${encodeURIComponent(id)}/reveal`, {
    method: 'POST',
  });
  return res.key;
}

export async function revokeApiKey(id: string): Promise<void> {
  await apiFetch<void>(`/admin/keys/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
  });
}

// ==================== 状态监控 ====================

export async function getHealthStatus(): Promise<HealthChannel[]> {
  const res = await apiFetch<{ channels: HealthChannel[] }>('/admin/health');
  return res.channels;
}

/** 立即执行一轮上游健康检查 */
export async function triggerHealthCheck(): Promise<void> {
  await apiFetch<{ results: unknown[] }>('/admin/health/check', { method: 'POST' });
}

/**
 * 配置渠道测活（intervalMs 传 null 跟随全局默认；disabled 关闭该渠道自动监控；
 * autoSyncDomains 传 false 时测活只检测域名增删、不写入注册表）
 */
export async function updateMonitorConfig(
  id: string,
  payload: { intervalMs?: number | null; disabled?: boolean; autoSyncDomains?: boolean },
): Promise<void> {
  await apiFetch(`/admin/upstreams/${encodeURIComponent(id)}/monitor`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

// ==================== 邮箱概览 ====================

export interface GetMailboxesParams {
  upstreamId?: string;
  limit?: number;
  offset?: number;
}

export async function getMailboxes(params: GetMailboxesParams = {}): Promise<MailboxesResponse> {
  const searchParams = new URLSearchParams();
  if (params.upstreamId) {
    searchParams.set('upstreamId', params.upstreamId);
  }
  if (params.limit !== undefined) {
    searchParams.set('limit', String(params.limit));
  }
  if (params.offset !== undefined) {
    searchParams.set('offset', String(params.offset));
  }

  const query = searchParams.toString();
  const endpoint = `/admin/mailboxes${query ? `?${query}` : ''}`;
  return await apiFetch<MailboxesResponse>(endpoint);
}

/**
 * 清理已过期的邮箱记录（只删网关侧记录，不触碰上游）。
 * 上游到期后自行回收邮箱，网关侧记录不会自动消失，长期累积会拖慢列表。
 */
export async function pruneExpiredMailboxes(): Promise<{ deleted: number }> {
  return await apiFetch<{ deleted: number }>('/admin/mailboxes/prune-expired', { method: 'POST' });
}

/**
 * 纳管上游已存在的邮箱地址（客户端从直连切到走网关时找回存量邮箱）。
 * apiKeyId 缺省 = 登记为共享邮箱（任何 key 可读、默认不进列表）。
 */
export async function importMailboxes(
  addresses: string[],
  apiKeyId?: string | null,
): Promise<ImportMailboxesResult> {
  return await apiFetch<ImportMailboxesResult>('/admin/mailboxes/import', {
    method: 'POST',
    body: JSON.stringify({ addresses, apiKeyId: apiKeyId || null }),
  });
}

/** 尽力删除留下的残留（网关记录已删、上游可能仍保留） */
export async function getOrphanMailboxes(): Promise<OrphanEntry[]> {
  const res = await apiFetch<{ orphans: OrphanEntry[] }>('/admin/orphan-mailboxes');
  return res.orphans;
}

/** 消账单条残留（不触碰上游） */
export async function dismissOrphanMailbox(id: string): Promise<void> {
  await apiFetch(`/admin/orphan-mailboxes/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 清空全部残留记录（不触碰上游） */
export async function clearOrphanMailboxes(): Promise<{ deleted: number }> {
  return await apiFetch<{ deleted: number }>('/admin/orphan-mailboxes', { method: 'DELETE' });
}
