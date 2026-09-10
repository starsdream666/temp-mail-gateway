import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { ApiKeyRow, ApiKeyStore } from "../../ports/stores";
import { AppError } from "../../core/errors";
import { hashApiKey, timingSafeEqualStr } from "../../core/keys";
import { sha256Hex } from "../../core/_webcompat";
import type { Env } from "../env";
import { verifyAdminPasswordHash } from "../../core/passwords";

export interface AdminAuthConfig {
  adminPassword: string;
  adminPasswordHash?: string | null;
  masterKey: string;
  /** 配置了跨域前端来源时，cookie 需 SameSite=None + Secure */
  crossOrigin: boolean;
}

const SESSION_COOKIE = "tmg_admin_session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export function currentAdminConfig(c: Context<Env>, config: AdminAuthConfig): AdminAuthConfig {
  const settings = c.get("settings");
  return settings ? { ...config, adminPasswordHash: settings.adminPasswordHash } : config;
}

export async function checkAdminPassword(password: string, config: AdminAuthConfig): Promise<boolean> {
  if (config.adminPasswordHash) return verifyAdminPasswordHash(password, config.adminPasswordHash);
  const [given, expected] = await Promise.all([sha256Hex(password), sha256Hex(config.adminPassword)]);
  return timingSafeEqualStr(given, expected);
}

/**
 * 从请求中提取网关 key，兼容多种请求头形式（主 API 与透传共用）：
 *   Authorization: Bearer <key> / Authorization: <key>（无 scheme 裸值）/
 *   X-API-Key / X-Admin-Auth / X-Gateway-Key
 */
export function extractGatewayKey(c: Context): string {
  const auth = (c.req.header("Authorization") ?? "").trim();
  if (auth) {
    const bearer = /^Bearer\s+(.+)$/i.exec(auth);
    return (bearer ? bearer[1]! : auth).trim();
  }
  for (const name of ["x-api-key", "x-admin-auth", "x-gateway-key"]) {
    const value = (c.req.header(name) ?? "").trim();
    if (value) return value;
  }
  return "";
}

/** /v1/* 鉴权：多种请求头形式携带网关 key */
export function requireApiKey(apiKeys: ApiKeyStore) {
  return async (c: Context, next: Next) => {
    const key = extractGatewayKey(c);
    if (!key) {
      throw new AppError(
        "UNAUTHORIZED",
        "缺少凭证：请以 Authorization: Bearer <key>、Authorization: <key>、X-API-Key、X-Admin-Auth 或 X-Gateway-Key 头携带网关 key",
      );
    }
    const row = await apiKeys.verify(await hashApiKey(key));
    if (!row) throw new AppError("UNAUTHORIZED", "无效的 API key");
    c.set("apiKey", row);
    await next();
  };
}

/**
 * /upstream/* 透传鉴权：兼容上述全部请求头形式；
 * 另接受管理员会话 cookie——原生客户端（如浏览器扩展）从同源浏览器发起、
 * 不会主动带网关 key 头（例如 cloudflare_temp_email 客户端探测公开端点
 * /open_api/settings 时一个 key 头都没有），管理员本人视同可信调用。
 * 客户端伪造的 x-admin-auth / X-API-Key 无效值走不通（仍需通过网关 key 校验），
 * 且这些头在转发前一律剥离重注，不会外泄到上游。
 */
export function requirePassthroughKey(apiKeys: ApiKeyStore, admin: AdminAuthConfig) {
  return async (c: Context, next: Next) => {
    const key = extractGatewayKey(c);
    if (key) {
      const row = await apiKeys.verify(await hashApiKey(key));
      if (row) {
        c.set("apiKey", row);
        await next();
        return;
      }
    }
    if (await isValidAdminSession(c, admin)) {
      c.set("apiKey", adminSessionRow());
      await next();
      return;
    }
    throw new AppError(
      "UNAUTHORIZED",
      "无效的 API key（支持 Authorization: Bearer / 裸值、X-API-Key、X-Admin-Auth、X-Gateway-Key 头，或管理员会话）",
    );
  };
}

/** 校验请求是否携带有效的管理员会话 cookie */
export async function isValidAdminSession(c: Context, config: AdminAuthConfig): Promise<boolean> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return false;
  return verifySessionToken(token, currentAdminConfig(c, config));
}

/** 管理员会话调透传时的虚拟调用方身份 */
function adminSessionRow(): ApiKeyRow {
  return {
    id: "admin-session",
    name: "管理员会话",
    keyHash: "",
    prefix: "admin",
    keyEnc: null,
    enabled: true,
    domains: null,
    channels: null,
    mailboxesPerHour: null,
    maxConcurrentRequests: null,
    lastUsedAt: new Date(),
    createdAt: new Date(),
  };
}

/** /admin/* 鉴权：签名 cookie 会话 */
export function requireAdmin(config: AdminAuthConfig) {
  return async (c: Context, next: Next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token || !(await verifySessionToken(token, currentAdminConfig(c, config)))) {
      throw new AppError("UNAUTHORIZED", "管理会话无效或已过期");
    }
    await next();
  };
}

/**
 * 会话签名密钥 = MASTER_KEY ⊕ ADMIN_PASSWORD 摘要。
 * 只用 MASTER_KEY 派生的话，密码泄露后改密码无法使旧 cookie 失效（token 内容仅有
 * expires，7 天 TTL 内依然可用）；掺入密码摘要后，修改 ADMIN_PASSWORD 即全量吊销。
 */
async function sessionSecret(config: AdminAuthConfig): Promise<string> {
  const passwordDigest = config.adminPasswordHash ?? await sha256Hex(config.adminPassword);
  // 尚未在后台改密时保持原会话兼容；修改密码摘要即吊销全部旧会话。
  return sha256Hex(`admin-session:${config.masterKey}:${passwordDigest}`);
}

async function createSessionToken(config: AdminAuthConfig): Promise<string> {
  const expires = String(Date.now() + SESSION_TTL_MS);
  const sig = await hmacHex(`${expires}`, await sessionSecret(config));
  return `${expires}.${sig}`;
}

async function verifySessionToken(token: string, config: AdminAuthConfig): Promise<boolean> {
  const [expires, sig] = token.split(".");
  if (!expires || !sig) return false;
  if (!Number.isSafeInteger(Number(expires)) || Number(expires) <= Date.now()) return false;
  const expected = await hmacHex(expires, await sessionSecret(config));
  return timingSafeEqualStr(sig, expected);
}

async function hmacHex(message: string, secretHexLike: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretHexLike),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 登录校验并种下会话 cookie */
export async function issueAdminSession(c: Context, password: string, config: AdminAuthConfig): Promise<boolean> {
  config = currentAdminConfig(c, config);
  const passwordOk = await checkAdminPassword(password, config);
  if (!passwordOk) return false;

  setCookie(c, SESSION_COOKIE, await createSessionToken(config), {
    httpOnly: true,
    path: "/",
    sameSite: config.crossOrigin ? "None" : "Lax",
    secure: config.crossOrigin,
    maxAge: SESSION_TTL_MS / 1000,
  });
  return true;
}

export function clearAdminSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
