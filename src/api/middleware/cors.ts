import type { Context, Next } from "hono";

/**
 * 轻量 CORS：仅当配置了 ADMIN_CORS_ORIGIN 时生效。
 * 支持逗号分隔的多个来源与 "*"。前端走同域部署或 dev proxy 时不需要配置。
 *
 * 凭证语义（安全约束）：
 * - 显式来源 → 回显 Origin 并允许携带凭证（跨域管理后台 SPA 的合法部署形态）；
 * - "*" → 回显 Origin 但**不带** Access-Control-Allow-Credentials（Bearer key 的
 *   /v1、/upstream 客户端不受影响），且会话 cookie 不降级为 SameSite=None
 *   （见 corsCrossOrigin）——任意站点都无法携带/读取管理员凭证，防 CSRF。
 *   因此 `*` 仅供非 cookie 客户端调试；跨域管理后台必须写明确切来源。
 */
export function corsMiddleware(allowedOrigins: string | undefined) {
  const origins = parseCorsOrigins(allowedOrigins);
  const wildcard = origins.includes("*");

  const applyHeaders = (c: Context): void => {
    const origin = c.req.header("Origin");
    if (!origin || origins.length === 0) return;
    const match = wildcard || origins.includes(origin);
    if (!match) return;
    c.header("Access-Control-Allow-Origin", origin);
    if (!wildcard) {
      // 只有显式来源才允许携带凭证；通配符配合凭证 = 任意站点可驱动管理 API
      c.header("Access-Control-Allow-Credentials", "true");
    }
    c.header("Vary", "Origin");
  };

  return async (c: Context, next: Next) => {
    applyHeaders(c);
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      // 网关 key 支持的全部自定义鉴权头都要进预检白名单（extractGatewayKey 支持它们）
      c.header(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, X-API-Key, X-Gateway-Key, X-Admin-Auth",
      );
      c.header("Access-Control-Max-Age", "86400");
      return c.body(null, 204);
    }
    await next();
    applyHeaders(c);
  };
}

/** 解析 ADMIN_CORS_ORIGIN 配置为来源列表（逗号分隔，"*" 表示通配） */
export function parseCorsOrigins(config: string | undefined): string[] {
  return config ? config.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * 会话 cookie 是否需要跨域形态（SameSite=None + Secure）。
 * 仅在配置了**显式**来源时成立；通配符 "*" 不成立——否则任意站点的请求都会
 * 携带管理员会话 cookie，叠加 Origin 回显即构成完整的 CSRF 面。
 */
export function corsCrossOrigin(config: string | undefined): boolean {
  const origins = parseCorsOrigins(config);
  return origins.length > 0 && !origins.includes("*");
}
