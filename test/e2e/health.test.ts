import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { resolve } from "node:path";
import type { UpstreamAdapter, UpstreamConfig } from "../../src/ports/upstream";
import { UpstreamError } from "../../src/ports/upstream";
import { createDrizzleStores } from "../../src/adapters/stores/drizzle";
import { createWebCryptoCipher } from "../../src/adapters/crypto/webcrypto";
import { buildDeps } from "../../src/bootstrap";
import { createApp } from "../../src/core/app";
import { runHealthChecks, runHealthSweep } from "../../src/core/monitor";
import { runMigrations } from "../../src/db/migrate-node";
import { registerDummyAdapter } from "../helpers";

/**
 * 上游健康监控 e2e：存活探测、域名变化记录、状态查询端点、手动触发、级联清理。
 */

const ADMIN_PASSWORD = "health-admin-pw";
const MASTER_KEY = "health-master-key-0123456789";
const databases: Database.Database[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
});

// 可控失败的测试适配器
const flakyState = { shouldFail: false };
const flakyAdapter: UpstreamAdapter = {
  type: "flaky",
  listDomains: async (cfg: UpstreamConfig) => {
    if (flakyState.shouldFail) throw new UpstreamError("UNAVAILABLE", cfg.id, { message: "connection refused" });
    const domains = (cfg.settings.domains as string[] | undefined) ?? [];
    return domains.map((domain) => ({ domain }));
  },
  createMailbox: async () => ({ upstreamMailboxId: "x", address: "x@flaky.test" }),
  deleteMailbox: async () => {},
  listMessages: async () => [],
  getMessage: async () => {
    throw new Error("not implemented");
  },
};

function makeApp() {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  runMigrations(sqlite, resolve("migrations"));
  const deps = buildDeps({
    stores: createDrizzleStores(drizzle(sqlite) as never),
    crypto: createWebCryptoCipher(MASTER_KEY),
    config: { adminPassword: ADMIN_PASSWORD, masterKey: MASTER_KEY },
  });
  registerDummyAdapter(deps);
  const app = createApp(deps);
  return { app, deps };
}

describe("上游健康监控", () => {
  let app: ReturnType<typeof makeApp>["app"];
  let deps: ReturnType<typeof makeApp>["deps"];
  let cookie: string;
  let u1Id: string;
  let u2Id: string;

  beforeEach(async () => {
    flakyState.shouldFail = false;
    const ctx = makeApp();
    app = ctx.app;
    deps = ctx.deps;
    deps.registry.register(flakyAdapter, { displayName: "Flaky", description: "可控失败的测试适配器" });

    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const admin = async (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const a = await admin("POST", "/admin/upstreams", {
      name: "稳定渠道", type: "dummy", baseUrl: "memory://u1", settings: { domains: ["a.test", "b.test"] },
    });
    u1Id = ((await a.json()) as { upstream: { id: string } }).upstream.id;
    const b = await admin("POST", "/admin/upstreams", {
      name: "易碎渠道", type: "flaky", baseUrl: "memory://u2", settings: { domains: ["f.test"] },
    });
    u2Id = ((await b.json()) as { upstream: { id: string } }).upstream.id;
  });

  const monitorDeps = () => ({
    upstreams: deps.stores.upstreams,
    health: deps.stores.health,
    registry: deps.registry,
    crypto: deps.crypto,
  });

  const adminGet = (path: string) =>
    app.request(path, { headers: { Cookie: cookie } });

  it("存活探测：两个渠道均 up 且记录时延；GET /admin/health 返回时间线", async () => {
    const results = await runHealthChecks(monitorDeps());
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.status).toBe("up");
    const u1 = results.find((r) => r.upstreamId === u1Id)!;
    expect(u1.domainsTotal).toBe(2);
    expect(u1.domainsAdded).toEqual([]); // 建上游时已同步，无差异
    expect(u1.latencyMs).toBeGreaterThanOrEqual(0);

    const res = await adminGet("/admin/health");
    const { channels } = (await res.json()) as {
      channels: { id: string; status: string; uptimePct: number | null; timeline: unknown[] }[];
    };
    expect(channels).toHaveLength(2);
    const ch1 = channels.find((c) => c.id === u1Id)!;
    expect(ch1.status).toBe("up");
    expect(ch1.uptimePct).toBe(100);
    expect(ch1.timeline).toHaveLength(1);
  });

  it("域名变化被记录（新增 + 移除）", async () => {
    // u1 的上游域名变化：移除 b.test，新增 c.test
    await app.request(`/admin/upstreams/${u1Id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ settings: { domains: ["a.test", "c.test"] } }),
    });

    const results = await runHealthChecks(monitorDeps());
    const u1 = results.find((r) => r.upstreamId === u1Id)!;
    expect(u1.status).toBe("up");
    expect(u1.domainsAdded).toEqual(["c.test"]);
    expect(u1.domainsRemoved).toEqual(["b.test"]);

    const { channels } = (await (await adminGet("/admin/health")).json()) as {
      channels: { id: string; domainChange: { checkedAt: string; added: string[]; removed: string[] } | null }[];
    };
    const ch1 = channels.find((c) => c.id === u1Id)!;
    expect(ch1.domainChange).toMatchObject({ added: ["c.test"], removed: ["b.test"] });
    expect(ch1.domainChange!.checkedAt).toBeTruthy();
  });

  it("渠道宕机：状态 down + lastError；恢复后回 up", async () => {
    flakyState.shouldFail = true;
    let results = await runHealthChecks(monitorDeps());
    const u2 = results.find((r) => r.upstreamId === u2Id)!;
    expect(u2.status).toBe("down");
    expect(u2.error).toContain("connection refused");

    let { channels } = (await (await adminGet("/admin/health")).json()) as {
      channels: { id: string; status: string; lastError: string | null; uptimePct: number | null }[];
    };
    const ch2 = channels.find((c) => c.id === u2Id)!;
    expect(ch2.status).toBe("down");
    expect(ch2.lastError).toContain("connection refused");
    expect(ch2.uptimePct).toBe(0);

    flakyState.shouldFail = false;
    results = await runHealthChecks(monitorDeps());
    expect(results.find((r) => r.upstreamId === u2Id)!.status).toBe("up");
    const after = (await (await adminGet("/admin/health")).json()) as {
      channels: { id: string; status: string; lastError: string | null; uptimePct: number | null }[];
    };
    expect(after.channels.find((c) => c.id === u2Id)!.status).toBe("up");
  });

  it("POST /admin/health/check 手动触发；未登录 401", async () => {
    const res = await app.request("/admin/health/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: unknown[] };
    expect(results).toHaveLength(2);

    const noAuth = await app.request("/admin/health/check", { method: "POST" });
    expect(noAuth.status).toBe(401);
  });

  it("域名差异默认自动同步进注册表（移除的域名真的从表里消失）", async () => {
    const admin = async (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    // 上游侧：b.test 下架、c.test 上线
    await admin("PUT", `/admin/upstreams/${u1Id}`, { settings: { domains: ["a.test", "c.test"] } });

    const results = await runHealthChecks(monitorDeps());
    const u1 = results.find((r) => r.upstreamId === u1Id)!;
    expect(u1.syncAction).toBe("applied");

    const after = (await deps.stores.upstreams.listDomainsByUpstream(u1Id)).map((d) => d.domain).sort();
    expect(after).toEqual(["a.test", "c.test"]); // b.test 已被清理，不再污染域名下拉

    // 已应用后，下一轮不应再报同样的差异
    const second = await runHealthChecks(monitorDeps());
    const u1Again = second.find((r) => r.upstreamId === u1Id)!;
    expect(u1Again.domainsAdded).toEqual([]);
    expect(u1Again.domainsRemoved).toEqual([]);
    expect(u1Again.syncAction).toBeNull();
  });

  it("自动同步保留域名自身的停用开关（只同步集合，不重置管理员的调用管控）", async () => {
    const admin = async (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    // 管理员先停用 a.test 的建箱
    await admin("PUT", `/admin/upstreams/${u1Id}/domains/a.test`, { enabled: false });
    // 上游新增 c.test 触发一次自动同步
    await admin("PUT", `/admin/upstreams/${u1Id}`, { settings: { domains: ["a.test", "b.test", "c.test"] } });
    await runHealthChecks(monitorDeps());

    const rows = await deps.stores.upstreams.listDomainsByUpstream(u1Id);
    expect(rows.find((d) => d.domain === "a.test")!.enabled).toBe(false);
    expect(rows.find((d) => d.domain === "c.test")!.enabled).toBe(true);
  });

  it("settings.autoSyncDomains=false 时只检测不改表", async () => {
    const admin = async (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    // 注意顺序：PUT /admin/upstreams 是整体替换 settings，会抹掉 autoSyncDomains；
    // /monitor 端点是合并写入，所以先改上游域名、再配监控开关
    await admin("PUT", `/admin/upstreams/${u1Id}`, { settings: { domains: ["a.test"] } });
    const off = await admin("PUT", `/admin/upstreams/${u1Id}/monitor`, { autoSyncDomains: false });
    expect(off.status).toBe(200);
    expect((await off.json()) as { autoSyncDomains: boolean }).toMatchObject({ autoSyncDomains: false });
    const results = await runHealthChecks(monitorDeps());
    const u1 = results.find((r) => r.upstreamId === u1Id)!;
    expect(u1.domainsRemoved).toEqual(["b.test"]);
    expect(u1.syncAction).toBe("detected");
    // 注册表保持原样，等管理员手动同步
    const after = (await deps.stores.upstreams.listDomainsByUpstream(u1Id)).map((d) => d.domain).sort();
    expect(after).toEqual(["a.test", "b.test"]);
  });

  it("上游返回空域名列表时拒绝清空注册表，并在 /admin/health 提示待确认", async () => {
    const admin = async (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    // 用 flaky 渠道：dummy 适配器对空 settings.domains 会回落到内置默认域名，模拟不出空列表
    await admin("PUT", `/admin/upstreams/${u2Id}`, { settings: { domains: [] } });

    const results = await runHealthChecks(monitorDeps());
    const u2 = results.find((r) => r.upstreamId === u2Id)!;
    expect(u2.status).toBe("up"); // 探测本身成功，只是结果不可信
    expect(u2.syncAction).toBe("blocked:上游返回空域名列表");
    const after = (await deps.stores.upstreams.listDomainsByUpstream(u2Id)).map((d) => d.domain);
    expect(after).toEqual(["f.test"]);

    const { channels } = (await (await adminGet("/admin/health")).json()) as {
      channels: { id: string; autoSyncDomains: boolean; pendingSync: { reason: string; removed: string[] } | null }[];
    };
    const ch2 = channels.find((c) => c.id === u2Id)!;
    expect(ch2.autoSyncDomains).toBe(true);
    expect(ch2.pendingSync).toMatchObject({ reason: "上游返回空域名列表", removed: ["f.test"] });
  });

  it("手动同步成功立即清除待确认告警，失败不清除，后续故障不恢复旧告警", async () => {
    // 所有记录在同一时刻插入，验证秒级时间戳相同时仍按插入顺序判断最新结果。
    vi.useFakeTimers({ toFake: ["Date"] });
    const pending = async () => {
      const { channels } = await (await adminGet("/admin/health")).json() as {
        channels: { id: string; pendingSync: unknown }[];
      };
      return channels.find((c) => c.id === u2Id)!.pendingSync;
    };
    const sync = () => app.request(`/admin/upstreams/${u2Id}/sync-domains`, {
      method: "POST", headers: { Cookie: cookie },
    });
    await deps.stores.upstreams.update(u2Id, { settingsJson: { domains: [] } });
    await runHealthChecks(monitorDeps());
    expect(await pending()).not.toBeNull();
    flakyState.shouldFail = true;
    expect((await sync()).status).toBe(502);
    await runHealthChecks(monitorDeps());
    expect(await pending()).not.toBeNull();
    flakyState.shouldFail = false;
    expect((await sync()).status).toBe(200);
    expect(await pending()).toBeNull();
    const history = await deps.stores.health.listByUpstream(u2Id, 50);
    expect(history[0]!.syncAction).toBe("applied");
    expect(history.some((h) => h.syncAction?.startsWith("blocked:"))).toBe(true);
    await runHealthChecks(monitorDeps());
    expect(await pending()).toBeNull();
    flakyState.shouldFail = true;
    await runHealthChecks(monitorDeps());
    expect(await pending()).toBeNull();
  });

  it.each([["f.test"], ["replacement.test"]])("上游恢复或自动同步成功后清除旧告警：%s", async (domain) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await deps.stores.upstreams.update(u2Id, { settingsJson: { domains: [] } });
    await runHealthChecks(monitorDeps());
    await deps.stores.upstreams.update(u2Id, { settingsJson: { domains: [domain] } });
    await runHealthChecks(monitorDeps());
    const { channels } = await (await adminGet("/admin/health")).json() as {
      channels: { id: string; pendingSync: unknown }[];
    };
    expect(channels.find((c) => c.id === u2Id)!.pendingSync).toBeNull();
  });

  it("探测失败时绝不改注册表（拿不到列表 ≠ 上游没有域名）", async () => {
    const before = (await deps.stores.upstreams.listDomainsByUpstream(u2Id)).map((d) => d.domain);
    expect(before).toEqual(["f.test"]);

    flakyState.shouldFail = true;
    const results = await runHealthChecks(monitorDeps());
    const u2 = results.find((r) => r.upstreamId === u2Id)!;
    expect(u2.status).toBe("down");
    expect(u2.syncAction).toBeNull();

    const after = (await deps.stores.upstreams.listDomainsByUpstream(u2Id)).map((d) => d.domain);
    expect(after).toEqual(["f.test"]);
  });

  it("停用的渠道不参与检查；删除渠道时健康记录级联清理", async () => {
    await app.request(`/admin/upstreams/${u1Id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ enabled: false }),
    });
    const results = await runHealthChecks(monitorDeps());
    expect(results.map((r) => r.upstreamId)).toEqual([u2Id]);

    // 删除 u1（无邮箱）→ 健康记录一并清理
    const del = await app.request(`/admin/upstreams/${u1Id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(del.status).toBe(204);
    const remaining = await deps.stores.health.listByUpstream(u1Id, 10);
    expect(remaining).toHaveLength(0);
  });
});

describe("测活频率配置", () => {
  let app: ReturnType<typeof makeApp>["app"];
  let deps: ReturnType<typeof makeApp>["deps"];
  let cookie: string;
  let u1Id: string;
  let u2Id: string;

  beforeEach(async () => {
    const ctx = makeApp();
    app = ctx.app;
    deps = ctx.deps;
    deps.registry.register(flakyAdapter, { displayName: "Flaky", description: "可控失败的测试适配器" });

    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const admin = async (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const a = await admin("POST", "/admin/upstreams", {
      name: "渠道一", type: "dummy", baseUrl: "memory://c1", settings: { domains: ["c1.test"] },
    });
    u1Id = ((await a.json()) as { upstream: { id: string } }).upstream.id;
    const b = await admin("POST", "/admin/upstreams", {
      name: "渠道二", type: "flaky", baseUrl: "memory://c2", settings: { domains: ["c2.test"] },
    });
    u2Id = ((await b.json()) as { upstream: { id: string } }).upstream.id;
  });

  const monitorDeps = () => ({
    upstreams: deps.stores.upstreams,
    health: deps.stores.health,
    registry: deps.registry,
    crypto: deps.crypto,
  });

  it("到期扫描：未检查的渠道立即探测，间隔内的渠道跳过", async () => {
    const now = Date.now();
    let sweep = await runHealthSweep(monitorDeps(), { globalIntervalMs: 300_000, now });
    expect(sweep).toHaveLength(2); // 从未检查 → 全部探测

    sweep = await runHealthSweep(monitorDeps(), { globalIntervalMs: 300_000, now: now + 60_000 });
    expect(sweep).toHaveLength(0); // 都在全局 5 分钟间隔内 → 跳过

    sweep = await runHealthSweep(monitorDeps(), { globalIntervalMs: 300_000, now: now + 6 * 60_000 });
    expect(sweep).toHaveLength(2); // 超过 5 分钟 → 到期
  });

  it("渠道独立间隔：60s 的渠道先到期；关闭监控的渠道不再探测", async () => {
    const admin = async (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    // u1 配 60s 独立间隔；过低的值被钳制到下限 60s
    const cfg = await admin("PUT", `/admin/upstreams/${u1Id}/monitor`, { intervalMs: 1000 });
    expect(cfg.status).toBe(200);
    const cfgBody = (await cfg.json()) as { monitorIntervalMs: number | null; effectiveIntervalMs: number | null };
    expect(cfgBody.monitorIntervalMs).toBe(60_000);
    expect(cfgBody.effectiveIntervalMs).toBe(60_000);

    const now = Date.now();
    await runHealthSweep(monitorDeps(), { globalIntervalMs: 300_000, now });
    // now+2min：u1（60s）到期，u2（全局 5 分钟）未到期
    let sweep = await runHealthSweep(monitorDeps(), { globalIntervalMs: 300_000, now: now + 120_000 });
    expect(sweep.map((r) => r.upstreamId)).toEqual([u1Id]);

    // 关闭 u1 的自动监控 → 无论如何都不再探测 u1（u2 到期仍正常检查）
    const off = await admin("PUT", `/admin/upstreams/${u1Id}/monitor`, { disabled: true });
    expect(((await off.json()) as { monitorDisabled: boolean }).monitorDisabled).toBe(true);
    sweep = await runHealthSweep(monitorDeps(), { globalIntervalMs: 300_000, now: now + 60 * 60_000 });
    expect(sweep.map((r) => r.upstreamId)).toEqual([u2Id]);

    // GET /admin/health 暴露监控配置
    const { channels } = (await (await admin("GET", "/admin/health")).json()) as {
      channels: { id: string; monitorIntervalMs: number | null; monitorDisabled: boolean; effectiveIntervalMs: number | null }[];
    };
    const ch1 = channels.find((c) => c.id === u1Id)!;
    expect(ch1.monitorDisabled).toBe(true);
    expect(ch1.effectiveIntervalMs).toBeNull();

    // 恢复跟随全局
    const reset = await admin("PUT", `/admin/upstreams/${u1Id}/monitor`, { intervalMs: null, disabled: false });
    const resetBody = (await reset.json()) as { monitorIntervalMs: number | null; monitorDisabled: boolean };
    expect(resetBody.monitorIntervalMs).toBeNull();
    expect(resetBody.monitorDisabled).toBe(false);

    // 未知渠道 404
    const missing = await admin("PUT", "/admin/upstreams/no-such/monitor", { intervalMs: 60_000 });
    expect(missing.status).toBe(404);
  });
});
