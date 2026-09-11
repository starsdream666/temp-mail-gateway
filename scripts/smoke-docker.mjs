import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

// Run inside a disposable container with an empty database and test credentials.
assert.equal(process.env.DOCKER_SMOKE_TEST, "1", "Requires a disposable smoke-test container");
const expectedVersion = process.argv[2];
assert.ok(expectedVersion, "Pass the expected release version");
const base = `http://127.0.0.1:${process.env.PORT || 8787}`;
const request = (path, init = {}) => fetch(base + path, { ...init, signal: AbortSignal.timeout(5000) });

const pkg = JSON.parse(readFileSync("/app/package.json", "utf8"));
assert.equal(pkg.version, expectedVersion);
assert.equal(existsSync("/app/.env"), false);
assert.equal(existsSync("/app/LICENSE"), true);
assert.equal(existsSync("/app/THIRD_PARTY_NOTICES.md"), true);
const info = await request("/api/info");
assert.equal(info.status, 200);
assert.equal((await info.json()).version, expectedVersion);
const doc = await request("/api/doc");
assert.equal(doc.status, 200);
assert.equal((await doc.json()).info.version, expectedVersion);

const page = await request("/");
assert.equal(page.status, 200);
assert.match(page.headers.get("content-type"), /text\/html/);
assert.match(await page.text(), /id="root"/);
const assets = readdirSync("/app/frontend/dist/assets").filter((name) => /\.(js|css)$/.test(name));
assert.ok(assets.some((name) => name.endsWith(".js")));
assert.ok(assets.some((name) => name.endsWith(".css")));
for (const name of assets) {
  const res = await request(`/assets/${name}`);
  assert.equal(res.status, 200, name);
  assert.ok((await res.arrayBuffer()).byteLength > 0, name);
}

assert.equal((await request("/admin/upstreams")).status, 401);
const login = await request("/admin/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
});
assert.equal(login.status, 204);
const cookie = login.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie);
const headers = { Cookie: cookie, "Content-Type": "application/json" };
const upstreams = await request("/admin/upstreams", { headers });
assert.equal(upstreams.status, 200);
assert.deepEqual((await upstreams.json()).upstreams, []);
const health = await request("/admin/health", { headers });
assert.equal(health.status, 200);
assert.deepEqual((await health.json()).channels, []);
const settings = await request("/admin/settings", { headers });
assert.equal(settings.status, 200);
const globals = (await settings.json()).settings;
assert.equal(globals.healthCheckEnabled, true);
assert.equal(globals.maxConcurrentRequestsPerKey, 0);
assert.equal(globals.mailboxCleanupEnabled, false);
assert.equal(globals.mailboxCleanupImmediate, false);
assert.equal(globals.mailboxCleanupIntervalMs, 3_600_000);
assert.equal(Object.hasOwn(globals, "mailboxCleanupLastRunAt"), false);
assert.equal(Object.hasOwn(globals, "adminPasswordHash"), false);
const settingsPage = await request("/settings");
assert.equal(settingsPage.status, 200);
assert.match(settingsPage.headers.get("content-type"), /text\/html/);
const frontendBundle = await request(`/assets/${assets.find((name) => name.endsWith(".js"))}`);
const bundleText = await frontendBundle.text();
assert.match(bundleText, /当前版本/);
assert.match(bundleText, /过期邮箱自动清理/);
assert.match(bundleText, /过期立即清理/);

const key = await request("/admin/keys", {
  method: "POST", headers, body: JSON.stringify({ name: "docker-smoke" }),
});
assert.equal(key.status, 201);
const createdKey = (await key.json()).key;
assert.equal(createdKey.mailboxesPerHour, null);
assert.equal(createdKey.maxConcurrentRequests, null);
assert.equal(createdKey.effectiveMaxConcurrentRequests, 0);
const defaultLimit = Number(process.env.MAILBOXES_PER_KEY_PER_HOUR ?? 60);
assert.equal(createdKey.effectiveMailboxesPerHour, defaultLimit);
const domains = await request("/v1/domains", { headers: { "X-Gateway-Key": createdKey.key } });
assert.equal(domains.status, 200);
assert.deepEqual((await domains.json()).domains, []);

// 空数据库没有上游：创建请求经限流器放行后返回 DOMAIN_NOT_ROUTED，绝不请求真实上游。
async function expectCreateResult(apiKey, status, code) {
  const response = await request("/v1/mailboxes", {
    method: "POST",
    headers: { "X-Gateway-Key": apiKey.key, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, status);
  assert.equal((await response.json()).error.code, code);
}
async function updateLimit(apiKey, mailboxesPerHour) {
  const response = await request(`/admin/keys/${apiKey.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ mailboxesPerHour }),
  });
  assert.equal(response.status, 200);
  const updated = (await response.json()).key;
  assert.equal(updated.mailboxesPerHour, mailboxesPerHour);
  assert.equal(updated.effectiveMailboxesPerHour, mailboxesPerHour ?? defaultLimit);
}
const limitedResponse = await request("/admin/keys", {
  method: "POST", headers, body: JSON.stringify({ name: "docker-smoke-limited", mailboxesPerHour: 1 }),
});
assert.equal(limitedResponse.status, 201);
const limitedKey = (await limitedResponse.json()).key;
assert.equal(limitedKey.mailboxesPerHour, 1);
assert.equal(limitedKey.effectiveMailboxesPerHour, 1);
await expectCreateResult(limitedKey, 400, "DOMAIN_NOT_ROUTED");
await expectCreateResult(limitedKey, 429, "RATE_LIMITED");
await expectCreateResult(createdKey, 400, "DOMAIN_NOT_ROUTED");
await updateLimit(limitedKey, 2);
await expectCreateResult(limitedKey, 400, "DOMAIN_NOT_ROUTED");
await expectCreateResult(limitedKey, 429, "RATE_LIMITED");
await updateLimit(limitedKey, 0);
await expectCreateResult(limitedKey, 400, "DOMAIN_NOT_ROUTED");
await updateLimit(limitedKey, null);
const keyList = await request("/admin/keys", { headers });
assert.equal(keyList.status, 200);
assert.equal((await keyList.json()).keys.find((item) => item.id === limitedKey.id).mailboxesPerHour, null);
assert.equal((await request(`/admin/keys/${limitedKey.id}/revoke`, { method: "POST", headers })).status, 204);
assert.equal((await request(`/admin/keys/${createdKey.id}/revoke`, { method: "POST", headers })).status, 204);
assert.equal((await request("/v1/domains", { headers: { "X-Gateway-Key": createdKey.key } })).status, 401);
// 直接读测试容器的数据库验证后台定时器，避免概览请求本身触发清理而掩盖调度故障。
const Database = createRequire("/app/package.json")("better-sqlite3");
assert.ok(process.env.DATABASE_PATH);
const db = new Database(process.env.DATABASE_PATH, { fileMustExist: true });
const upstreamId = "cleanup-docker-smoke";
const count = (id) => db.prepare("SELECT count(*) AS n FROM mailboxes WHERE id=?").get(id).n;
async function updateSettings(patch) {
  const response = await request("/admin/settings", { method: "PATCH", headers, body: JSON.stringify(patch) });
  assert.equal(response.status, 200, JSON.stringify(patch));
  return (await response.json()).settings;
}
async function until(check, label) {
  const deadline = Date.now() + 6000;
  while (!check()) {
    assert.ok(Date.now() < deadline, label);
    await delay(100);
  }
}
try {
  assert.equal(db.prepare("SELECT count(*) AS n FROM mailboxes").get().n, 0, "Cleanup smoke requires an empty disposable database");
  const invalid = await request("/admin/settings", { method: "PATCH", headers, body: JSON.stringify({ mailboxCleanupIntervalMs: 0 }) });
  assert.equal(invalid.status, 400);
  await updateSettings({ healthCheckEnabled: false, mailboxCleanupEnabled: false });
  db.prepare("INSERT INTO upstreams (id, name, type, base_url, settings_json, enabled, created_at) VALUES (?, 'cleanup smoke', 'moemail', 'http://127.0.0.1:1', '{}', 0, ?)").run(upstreamId, Math.floor(Date.now() / 1000));
  const seed = (id, expiresAt) => db.prepare("INSERT INTO mailboxes (id, upstream_id, address, local_part, domain, upstream_mailbox_id, expires_at, created_at) VALUES (?, ?, ?, ?, 'example.invalid', ?, ?, ?)")
    .run(id, upstreamId, id + "@example.invalid", id, id, expiresAt, Math.floor(Date.now() / 1000));
  seed("cleanup-old", Math.floor(Date.now() / 1000) - 10);
  seed("cleanup-boundary", Math.floor(Date.now() / 1000));
  seed("cleanup-future", Math.floor(Date.now() / 1000) + 3600);
  seed("cleanup-permanent", null);
  await delay(1250);
  assert.equal(count("cleanup-old"), 1, "Disabled cleanup must retain expired mailboxes");
  await updateSettings({ mailboxCleanupEnabled: true, mailboxCleanupImmediate: false, mailboxCleanupIntervalMs: 60_000 });
  await until(() => count("cleanup-old") === 0 && count("cleanup-boundary") === 0, "Interval cleanup must run without HTTP requests and with health disabled");
  const soon = Math.floor(Date.now() / 1000) + 2;
  seed("cleanup-soon", soon);
  await delay(Math.max(0, soon * 1000 - Date.now()) + 1250);
  assert.equal(count("cleanup-soon"), 1, "Interval mode must wait until the next sweep is due");
  await updateSettings({ mailboxCleanupImmediate: true });
  await until(() => count("cleanup-soon") === 0, "Immediate mode must bypass the configured batch interval");
  assert.equal(count("cleanup-future"), 1);
  assert.equal(count("cleanup-permanent"), 1);
  await updateSettings({ mailboxCleanupEnabled: false });
  seed("cleanup-disabled", Math.floor(Date.now() / 1000) - 10);
  await delay(1250);
  assert.equal(count("cleanup-disabled"), 1);
  const manual = await request("/admin/mailboxes/prune-expired", { method: "POST", headers });
  assert.equal(manual.status, 200);
  assert.equal((await manual.json()).deleted, 1);
} finally {
  await updateSettings(globals);
  db.prepare("DELETE FROM mailboxes WHERE upstream_id=?").run(upstreamId);
  db.prepare("DELETE FROM upstreams WHERE id=?").run(upstreamId);
  db.close();
}
console.log(`Docker smoke passed: v${expectedVersion}, SQLite migration, background mailbox cleanup, interval/immediate/disabled modes, per-key rate limits, login, API key, health, OpenAPI, ${assets.length} frontend assets`);
