import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { resolve } from "node:path";
import { createDrizzleStores } from "../../src/adapters/stores/drizzle";
import { createWebCryptoCipher } from "../../src/adapters/crypto/webcrypto";
import { buildDeps } from "../../src/bootstrap";
import { createApp, type GatewayDeps } from "../../src/core/app";
import { readSettings } from "../../src/core/settings";
import { runHealthChecks, runHealthSweep } from "../../src/core/monitor";
import { runMigrations } from "../../src/db/migrate-node";
import { registerDummyAdapter } from "../helpers";

describe("全局设置", () => {
  let sqlite: Database.Database;
  let deps: GatewayDeps;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let sequence: number;
  const password = "settings-test-password";

  function login(secret = password, target = app) {
    return target.request("/admin/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: secret }) });
  }
  function admin(path: string, body?: unknown, target = app) {
    return target.request(path, { method: body === undefined ? "GET" : "PATCH", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function issueKey(maxConcurrentRequests?: number | null, mailboxesPerHour?: number | null) {
    const res = await app.request("/admin/keys", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: `key-${++sequence}`, maxConcurrentRequests, mailboxesPerHour }) });
    expect(res.status).toBe(201);
    return (await res.json() as { key: { id: string; key: string } }).key;
  }
  const request = (key: string, path = "/v1/domains") => app.request(path, { headers: { Authorization: `Bearer ${key}` } });

  beforeEach(async () => {
    sequence = 0;
    sqlite = new Database(":memory:");
    runMigrations(sqlite, resolve("migrations"));
    deps = buildDeps({
      stores: createDrizzleStores(drizzle(sqlite) as never), crypto: createWebCryptoCipher("settings-test-master-key"),
      config: { adminPassword: password, masterKey: "settings-test-master-key", mailboxesPerKeyPerHour: 2 },
    });
    registerDummyAdapter(deps);
    app = createApp(deps);
    const res = await login();
    expect(res.status).toBe(204);
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterEach(() => { vi.restoreAllMocks(); sqlite.close(); });

  it("鉴权、默认值、环境配置回退和私密字段隔离", async () => {
    expect((await app.request("/admin/settings")).status).toBe(401);
    const res = await admin("/admin/settings");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ settings: {
      healthCheckEnabled: true, healthCheckIntervalMs: 300_000, mailboxesPerKeyPerHour: 2, maxConcurrentRequestsPerKey: 0,
    } });
    const configured = await readSettings(deps.stores.settings, { ...deps.config, maxConcurrentRequestsPerKey: 8, healthCheckIntervalMs: 600_000 });
    expect(configured).toMatchObject({ maxConcurrentRequestsPerKey: 8, healthCheckIntervalMs: 600_000 });
  });

  it("运行配置跨 app 持久化，并且并行更新不同字段不丢配置", async () => {
    const other = createApp(deps);
    const results = await Promise.all([
      admin("/admin/settings", { healthCheckIntervalMs: 120_000 }),
      admin("/admin/settings", { maxConcurrentRequestsPerKey: 4 }, other),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await (await admin("/admin/settings", undefined, createApp(deps))).json()).toMatchObject({ settings: { healthCheckIntervalMs: 120_000, maxConcurrentRequestsPerKey: 4 } });
    expect((await admin("/admin/me")).status).toBe(200);
  });

  it.each([
    {}, { healthCheckIntervalMs: 59_999 }, { healthCheckIntervalMs: 86_400_001 },
    { mailboxesPerKeyPerHour: -1 }, { mailboxesPerKeyPerHour: 1.2 }, { maxConcurrentRequestsPerKey: "3" },
    { maxConcurrentRequestsPerKey: null }, { healthCheckEnabled: "false" }, { adminUsername: "  " },
    { newPassword: "short" }, { newPassword: "        " }, { masterKey: "no" },
  ])("拒绝无效或未知配置 %j，保持原设置", async (patch) => {
    expect((await admin("/admin/settings", patch)).status).toBe(400);
    expect(await deps.stores.settings.get()).toBeNull();
  });

  it("改密码验证当前密码、原子保存、吊销所有旧会话及透传管理会话", async () => {
    const other = createApp(deps);
    const patch = { newPassword: " new-password-with-spaces ", healthCheckIntervalMs: 120_000 };
    expect((await admin("/admin/settings", patch)).status).toBe(403);
    expect((await admin("/admin/settings", { ...patch, currentPassword: "wrong" })).status).toBe(403);
    expect(await deps.stores.settings.get()).toBeNull();
    const res = await admin("/admin/settings", { ...patch, currentPassword: password });
    expect(res.status).toBe(200);
    const responseText = await res.text();
    expect(JSON.parse(responseText)).toMatchObject({ reauthenticationRequired: true, settings: { healthCheckIntervalMs: 120_000 } });
    expect(responseText).not.toMatch(/password|pbkdf2/i);
    const stored = await deps.stores.settings.get();
    expect(stored?.adminPasswordHash).toMatch(/^pbkdf2-sha256:/);
    expect(JSON.stringify(stored)).not.toContain(patch.newPassword);
    expect((await admin("/admin/me", undefined, other)).status).toBe(401);
    expect((await other.request("/upstream/moemail/anything", { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await login(password, other)).status).toBe(401);
    expect((await login(patch.newPassword.trim(), other)).status).toBe(401);
    expect((await login(patch.newPassword, createApp(deps))).status).toBe(204);
  });

  it("改回原密码也不复活历史会话", async () => {
    const originalCookie = cookie;
    expect((await admin("/admin/settings", { newPassword: "another-password", currentPassword: password })).status).toBe(200);
    const res = await login("another-password");
    expect(res.status).toBe(204);
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await admin("/admin/settings", { newPassword: password, currentPassword: "another-password" })).status).toBe(200);
    cookie = originalCookie;
    expect((await admin("/admin/me")).status).toBe(401);
    expect((await login()).status).toBe(204);
  });

  it("全局建箱上限立即影响继承的 Key、保留计数、尊重单独设置", async () => {
    const key = await issueKey();
    const custom = await issueKey(null, 7);
    const create = () => app.request("/v1/mailboxes", { method: "POST", headers: { Authorization: key.key, "Content-Type": "application/json" }, body: JSON.stringify({ domain: "unregistered.test" }) });
    await (await create()).text(); // 路由失败也消耗已放行的建箱次数
    expect((await admin("/admin/settings", { mailboxesPerKeyPerHour: 1 })).status).toBe(200);
    expect((await create()).status).toBe(429);
    expect((await admin("/admin/settings", { mailboxesPerKeyPerHour: 3 })).status).toBe(200);
    expect((await create()).status).toBe(400);
    const { keys } = await (await admin("/admin/keys")).json() as { keys: Array<{ id: string; effectiveMailboxesPerHour: number }> };
    expect(keys.find((k) => k.id === key.id)?.effectiveMailboxesPerHour).toBe(3);
    expect(keys.find((k) => k.id === custom.id)?.effectiveMailboxesPerHour).toBe(7);
  });

  it("巡检实时读取全局间隔和开关，保留渠道覆盖，手动检测仍可执行", async () => {
    for (const id of ["inherited", "custom"]) {
      await deps.stores.upstreams.create({ id, name: id, type: "dummy", baseUrl: "memory://settings", apiKeyEnc: null, settingsJson: { domains: [id + ".test"], ...(id === "custom" && { monitorIntervalMs: 600_000 }) } });
    }
    const monitor = { upstreams: deps.stores.upstreams, health: deps.stores.health, crypto: deps.crypto, registry: deps.registry, getSettings: () => readSettings(deps.stores.settings, deps.config) };
    await runHealthChecks(monitor);
    const now = Date.now() + 121_000;
    expect(await runHealthSweep(monitor, { now })).toHaveLength(0);
    await admin("/admin/settings", { healthCheckIntervalMs: 60_000 });
    expect((await runHealthSweep(monitor, { now })).map((x) => x.upstreamId)).toEqual(["inherited"]);
    await admin("/admin/settings", { healthCheckEnabled: false });
    expect(await runHealthSweep(monitor, { now: now + 900_000 })).toHaveLength(0);
    const { channels } = await (await admin("/admin/health")).json() as { channels: Array<{ effectiveIntervalMs: number | null }> };
    expect(channels.every((ch) => ch.effectiveIntervalMs === null)).toBe(true);
    expect(await runHealthChecks(monitor)).toHaveLength(2);
  });

  it("并发超限的 Key 返回 429，其他 Key 独立计数，完成后释放名额", async () => {
    await admin("/admin/settings", { maxConcurrentRequestsPerKey: 1 });
    const a = await issueKey();
    const b = await issueKey();
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(deps.stores.upstreams, "listActiveDomains").mockImplementationOnce(async () => { started(); await pending; return []; });
    const first = request(a.key);
    await ready;
    try {
      expect((await request(a.key)).status).toBe(429);
      const other = await request(b.key);
      expect(other.status).toBe(200);
      await other.text();
    } finally { release(); }
    await (await first).text();
    expect((await request(a.key)).status).toBe(200);
  });

  it.each(["complete", "cancel", "error"])("透传流 %s 后释放名额，且与统一 API 共用并发额度", async (finish) => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    deps.fetchFn = vi.fn(async () => new Response(stream, { headers: { "Content-Type": "text/plain" } })) as typeof fetch;
    app = createApp(deps);
    await deps.stores.upstreams.create({ id: "stream", name: "stream", type: "moemail", baseUrl: "https://upstream.test", apiKeyEnc: await deps.crypto.encrypt("test-upstream-key"), settingsJson: {} });
    await admin("/admin/settings", { maxConcurrentRequestsPerKey: 1 });
    const key = await issueKey();
    const res = await request(key.key, "/upstream/stream/stream");
    expect(res.status).toBe(200);
    expect((await request(key.key)).status).toBe(429);
    if (finish === "cancel") await res.body!.cancel();
    else if (finish === "error") { source.error(new Error("stream failed")); await expect(res.text()).rejects.toThrow("stream failed"); }
    else { source.close(); await res.text(); }
    expect((await request(key.key)).status).toBe(200);
  });

  it("Key 单独并发上限支持创建、修改、0 不限和 null 继承，错误响应不泄漏名额", async () => {
    const key = await issueKey(0);
    await admin("/admin/settings", { maxConcurrentRequestsPerKey: 1 });
    const before = await admin(`/admin/keys/${key.id}`, { name: "renamed" });
    expect(await before.json()).toMatchObject({ key: { maxConcurrentRequests: 0, effectiveMaxConcurrentRequests: 0 } });
    const updated = await admin(`/admin/keys/${key.id}`, { maxConcurrentRequests: null });
    expect(await updated.json()).toMatchObject({ key: { maxConcurrentRequests: null, effectiveMaxConcurrentRequests: 1 } });
    for (let i = 0; i < 3; i++) {
      const res = await request(key.key, "/v1/mailboxes/missing");
      expect(res.status).toBe(404);
      await res.text();
    }
    expect((await admin(`/admin/keys/${key.id}`, { maxConcurrentRequests: -1 })).status).toBe(400);
  });
});
