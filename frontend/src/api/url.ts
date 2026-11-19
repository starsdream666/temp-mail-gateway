/** 同域、独立后端和带路径前缀的反向代理使用同一套地址解析。 */
export function resolveApiBaseUrl(configured: string, origin: string): string {
  const base = configured.trim().replace(/\/+$/, '');
  return base ? new URL(base, `${origin}/`).href.replace(/\/+$/, '') : origin;
}

export function getApiBaseUrl(): string {
  const origin = typeof window === 'undefined' ? 'http://localhost:8787' : window.location.origin;
  return resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL || '', origin);
}
