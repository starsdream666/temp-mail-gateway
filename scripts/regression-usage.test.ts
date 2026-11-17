import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { resolve } from "node:path";
import { createDrizzleStores } from "../src/adapters/stores/drizzle/index";
import { createWebCryptoCipher } from "../src/adapters/crypto/webcrypto";
import { buildDeps } from "../src/bootstrap";
import { createApp } from "../src/core/app";
import { runMigrations } from "../src/db/migrate-node";

// Isolated reproduction: no production database, environment secrets, or network requests.
async function fixture(fetchFn: typeof fetch) {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite, resolve("migrations"));
  const stores = createDrizzleStores(drizzle(sqlite) as never);
  const cipher = createWebCryptoCipher("usage-review-master-key");
  const deps = buildDeps({ stores, crypto: cipher, fetchFn, config: { masterKey: "usage-review-master-key", adminPassword: "usage-review-password" } });
  const app = createApp(deps);
  const login = await app.request("/admin/session", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "usage-review-password" }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const admin = (path: string, method = "GET", body?: unknown) => app.request(path, {
    method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const keyRes = await admin("/admin/keys", "POST", { name: "usage-review" });
  assert.equal(keyRes.status, 201);
  const { key } = await keyRes.json() as any;
  const headers = { "X-Gateway-Key": key.key as string, "Content-Type": "application/json" };
  const upstream = async (type: string, baseUrl: string) => {
    const res = await admin("/admin/upstreams", "POST", { name: baseUrl, type, baseUrl, apiKey: "review-upstream-secret" });
    assert.equal(res.status, 201);
    return (await res.json() as any).upstream.id as string;
  };
  return { sqlite, stores, deps, app, admin, headers, upstream };
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

test("MoeMail merges every channel's domains after permission filtering and keeps other config fields", async () => {
  const calls: string[] = [];
  const f = await fixture(async input => {
    const u = new URL(String(input)); calls.push(u.hostname + u.pathname);
    if (u.pathname !== "/api/config") return json({ error: "not found" }, 404);
    return json({ emailDomains: u.hostname === "first.test" ? "shared.test, a.test" : "shared.test,b.test", title: u.hostname, features: [u.hostname] });
  });
  try {
    const first = await f.upstream("moemail", "https://first.test");
    const second = await f.upstream("moemail", "https://second.test");
    f.sqlite.prepare("UPDATE upstreams SET created_at = ? WHERE id = ?").run(1, first);
    f.sqlite.prepare("UPDATE upstreams SET created_at = ? WHERE id = ?").run(2, second);
    const merged = await f.app.request("/upstream/moemail/api/config", { headers: f.headers });
    assert.equal(merged.status, 200);
    assert.equal(merged.headers.get("X-Gateway-Merged-Upstreams"), "2");
    const body = await merged.json() as any;
    assert.equal(body.emailDomains, "shared.test,a.test,b.test");
    assert.equal(body.title, "first.test");
    assert.deepEqual(body.features, ["first.test", "second.test"]);
    const restricted = await f.admin("/admin/keys", "POST", { name: "one-domain", domains: ["b.test"] });
    const { key } = await restricted.json() as any;
    const filtered = await f.app.request("/upstream/moemail/api/config", { headers: { "X-Gateway-Key": key.key } });
    assert.equal((await filtered.json() as any).emailDomains, "b.test");
    const channelKeyRes = await f.admin("/admin/keys", "POST", { name: "one-channel", channels: [second] });
    const channelKey = (await channelKeyRes.json() as any).key.key;
    calls.length = 0;
    const channelFiltered = await f.app.request("/upstream/moemail/api/config", { headers: { "X-Gateway-Key": channelKey } });
    assert.equal((await channelFiltered.json() as any).emailDomains, "shared.test,b.test");
    assert.deepEqual(calls, ["second.test/api/config"]);
    const direct = await f.app.request("/upstream/" + first + "/api/config", { headers: f.headers });
    assert.equal((await direct.json() as any).emailDomains, "shared.test,a.test");
  } finally { f.sqlite.close(); }
});

test("YYDS accepts root or /v1 bases, keeps proxy prefixes, filters domains and observes native creation", async () => {
  for (const suffix of ["", "/v1", "/proxy", "/proxy/v1/"]) {
    const prefix = suffix.startsWith("/proxy") ? "/proxy" : "";
    const paths: string[] = [];
    const f = await fixture(async (input, init) => {
      const u = new URL(String(input)); paths.push(u.pathname + u.search);
      if (u.pathname === prefix + "/v1/domains") return json({ success: true, data: [{ domain: "yyds.test" }, { domain: "hidden.test" }] });
      if (u.pathname === prefix + "/v1/accounts" && init?.method === "POST") {
        return json({ success: true, data: { id: "native-account", address: "native@yyds.test", expiresAt: new Date(Date.now() + 86400000).toISOString() } }, 201);
      }
      return json({ success: false, error: "route missing" }, 404);
    });
    try {
      const id = await f.upstream("yydsmail", "https://yyds.test" + suffix);
      assert.deepEqual(paths, [prefix + "/v1/domains"], "sync path for " + suffix);
      paths.length = 0;
      for (const selector of ["yydsmail", id]) {
        const native = await f.app.request("/upstream/" + selector + "/v1/domains?limit=7", { headers: f.headers });
        assert.equal(native.status, 200, suffix);
        assert.equal((await native.json() as any).data.length, 2);
      }
      assert.deepEqual(paths, [prefix + "/v1/domains?limit=7", prefix + "/v1/domains?limit=7"]);
      const keyRes = await f.admin("/admin/keys", "POST", { name: "filtered", domains: ["yyds.test"] });
      const { key } = await keyRes.json() as any;
      const filtered = await f.app.request("/upstream/yydsmail/v1/domains", { headers: { "X-Gateway-Key": key.key } });
      assert.deepEqual((await filtered.json() as any).data, [{ domain: "yyds.test" }]);
      const created = await f.app.request("/upstream/yydsmail/v1/accounts", {
        method: "POST", headers: f.headers, body: JSON.stringify({ domain: "yyds.test", localPart: "native" }),
      });
      assert.equal(created.status, 201); await created.text();
      const stored = await f.stores.mailboxes.findByAddress("native@yyds.test");
      assert.equal(stored?.upstreamId, id);
      assert.equal(stored?.upstreamMailboxId, "native-account");
      assert.equal(paths.at(-1), prefix + "/v1/accounts");
      if (suffix.includes("/v1")) {
        const legacyRelative = await f.app.request("/upstream/" + id + "/domains?limit=3", { headers: f.headers });
        assert.equal(legacyRelative.status, 200);
        await legacyRelative.text();
        assert.equal(paths.at(-1), prefix + "/v1/domains?limit=3");
      }
    } finally { f.sqlite.close(); }
  }
});

test("CF scan exhaustion preserves legacy registration; force records an orphan and known IDs bypass scanning", async () => {
  const addresses = [...Array.from({ length: 500 }, (_, i) => ({ id: i + 1, address: "prefix" + i + "target@cf.test" })), { id: 501, address: "target@cf.test" }];
  const offsets: number[] = [];
  let deleteCalls = 0;
  let exists = true;
  const f = await fixture(async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname === "/open_api/settings") return json({ domains: ["cf.test"] });
    if (u.pathname === "/admin/address") {
      const offset = Number(u.searchParams.get("offset")); offsets.push(offset);
      const rows = u.searchParams.get("query") === "target@cf.test" ? addresses : [];
      return json({ results: rows.slice(offset, offset + Number(u.searchParams.get("limit"))), count: rows.length });
    }
    if (u.pathname === "/admin/delete_address/501" && init?.method === "DELETE") {
      deleteCalls += 1; exists = false; return json({ success: true });
    }
    return json({ error: "not found" }, 404);
  });
  try {
    const upstreamId = await f.upstream("cf-temp-email", "https://cf.test");
    const input = { id: "legacy-cf", upstreamId, address: "target@cf.test", localPart: "target", domain: "cf.test", upstreamMailboxId: "target@cf.test", passwordEnc: null, apiKeyId: null, expiresAt: null };
    await f.stores.mailboxes.create({ ...input, credentialsEnc: await f.deps.crypto.encrypt("legacy-jwt-without-address-id") });
    const denied = await f.app.request("/v1/mailboxes/legacy-cf", { method: "DELETE", headers: f.headers });
    assert.equal(denied.status, 502);
    const error = (await denied.json() as any).error;
    assert.equal(error.details.upstreamCode, "UNAVAILABLE");
    assert.match(error.message, /扫描上限/);
    assert.deepEqual(offsets, [0, 50, 100, 150, 200, 250, 300, 350, 400, 450]);
    assert.equal(deleteCalls, 0); assert.equal(exists, true);
    assert.ok(await f.stores.mailboxes.get("legacy-cf"));
    assert.equal((await f.stores.orphans.list(50)).length, 0);
    const forced = await f.app.request("/v1/mailboxes/legacy-cf?force=1", { method: "DELETE", headers: f.headers });
    assert.equal(forced.status, 200);
    const forcedBody = await forced.json() as any;
    assert.equal(forcedBody.upstreamDeleted, false);
    assert.equal(forcedBody.upstreamError.code, "UNAVAILABLE");
    assert.equal(await f.stores.mailboxes.get("legacy-cf"), null);
    assert.equal((await f.stores.orphans.list(50)).length, 1);
    assert.equal(exists, true);
    await f.stores.mailboxes.create({ ...input, credentialsEnc: await f.deps.crypto.encrypt(JSON.stringify({ addressId: 501 })) });
    offsets.length = 0;
    const knownId = await f.app.request("/v1/mailboxes/legacy-cf", { method: "DELETE", headers: f.headers });
    assert.equal(knownId.status, 204);
    assert.equal(exists, false); assert.equal(deleteCalls, 1); assert.deepEqual(offsets, []);
    const imported = await f.admin("/admin/mailboxes/import", "POST", { addresses: ["target@cf.test"] });
    assert.equal((await imported.json() as any).failed[0].code, "UPSTREAM_UNAVAILABLE");
    await f.stores.mailboxes.create({ ...input, id: "absent", address: "absent@cf.test", upstreamMailboxId: "absent@cf.test", credentialsEnc: null });
    const absent = await f.app.request("/v1/mailboxes/absent", { method: "DELETE", headers: f.headers });
    assert.equal(absent.status, 204);
    assert.equal(await f.stores.mailboxes.get("absent"), null);
  } finally { f.sqlite.close(); }
});

function importMock(mode: "second-only" | "both" | "first-fails") {
  const lookups: string[] = [];
  const fetchFn: typeof fetch = async input => {
    const u = new URL(String(input));
    if (u.pathname === "/api/config") return json({ emailDomains: "shared.test" });
    if (u.pathname === "/api/emails") {
      lookups.push(u.hostname);
      if (mode === "first-fails" && u.hostname === "first.test") return json({ error: "bad upstream key" }, 401);
      const found = mode === "both" || u.hostname === "second.test";
      return json({ emails: found ? [{ id: u.hostname + "-id", address: "owned@shared.test", expiresAt: Date.now() + 86400000 }] : [], nextCursor: null, total: found ? 1 : 0 });
    }
    return json({ error: "not found" }, 404);
  };
  return { fetchFn, lookups };
}

async function importChannels(f: Awaited<ReturnType<typeof fixture>>) {
  const first = await f.upstream("moemail", "https://first.test");
  const second = await f.upstream("moemail", "https://second.test");
  f.sqlite.prepare("UPDATE upstreams SET created_at = ? WHERE id = ?").run(1, first);
  f.sqlite.prepare("UPDATE upstreams SET created_at = ? WHERE id = ?").run(2, second);
  return { first, second };
}

test("import finds the actual second channel and reports per-address failures without creating wrong registrations", async () => {
  const mock = importMock("second-only"); const f = await fixture(mock.fetchFn);
  try {
    const { second } = await importChannels(f);
    const keyRes = await f.admin("/admin/keys", "POST", { name: "import-owner" });
    const key = (await keyRes.json() as any).key;
    const response = await f.admin("/admin/mailboxes/import", "POST", { addresses: ["owned@shared.test", "ghost@shared.test"], apiKeyId: key.id });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.imported.length, 1); assert.equal(body.imported[0].upstreamId, second);
    assert.equal(body.failed[0].code, "UPSTREAM_NOT_FOUND");
    assert.deepEqual(mock.lookups, ["first.test", "second.test", "first.test", "second.test"]);
    const row = (await f.stores.mailboxes.findByAddress("owned@shared.test"))!;
    assert.equal(row.apiKeyId, key.id); assert.equal(row.upstreamMailboxId, "second.test-id");
    assert.equal(await f.stores.mailboxes.findByAddress("ghost@shared.test"), null);
  } finally { f.sqlite.close(); }
});

test("ambiguous imports require an explicit channel; selection checks only the chosen account", async () => {
  const mock = importMock("both"); const f = await fixture(mock.fetchFn);
  try {
    const { second } = await importChannels(f);
    const ambiguous = await f.admin("/admin/mailboxes/import", "POST", { addresses: ["owned@shared.test"] });
    const result = await ambiguous.json() as any;
    assert.deepEqual(result.imported, []); assert.equal(result.failed[0].code, "UPSTREAM_REQUIRED");
    assert.equal(await f.stores.mailboxes.findByAddress("owned@shared.test"), null);
    mock.lookups.length = 0;
    const selected = await f.admin("/admin/mailboxes/import", "POST", { addresses: ["owned@shared.test"], upstreamId: second });
    const body = await selected.json() as any;
    assert.equal(body.imported[0].upstreamId, second); assert.deepEqual(body.failed, []);
    assert.deepEqual(mock.lookups, ["second.test"]);
  } finally { f.sqlite.close(); }
});

test("a failed candidate cannot establish unique ownership, while an explicitly healthy channel remains usable", async () => {
  const mock = importMock("first-fails"); const f = await fixture(mock.fetchFn);
  try {
    const { first, second } = await importChannels(f);
    const uncertain = await f.admin("/admin/mailboxes/import", "POST", { addresses: ["owned@shared.test"] });
    assert.equal((await uncertain.json() as any).failed[0].code, "UPSTREAM_REQUIRED");
    assert.equal(await f.stores.mailboxes.findByAddress("owned@shared.test"), null);
    const failedOnly = await f.admin("/admin/mailboxes/import", "POST", { addresses: ["owned@shared.test"], upstreamId: first });
    assert.equal((await failedOnly.json() as any).failed[0].code, "UPSTREAM_AUTH_FAILED");
    const selected = await f.admin("/admin/mailboxes/import", "POST", { addresses: ["owned@shared.test"], upstreamId: second });
    assert.equal((await selected.json() as any).imported[0].upstreamId, second);
  } finally { f.sqlite.close(); }
});

test("explicit imports reject unknown, disabled and unrelated channels without querying another account", async () => {
  const mock = importMock("both"); const f = await fixture(mock.fetchFn);
  try {
    const { first, second } = await importChannels(f);
    const addresses = ["owned@shared.test"];
    const unknown = await f.admin("/admin/mailboxes/import", "POST", { addresses, upstreamId: "no-such-channel" });
    assert.equal(unknown.status, 404); await unknown.text();
    await f.stores.upstreams.update(second, { enabled: false });
    const disabledRes = await f.admin("/admin/mailboxes/import", "POST", { addresses, upstreamId: second });
    assert.equal((await disabledRes.json() as any).failed[0].code, "DOMAIN_NOT_ROUTED");
    await f.stores.upstreams.setAllDomainsEnabled(first, false);
    const domainDisabled = await f.admin("/admin/mailboxes/import", "POST", { addresses, upstreamId: first });
    assert.equal((await domainDisabled.json() as any).failed[0].code, "DOMAIN_DISABLED");
    const unrelated = await f.admin("/admin/mailboxes/import", "POST", { addresses: ["other@elsewhere.test"], upstreamId: first });
    assert.equal((await unrelated.json() as any).failed[0].code, "DOMAIN_NOT_ROUTED");
    assert.deepEqual(mock.lookups, []);
    assert.equal(await f.stores.mailboxes.findByAddress(addresses[0]!), null);
  } finally { f.sqlite.close(); }
});
