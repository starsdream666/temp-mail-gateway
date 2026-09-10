import { UpstreamError, type UpstreamConfig } from "../../../ports/upstream";

/**
 * 真实上游适配器的共享 HTTP 工具。
 * 把「上游 HTTP 失败 → UpstreamError」的映射与通用小逻辑收敛在一处。
 */

export interface UpstreamHttpDeps {
  fetchFn: typeof fetch;
  logger?: (level: "info" | "warn" | "error", message: string, meta?: unknown) => void;
}

export function requireApiKey(cfg: UpstreamConfig, label: string): string {
  const key = cfg.apiKey?.trim();
  if (!key) {
    throw new UpstreamError("AUTH_FAILED", cfg.id, { message: `该上游未配置 ${label}（管理端 key）` });
  }
  return key;
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** 上游调用失败 → UpstreamError 的统一映射 */
export function upstreamHttpError(
  cfg: UpstreamConfig,
  status: number,
  bodyText: string,
  endpoint: string,
): UpstreamError {
  const hint = bodyText.slice(0, 300);
  const message = `上游 ${endpoint} 返回 ${status}${hint ? `：${hint}` : ""}`;
  const code =
    status === 401 || status === 403 ? "AUTH_FAILED"
    : status === 429 ? "RATE_LIMITED"
    : status === 404 ? "NOT_FOUND"
    : status === 400 || status === 409 || status === 422 ? "BAD_REQUEST"
    : status >= 500 ? "UNAVAILABLE"
    : "UNKNOWN";
  return new UpstreamError(code as never, cfg.id, {
    message,
    retryable: status === 429 || status >= 500,
  });
}

export function networkError(cfg: UpstreamConfig, endpoint: string, cause: unknown): UpstreamError {
  return new UpstreamError("UNAVAILABLE", cfg.id, {
    message: `上游 ${endpoint} 网络请求失败：${(cause as Error)?.message ?? String(cause)}`,
    retryable: true,
    cause,
  });
}

/** GET JSON；非 2xx 抛 UpstreamError */
export async function upstreamGetJson<T>(
  deps: UpstreamHttpDeps,
  cfg: UpstreamConfig,
  url: string,
  headers: Record<string, string>,
  endpoint: string,
): Promise<T> {
  let res: Response;
  try {
    res = await deps.fetchFn(url, { method: "GET", headers });
  } catch (cause) {
    throw networkError(cfg, endpoint, cause);
  }
  if (!res.ok) {
    throw upstreamHttpError(cfg, res.status, await safeText(res), `${endpoint} GET`);
  }
  return (await res.json()) as T;
}

export async function upstreamSend(
  deps: UpstreamHttpDeps,
  cfg: UpstreamConfig,
  url: string,
  method: "POST" | "DELETE",
  headers: Record<string, string>,
  body?: unknown,
  endpoint = "",
): Promise<Response> {
  let res: Response;
  try {
    res = await deps.fetchFn(url, {
      method,
      headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw networkError(cfg, endpoint || `${method} ${url}`, cause);
  }
  if (!res.ok) {
    throw upstreamHttpError(cfg, res.status, await safeText(res), `${endpoint} ${method}`);
  }
  return res;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * 增量游标过滤：items 需按时间升序；返回 since（含）之后的消息。
 * since 不在列表中（已被上游清理等）时保守返回全部。
 */
export function filterAfterCursor<T extends { id: string }>(items: T[], since?: string): T[] {
  if (!since) return items;
  const idx = items.findIndex((m) => m.id === since);
  return idx >= 0 ? items.slice(idx + 1) : items;
}

let localPartSeq = 0;

/** 未指定 localPart 时的本地部分生成器：小写字母数字，天然合法 */
export function randomLocalPart(): string {
  localPartSeq += 1;
  const rand = Math.floor(Math.random() * 36 ** 6).toString(36);
  return `u${Date.now().toString(36)}${rand}${localPartSeq.toString(36)}`.slice(0, 32);
}

/** 宽容解析上游时间：ISO 字符串 / 毫秒 / 秒 epoch */
export function parseUpstreamDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    // < 10^12 视为秒级 epoch
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}
