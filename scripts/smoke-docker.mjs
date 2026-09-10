import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

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
assert.equal(Object.hasOwn(globals, "adminPasswordHash"), false);
const settingsPage = await request("/settings");
assert.equal(settingsPage.status, 200);
assert.match(settingsPage.headers.get("content-type"), /text\/html/);

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
console.log(`Docker smoke passed: v${expectedVersion}, SQLite migration, per-key rate limits, login, API key, health, OpenAPI, ${assets.length} frontend assets`);
