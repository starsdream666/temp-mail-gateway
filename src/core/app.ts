import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import type { Context, MiddlewareHandler } from "hono";
import type { CryptoPort } from "../ports/crypto";
import type { AdapterRegistry } from "../adapters/registry";
import { RateLimiter } from "./ratelimit";
import { corsMiddleware, corsCrossOrigin } from "../api/middleware/cors";
import { errorHandler } from "../api/middleware/error";
import { registerV1Routes } from "../api/v1";
import { registerAdminRoutes } from "../api/admin";
import { registerPassthroughRoutes } from "../api/passthrough";
import type { Env } from "../api/env";
import { readSettings } from "./settings";
import { ConcurrencyLimiter } from "./concurrency";

/**
 * 前端 SPA 托管接入点。两种运行时的差异全部收敛在这里：
 *   Node    → middleware 为 @hono/node-server 的 serveStatic
 *   Workers → 静态资源由平台 assets 前置处理，只需提供 indexHtml 回退
 */
export interface SpaAssets {
  /** 静态文件中间件；命中则直接返回文件，未命中调 next() 交给 API 路由 */
  middleware?: MiddlewareHandler;
  /** SPA 回退：任何非 API 的未匹配路径都返回 index.html，交给前端路由 */
  indexHtml: (c: Context) => Response | Promise<Response>;
}

/** API 命名空间：这些前缀下的 404 返回 JSON 错误信封，不做 SPA 回退 */
const API_PREFIXES = ["/v1", "/admin", "/api"];

function isApiPath(path: string): boolean {
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export interface GatewayConfig {
  adminPassword: string;
  maxConcurrentRequestsPerKey?: number;
  masterKey: string;
  /** 前端 SPA 来源（逗号分隔或 *）；不配置则无 CORS 头（同域/代理部署） */
  adminCorsOrigin?: string;
  /** 网关 key 每小时邮箱创建请求上限的默认值；key 可单独覆盖，0 = 不限 */
  mailboxesPerKeyPerHour?: number;
  /** 上游健康监控的全局默认测活间隔（毫秒）；渠道可在 settings.monitorIntervalMs 单独覆盖 */
  healthCheckIntervalMs?: number;
}

export interface GatewayDeps {
  stores: {
    upstreams: import("../ports/stores").UpstreamStore;
    mailboxes: import("../ports/stores").MailboxStore;
    apiKeys: import("../ports/stores").ApiKeyStore;
    health: import("../ports/stores").HealthStore;
    orphans: import("../ports/stores").OrphanStore;
    settings: import("../ports/stores").SettingsStore;
  };
  registry: AdapterRegistry;
  crypto: CryptoPort;
  config: GatewayConfig;
  /** 托管管理后台 SPA；缺省则只提供 API（`/` 返回服务信息 JSON） */
  assets?: SpaAssets;
  /** 出网 fetch（透传与适配器共用）；缺省用全局 fetch，测试可注入模拟实现 */
  fetchFn?: typeof fetch;
  /**
   * 限流器注入点（建箱限流 + 管理登录防爆破）。缺省在 createApp 内新建——
   * 这要求 createApp 每运行时进程/隔离实例只调一次；Workers 入口必须在模块
   * 作用域持有 app 与限流器并传入本项，否则每请求重建后限流计数桶清零、完全失效。
   */
  limiters?: { mailboxes: RateLimiter; login: RateLimiter };
}

/**
 * 运行时无关的应用组装入口。worker.ts / node.ts 只负责注入具体实现后调用本函数。
 * 请求校验失败（zod）统一抛 ZodError，由 onError 转为错误信封。
 */
export function createApp(deps: GatewayDeps) {
  const app = new OpenAPIHono<Env>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });

  const rateLimiter = deps.limiters?.mailboxes ?? new RateLimiter(deps.config.mailboxesPerKeyPerHour ?? 60);
  const concurrencyLimiter = new ConcurrencyLimiter();

  app.use("*", corsMiddleware(deps.config.adminCorsOrigin));

  // 静态资源中间件放在 API 路由之前：命中文件直接返回，未命中 next() 落到 API
  if (deps.assets?.middleware) {
    app.use("*", deps.assets.middleware);
  }

  for (const path of ["/admin/*", "/v1/*", "/upstream/*"]) {
    app.use(path, async (c, next) => {
      c.set("settings", await readSettings(deps.stores.settings, deps.config));
      if (c.req.path.startsWith("/admin/")) c.header("Cache-Control", "no-store");
      await next();
    });
  }

  const info = { name: "temp-mail-gateway", version: "0.2.4", docs: "/api/doc", ui: "/api/ui" };
  app.get("/api/info", (c) => c.json(info));
  // 托管 SPA 时根路径交给前端；纯 API 部署时返回服务信息
  if (deps.assets) {
    app.get("/", (c) => deps.assets!.indexHtml(c));
  } else {
    app.get("/", (c) => c.json(info));
  }

  registerV1Routes(app, {
    stores: deps.stores,
    registry: deps.registry,
    crypto: deps.crypto,
    rateLimiter,
    concurrencyLimiter,
  });

  registerAdminRoutes(app, {
    stores: deps.stores,
    registry: deps.registry,
    crypto: deps.crypto,
    loginLimiter: deps.limiters?.login,
    config: deps.config,
    admin: {
      adminPassword: deps.config.adminPassword,
      masterKey: deps.config.masterKey,
      // "*" 只服务非 cookie 的调试场景：会话 cookie 保持 SameSite=Lax，防止任意站点驱动管理 API
      crossOrigin: corsCrossOrigin(deps.config.adminCorsOrigin),
    },
  });

  registerPassthroughRoutes(app, {
    stores: deps.stores,
    registry: deps.registry,
    crypto: deps.crypto,
    fetchFn: deps.fetchFn,
    concurrencyLimiter,
    admin: {
      adminPassword: deps.config.adminPassword,
      masterKey: deps.config.masterKey,
      crossOrigin: corsCrossOrigin(deps.config.adminCorsOrigin),
    },
  });

  app.onError(errorHandler);

  app.doc31("/api/doc", {
    openapi: "3.1.0",
    info: { title: "Temp Mail Gateway", version: info.version, description: "临时邮箱聚合网关" },
  });
  app.get("/api/ui", swaggerUI({ url: "/api/doc" }));

  // 未匹配路径：API 命名空间给 JSON 错误信封，其余交给 SPA 前端路由
  app.notFound((c) => {
    if (deps.assets && !isApiPath(c.req.path)) {
      return deps.assets.indexHtml(c);
    }
    return c.json({ error: { code: "NOT_FOUND", message: `未知路径: ${c.req.path}` } }, 404);
  });

  return app;
}
