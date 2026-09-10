import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDrizzleStores } from "../../src/adapters/stores/drizzle";
import { createWebCryptoCipher } from "../../src/adapters/crypto/webcrypto";
import { buildDeps } from "../../src/bootstrap";
import { createApp, type GatewayDeps } from "../../src/core/app";
import { runMigrations } from "../../src/db/migrate-node";
import { registerDummyAdapter } from "../helpers";

interface KeyInfo {
  id: string;
  key: string;
  name: string;
  mailboxesPerHour: number | null;
  effectiveMailboxesPerHour: number;
}

describe("每个 key 独立配置邮箱创建限流", () => {
  let sqlite: Database.Database;
  let deps: GatewayDeps;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let sequence: number;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    sequence = 0;
    sqlite = new Database(":memory:");
    runMigrations(sqlite, resolve("migrations"));
    deps = buildDeps({
      stores: createDrizzleStores(drizzle(sqlite) as never),
      crypto: createWebCryptoCipher("test-rate-limit-master-key"),
      config: {
        adminPassword: "test-rate-limit-admin",
        masterKey: "test-rate-limit-master-key",
        mailboxesPerKeyPerHour: 2,
      },
    });
    registerDummyAdapter(deps);
    app = createApp(deps);
    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: deps.config.adminPassword }),
    });
    expect(login.status).toBe(204);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const upstream = await admin("POST", "/admin/upstreams", {
      name: "限流测试上游",
      type: "dummy",
      baseUrl: "memory://rate-limit",
      settings: { domains: ["limit.test"] },
    });
    expect(upstream.status).toBe(201);
  });

  afterEach(() => {
    sqlite?.close();
    vi.useRealTimers();
  });

  function admin(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function issueKey(mailboxesPerHour?: number | null): Promise<KeyInfo> {
    const response = await admin("POST", "/admin/keys", { name: `key-${++sequence}`, mailboxesPerHour });
    expect(response.status).toBe(201);
    return ((await response.json()) as { key: KeyInfo }).key;
  }

  async function updateLimit(key: KeyInfo, mailboxesPerHour: number | null): Promise<KeyInfo> {
    const response = await admin("PATCH", `/admin/keys/${key.id}`, { mailboxesPerHour });
    expect(response.status).toBe(200);
    return ((await response.json()) as { key: KeyInfo }).key;
  }

  function createMailbox(key: KeyInfo) {
    return app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "limit.test", localPart: `user-${++sequence}` }),
    });
  }

  it("签发、列表与更新返回保存值和实际生效值，未传字段保留配置", async () => {
    const custom = await issueKey(5);
    const unlimited = await issueKey(0);
    const inherited = await issueKey();
    const explicitDefault = await issueKey(null);
    expect(custom).toMatchObject({ mailboxesPerHour: 5, effectiveMailboxesPerHour: 5 });
    expect(unlimited).toMatchObject({ mailboxesPerHour: 0, effectiveMailboxesPerHour: 0 });
    expect(inherited).toMatchObject({ mailboxesPerHour: null, effectiveMailboxesPerHour: 2 });
    expect(explicitDefault).toMatchObject({ mailboxesPerHour: null, effectiveMailboxesPerHour: 2 });

    const renamed = await admin("PATCH", `/admin/keys/${custom.id}`, { name: "renamed" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ key: { name: "renamed", mailboxesPerHour: 5, effectiveMailboxesPerHour: 5 } });

    // 重建 app 后仍从存储读取各自配置，不依赖签发接口的内存回显。
    app = createApp(deps);
    const response = await admin("GET", "/admin/keys");
    expect(response.status).toBe(200);
    const { keys } = (await response.json()) as { keys: KeyInfo[] };
    expect(keys).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: custom.id, mailboxesPerHour: 5, effectiveMailboxesPerHour: 5 }),
      expect.objectContaining({ id: unlimited.id, mailboxesPerHour: 0, effectiveMailboxesPerHour: 0 }),
      expect.objectContaining({ id: inherited.id, mailboxesPerHour: null, effectiveMailboxesPerHour: 2 }),
    ]));
    expect((await deps.stores.apiKeys.get(custom.id))?.mailboxesPerHour).toBe(5);
  });

  it("不同上限分别生效，超限 key 不影响其他 key 或查询接口", async () => {
    const low = await issueKey(1);
    const high = await issueKey(3);
    const inherited = await issueKey();
    const unlimited = await issueKey(0);
    expect((await createMailbox(low)).status).toBe(201);
    const blocked = await createMailbox(low);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    for (let i = 0; i < 3; i++) expect((await createMailbox(high)).status).toBe(201);
    expect((await createMailbox(high)).status).toBe(429);
    for (let i = 0; i < 2; i++) expect((await createMailbox(inherited)).status).toBe(201);
    expect((await createMailbox(inherited)).status).toBe(429);
    for (let i = 0; i < 4; i++) expect((await createMailbox(unlimited)).status).toBe(201);
    for (const path of ["/v1/domains", "/v1/mailboxes"]) {
      expect((await app.request(path, { headers: { Authorization: `Bearer ${low.key}` } })).status).toBe(200);
    }
  });

  it("提高、降低、取消限流和恢复默认立即生效，保存不会清空用量", async () => {
    const key = await issueKey(1);
    expect((await createMailbox(key)).status).toBe(201);
    expect((await createMailbox(key)).status).toBe(429);
    expect(await updateLimit(key, 3)).toMatchObject({ mailboxesPerHour: 3, effectiveMailboxesPerHour: 3 });
    expect((await createMailbox(key)).status).toBe(201);
    await updateLimit(key, 1);
    expect((await createMailbox(key)).status).toBe(429);
    await updateLimit(key, 0);
    expect((await createMailbox(key)).status).toBe(201);
    expect(await updateLimit(key, null)).toMatchObject({ mailboxesPerHour: null, effectiveMailboxesPerHour: 2 });
    expect((await createMailbox(key)).status).toBe(429);
    await updateLimit(key, 3);
    expect((await createMailbox(key)).status).toBe(429);
    await updateLimit(key, 4);
    expect((await createMailbox(key)).status).toBe(201);
    expect((await createMailbox(key)).status).toBe(429);
  });

  it("一小时窗口到期后恢复额度", async () => {
    const key = await issueKey(1);
    expect((await createMailbox(key)).status).toBe(201);
    vi.setSystemTime(new Date("2026-09-10T00:59:59.999Z"));
    expect((await createMailbox(key)).status).toBe(429);
    vi.setSystemTime(new Date("2026-09-10T01:00:00.000Z"));
    expect((await createMailbox(key)).status).toBe(201);
    expect((await createMailbox(key)).status).toBe(429);
  });

  it("系统默认不限速时，独立上限仍生效", async () => {
    app = createApp({ ...deps, config: { ...deps.config, mailboxesPerKeyPerHour: 0 } });
    const custom = await issueKey(1);
    const inherited = await issueKey();
    expect(inherited.effectiveMailboxesPerHour).toBe(0);
    expect((await createMailbox(custom)).status).toBe(201);
    expect((await createMailbox(custom)).status).toBe(429);
    for (let i = 0; i < 3; i++) expect((await createMailbox(inherited)).status).toBe(201);
  });

  it("未配置环境变量时沿用每小时 60 次默认值", async () => {
    app = createApp({ ...deps, config: { ...deps.config, mailboxesPerKeyPerHour: undefined } });
    expect(await issueKey()).toMatchObject({ mailboxesPerHour: null, effectiveMailboxesPerHour: 60 });
  });

  it.each([-1, 1.5, "3", true, {}, [], Number.MAX_SAFE_INTEGER + 1])("拒绝非法上限 %j，且不修改已保存的上限", async (value) => {
    const key = await issueKey(3);
    for (const [method, path] of [["POST", "/admin/keys"], ["PATCH", `/admin/keys/${key.id}`]]) {
      const response = await admin(method!, path!, { name: "invalid", mailboxesPerHour: value });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
    expect((await deps.stores.apiKeys.get(key.id))?.mailboxesPerHour).toBe(3);
  });

  it("普通 API key 无权修改自己的上限", async () => {
    const key = await issueKey(1);
    const response = await app.request(`/admin/keys/${key.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${key.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mailboxesPerHour: 0 }),
    });
    expect(response.status).toBe(401);
    expect((await deps.stores.apiKeys.get(key.id))?.mailboxesPerHour).toBe(1);
  });
});

it("旧数据库升级后 key 继承默认上限，重复启动不会重复迁移", () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec("CREATE TABLE __migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const migrationsDir = resolve("migrations");
    for (const file of readdirSync(migrationsDir).filter((file) => file.endsWith(".sql") && file < "0008_api_key_rate_limit.sql").sort()) {
      sqlite.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
      sqlite.prepare("INSERT INTO __migrations (name, applied_at) VALUES (?, ?)").run(file, 0);
    }
    sqlite.prepare("INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("legacy", "旧 key", "legacy-hash", "tmg_legacy", 100);
    runMigrations(sqlite, migrationsDir);
    runMigrations(sqlite, migrationsDir);
    expect(sqlite.prepare("SELECT id, key_hash, mailboxes_per_hour FROM api_keys").all()).toEqual([
      { id: "legacy", key_hash: "legacy-hash", mailboxes_per_hour: null },
    ]);
  } finally {
    sqlite.close();
  }
});
