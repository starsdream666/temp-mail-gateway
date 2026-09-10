/// <reference types="@cloudflare/workers-types" />
import { drizzle } from "drizzle-orm/d1";
import { createWebCryptoCipher } from "../adapters/crypto/webcrypto";
import { createDrizzleStores } from "../adapters/stores/drizzle";
import { buildDeps } from "../bootstrap";
import { createApp, type GatewayDeps, type SpaAssets } from "../core/app";
import { RateLimiter } from "../core/ratelimit";
import { runHealthSweep, type MonitorDeps } from "../core/monitor";
import { LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS } from "../api/admin";
import { readSettings } from "../core/settings";

interface WorkerEnv {
  DB: D1Database;
  /** wrangler.toml [assets] binding：托管 frontend/dist */
  ASSETS?: Fetcher;
  MASTER_KEY?: string;
  ADMIN_PASSWORD?: string;
  MAX_CONCURRENT_REQUESTS_PER_KEY?: string;
  ADMIN_CORS_ORIGIN?: string;
  MAILBOXES_PER_KEY_PER_HOUR?: string;
  HEALTH_CHECK_INTERVAL_MS?: string;
}

/**
 * app 与限流器都在模块作用域缓存：Workers isolate 会复用模块作用域。
 * 若在 fetch 内重建 app，两个限流器的计数桶每请求归零——建箱限流与管理登录
 * 防爆破会完全失效，且每请求白烧 CPU 重建 30 条路由与全部 zod schema。
 * env 相关配置全部参与缓存签名，换 secret/变量后下一次请求自动重建。
 */
interface CachedBuild {
  signature: string;
  deps: GatewayDeps;
  app: ReturnType<typeof createApp>;
}

let cached: CachedBuild | undefined;

function build(env: WorkerEnv): CachedBuild | undefined {
  const masterKey = env.MASTER_KEY;
  const adminPassword = env.ADMIN_PASSWORD;
  if (!masterKey || !adminPassword) return undefined;

  const mailboxesPerKeyPerHour = env.MAILBOXES_PER_KEY_PER_HOUR
    ? Number(env.MAILBOXES_PER_KEY_PER_HOUR)
    : undefined;
  const globalIntervalMs = env.HEALTH_CHECK_INTERVAL_MS
    ? Math.max(60_000, Number(env.HEALTH_CHECK_INTERVAL_MS))
    : undefined;
  const signature = [
    masterKey,
    adminPassword,
    env.MAX_CONCURRENT_REQUESTS_PER_KEY ?? "",
    env.ADMIN_CORS_ORIGIN ?? "",
    String(mailboxesPerKeyPerHour ?? ""),
    String(globalIntervalMs ?? ""),
  ].join("\u0000");
  if (cached?.signature === signature) return cached;

  const assets: SpaAssets | undefined = env.ASSETS
    ? {
        indexHtml: async (c) => {
          const url = new URL(c.req.url);
          url.pathname = "/index.html";
          const res = await env.ASSETS!.fetch(new Request(url, { headers: c.req.raw.headers }));
          return new Response(res.body, {
            status: res.status,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        },
      }
    : undefined;

  const deps = buildDeps({
    stores: createDrizzleStores(drizzle(env.DB) as never),
    crypto: createWebCryptoCipher(masterKey),
    config: {
      adminPassword,
      maxConcurrentRequestsPerKey: env.MAX_CONCURRENT_REQUESTS_PER_KEY ? Number(env.MAX_CONCURRENT_REQUESTS_PER_KEY) : undefined,
      masterKey,
      adminCorsOrigin: env.ADMIN_CORS_ORIGIN,
      mailboxesPerKeyPerHour,
      healthCheckIntervalMs: globalIntervalMs,
    },
    // 限流器由模块作用域持有（经 deps 注入），与 app 实例生命周期一致
    limiters: {
      mailboxes: new RateLimiter(mailboxesPerKeyPerHour ?? 60),
      login: new RateLimiter(LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS),
    },
  });
  cached = { signature, deps, app: createApp({ ...deps, assets }) };
  return cached;
}

function monitorDepsOf(deps: GatewayDeps): MonitorDeps {
  return {
    upstreams: deps.stores.upstreams,
    health: deps.stores.health,
    registry: deps.registry,
    crypto: deps.crypto,
    getSettings: () => readSettings(deps.stores.settings, deps.config),
  };
}

/**
 * Cloudflare Workers 入口。
 * 静态资源由平台 assets 前置匹配；未命中的请求进入 Worker，
 * 非 API 路径再通过 ASSETS 绑定回退到 index.html（SPA 前端路由）。
 * 健康监控由 [triggers] 的 cron 触发 scheduled，与 fetch 共用同一份缓存 deps。
 */
export default {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    const built = build(env);
    if (!built) {
      return Response.json(
        { error: { code: "MISCONFIGURED", message: "缺少 MASTER_KEY / ADMIN_PASSWORD secret" } },
        { status: 500 },
      );
    }
    return built.app.fetch(req);
  },

  async scheduled(_event: ScheduledEvent, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    const built = build(env);
    if (!built) return;
    // 到期扫描：只探测超过自身有效间隔的渠道（渠道可用 settings.monitorIntervalMs 覆盖）
    ctx.waitUntil(
      runHealthSweep(monitorDepsOf(built.deps)).catch(() => {
        /* 巡检失败不影响下一次 cron */
      }),
    );
  },
};
