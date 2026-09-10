import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createWebCryptoCipher } from "../adapters/crypto/webcrypto";
import { createDrizzleStores } from "../adapters/stores/drizzle";
import { runMigrations } from "../db/migrate-node";
import { buildDeps } from "../bootstrap";
import { createApp, type SpaAssets } from "../core/app";
import { runHealthSweep, HEALTH_SWEEP_INTERVAL_MS } from "../core/monitor";
import { readSettings } from "../core/settings";

/**
 * 加载工作目录下的 .env（KEY=VALUE 每行一条，# 开头为注释）。
 * 只填充缺失项：真实环境变量优先于 .env，便于部署时覆盖。
 */
function loadDotEnv(): void {
  const envPath = resolve(".env");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

/**
 * Node / Docker 入口。
 * 配置来源：环境变量或 .env 文件 ——
 *   MASTER_KEY、ADMIN_PASSWORD（必填）、DATABASE_PATH（默认 ./data/gateway.db）、
 *   ADMIN_CORS_ORIGIN、PORT（默认 8787）、MAILBOXES_PER_KEY_PER_HOUR、
 *   FRONTEND_DIST（默认 ./frontend/dist，存在则托管管理后台 SPA）
 */
const masterKey = process.env.MASTER_KEY;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!masterKey || !adminPassword) {
  console.error("缺少环境变量 MASTER_KEY / ADMIN_PASSWORD（本地开发可用 MASTER_KEY=dev ADMIN_PASSWORD=dev npm run dev）");
  process.exit(1);
}

const dbPath = resolve(process.env.DATABASE_PATH ?? "./data/gateway.db");
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
runMigrations(sqlite, resolve("migrations"));

/** 前端构建产物存在则托管，否则退化为纯 API 服务 */
function resolveAssets(): SpaAssets | undefined {
  const distDir = resolve(process.env.FRONTEND_DIST ?? "./frontend/dist");
  const indexPath = join(distDir, "index.html");
  if (!existsSync(indexPath)) return undefined;

  const html = readFileSync(indexPath, "utf8");
  return {
    // serveStatic 的 root 需相对 process.cwd()
    middleware: serveStatic({ root: relativeToCwd(distDir) }),
    indexHtml: (c) => c.html(html),
  };
}

function relativeToCwd(absolute: string): string {
  const cwd = resolve(".");
  const rel = absolute.startsWith(cwd) ? absolute.slice(cwd.length).replace(/^[\\/]/, "") : absolute;
  return (rel || ".").split("\\").join("/");
}

const assets = resolveAssets();

const gatewayDeps = buildDeps({
  stores: createDrizzleStores(drizzle(sqlite) as never),
  crypto: createWebCryptoCipher(masterKey),
  config: {
    adminPassword,
    maxConcurrentRequestsPerKey: process.env.MAX_CONCURRENT_REQUESTS_PER_KEY ? Number(process.env.MAX_CONCURRENT_REQUESTS_PER_KEY) : undefined,
    masterKey,
    adminCorsOrigin: process.env.ADMIN_CORS_ORIGIN,
    mailboxesPerKeyPerHour: process.env.MAILBOXES_PER_KEY_PER_HOUR
      ? Number(process.env.MAILBOXES_PER_KEY_PER_HOUR)
      : undefined,
    healthCheckIntervalMs: process.env.HEALTH_CHECK_INTERVAL_MS
      ? Number(process.env.HEALTH_CHECK_INTERVAL_MS)
      : undefined,
  },
});

const app = createApp({ ...gatewayDeps, assets });

/**
 * 上游健康监控：每 60 秒扫描一次各渠道是否"到期"（渠道可用 settings.monitorIntervalMs
 * 单独覆盖测活频率，settings.monitorDisabled 关闭单渠道监控；全局默认
 * HEALTH_CHECK_INTERVAL_MS，默认 5 分钟）。结果写入 health_checks，状态监控页展示。
 * 渠道自动纳入；Workers 部署可改用 Cron Triggers 调用 runHealthSweep。
 */
const monitorDeps = {
  upstreams: gatewayDeps.stores.upstreams,
  health: gatewayDeps.stores.health,
  registry: gatewayDeps.registry,
  crypto: gatewayDeps.crypto,
  getSettings: () => readSettings(gatewayDeps.stores.settings, gatewayDeps.config),
};
let monitoring = false;
const runMonitorSweep = async () => {
  if (monitoring) return;
  monitoring = true;
  try {
    const results = await runHealthSweep(monitorDeps);
    const down = results.filter((r) => r.status === "down");
    const changes = results.filter((r) => r.domainsAdded.length > 0 || r.domainsRemoved.length > 0);
    if (down.length > 0) {
      console.warn(`[health] 存活检查：${down.length}/${results.length} 个渠道异常 —— ${down.map((d) => d.upstreamName).join(", ")}`);
    }
    if (changes.length > 0) {
      for (const ch of changes) {
        console.log(
          `[health] 渠道「${ch.upstreamName}」域名变化：+${ch.domainsAdded.length} / -${ch.domainsRemoved.length}`,
        );
      }
    }
  } catch (err) {
    console.error("[health] 健康检查执行失败:", (err as Error).message);
  } finally {
    monitoring = false;
  }
};
setTimeout(() => void runMonitorSweep(), 10_000);
setInterval(() => void runMonitorSweep(), HEALTH_SWEEP_INTERVAL_MS);

/**
 * WAL 定期收缩：健康检查高频写入会让 -wal 文件持续增长（prune 只删行不缩文件）。
 * 借巡检节奏每 6 小时做一次 TRUNCATE checkpoint，把 WAL 归还给操作系统。
 */
const WAL_CHECKPOINT_INTERVAL_MS = 6 * 3600_000;
let lastCheckpoint = Date.now();
setInterval(() => {
  if (Date.now() - lastCheckpoint < WAL_CHECKPOINT_INTERVAL_MS) return;
  lastCheckpoint = Date.now();
  try {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
  } catch (err) {
    console.warn("[db] WAL checkpoint 失败:", (err as Error).message);
  }
}, HEALTH_SWEEP_INTERVAL_MS);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`temp-mail-gateway listening on http://localhost:${info.port}`);
  console.log(
    assets
      ? `管理后台: http://localhost:${info.port}/`
      : "未发现前端构建产物（frontend/dist），当前为纯 API 模式；执行 npm run frontend:build 后重启即可托管管理后台",
  );
  console.log(`OpenAPI 文档: http://localhost:${info.port}/api/doc  Swagger UI: http://localhost:${info.port}/api/ui`);
});
