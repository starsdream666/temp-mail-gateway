import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createDrizzleStores } from "../src/adapters/stores/drizzle";
import { runMigrations } from "../src/db/migrate-node";
import { createWebCryptoCipher } from "../src/adapters/crypto/webcrypto";
import { buildDeps } from "../src/bootstrap";
import { createApp } from "../src/core/app";
import { YydsMailAdapter } from "../src/adapters/upstreams/yydsmail";
import { MoeMailAdapter } from "../src/adapters/upstreams/moemail";
import { changedUpstreamFields } from "../frontend/src/utils/upstream";
import { parseIntervalSeconds, secondsToMilliseconds } from "../frontend/src/utils/interval";
import { ChannelPicker } from "../frontend/src/components/ChannelPicker";
import { createElement } from "../frontend/node_modules/react/index.js";
import { renderToStaticMarkup } from "../frontend/node_modules/react-dom/server.node.js";

async function fixture(fetchFn: typeof fetch = async () => { throw new Error("Unexpected upstream call"); }) {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite, resolve("migrations"));
  const stores = createDrizzleStores(drizzle(sqlite) as never);
  const deps = buildDeps({ stores, crypto: createWebCryptoCipher("safety-test-master"), fetchFn, config: { masterKey: "safety-test-master", adminPassword: "safety-test-password" } });
  deps.registry.register(new YydsMailAdapter({ fetchFn, timeoutMs: 40 }), { displayName: "YYDS", description: "test" });
  const app = createApp(deps);
  const login = await app.request("/admin/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "safety-test-password" }) });
  assert.equal(login.status, 204);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const admin = (path: string, method = "GET", body?: unknown) => app.request(path, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const keyResponse = await admin("/admin/keys", "POST", { name: "test" });
  const key = (await keyResponse.json() as { key: { id: string; key: string } }).key;
  const seedChannel = async (id: string, type = "moemail", settingsJson: Record<string, unknown> = {}) => {
    await stores.upstreams.create({ id, name: id, type, baseUrl: `https://${id}.test`, apiKeyEnc: await deps.crypto.encrypt("mock-upstream-key"), settingsJson });
    await stores.upstreams.replaceDomains(id, [{ domain: "shared.test", upstreamId: id, isPrivate: false, enabled: true, syncedAt: new Date() }]);
  };
  const seedMailbox = () => stores.mailboxes.create({ id: "box", upstreamId: "channel", upstreamMailboxId: "upstream-box", address: "box@shared.test", localPart: "box", domain: "shared.test", apiKeyId: key.id, credentialsEnc: null, passwordEnc: null, expiresAt: null });
  return { sqlite, stores, app, admin, key, seedChannel, seedMailbox };
}

const brokenReplies: Array<[string, () => Response]> = [
  ["body disconnect", () => new Response(new ReadableStream({ start(c) { c.error(new Error("disconnected")); } }))],
  ["body timeout", () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"success":')); } }))],
  ["truncated JSON", () => new Response('{"success":')],
  ["missing success flag", () => Response.json({})],
  ["invalid envelope", () => Response.json(null)],
  ["business failure", () => Response.json({ success: false, error: "delete failed", errorCode: "BUSY" })],
];
for (const [label, response] of brokenReplies) {
  test(`YYDS ${label} preserves strict-delete registration and reports message deletion failure`, async () => {
    const f = await fixture(async () => response());
    try {
      await f.seedChannel("channel", "yydsmail"); await f.seedMailbox();
      for (const path of ["/v1/mailboxes/box/messages/message-1", "/v1/mailboxes/box"]) {
        const res = await f.app.request(path, { method: "DELETE", headers: { Authorization: f.key.key } });
        assert.equal(res.status, 502, label);
        assert.equal((await res.json() as { error: { code: string } }).error.code, "UPSTREAM_ERROR");
      }
      assert(await f.stores.mailboxes.get("box"));
      assert.deepEqual(await f.stores.orphans.list(10), []);
    } finally { f.sqlite.close(); }
  });
}

test("YYDS completed empty responses and success envelopes still allow deletion; force failures leave evidence", async () => {
  for (const response of [() => new Response(null, { status: 204 }), () => new Response(""), () => Response.json({ success: true })]) {
    const f = await fixture(async () => response());
    try {
      await f.seedChannel("channel", "yydsmail"); await f.seedMailbox();
      const res = await f.app.request("/v1/mailboxes/box", { method: "DELETE", headers: { Authorization: f.key.key } });
      assert.equal(res.status, 204);
      assert.equal(await f.stores.mailboxes.get("box"), null);
    } finally { f.sqlite.close(); }
  }
  const f = await fixture(async () => new Response("not json"));
  try {
    await f.seedChannel("channel", "yydsmail"); await f.seedMailbox();
    const res = await f.app.request("/v1/mailboxes/box?force=1", { method: "DELETE", headers: { Authorization: f.key.key } });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { upstreamDeleted: boolean }).upstreamDeleted, false);
    assert.equal((await f.stores.orphans.list(10)).length, 1);
  } finally { f.sqlite.close(); }
});

test("MoeMail scan exhaustion cannot establish another channel as the unique owner", async () => {
  const f = await fixture(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "large.test") {
      const page = Number(url.searchParams.get("cursor") || 1);
      return Response.json({ emails: [{ id: `other-${page}`, address: `other-${page}@shared.test` }], nextCursor: String(page + 1) });
    }
    return Response.json({ emails: [{ id: "target", address: "target@shared.test" }], nextCursor: null });
  });
  try {
    await f.seedChannel("large"); await f.seedChannel("small");
    const importAddress = (upstreamId?: string) => f.admin("/admin/mailboxes/import", "POST", { addresses: ["target@shared.test"], upstreamId });
    const uncertain = await (await importAddress()).json() as { imported: unknown[]; failed: Array<{ code: string }> };
    assert.deepEqual(uncertain.imported, []);
    assert.equal(uncertain.failed[0]!.code, "UPSTREAM_REQUIRED");
    assert.equal(await f.stores.mailboxes.findByAddress("target@shared.test"), null);
    const incomplete = await (await importAddress("large")).json() as { failed: Array<{ code: string }> };
    assert.equal(incomplete.failed[0]!.code, "UPSTREAM_UNAVAILABLE");
    const explicit = await (await importAddress("small")).json() as { imported: Array<{ upstreamId: string }> };
    assert.equal(explicit.imported[0]!.upstreamId, "small");
  } finally { f.sqlite.close(); }
});

test("MoeMail returns NOT_FOUND only after the final page, still accepts a match on page 20", async () => {
  const cfg = { id: "channel", type: "moemail", baseUrl: "https://moe.test", apiKey: "test", settings: {} };
  for (const found of [false, true]) {
    let calls = 0;
    const adapter = new MoeMailAdapter({ fetchFn: async () => {
      calls++;
      return Response.json({ emails: found && calls === 20 ? [{ id: "last", address: "last@shared.test" }] : [], nextCursor: calls === 20 ? null : String(calls + 1) });
    } });
    if (found) assert.equal((await adapter.resolveByAddress(cfg, "last@shared.test")).upstreamMailboxId, "last");
    else await assert.rejects(adapter.resolveByAddress(cfg, "last@shared.test"), { code: "NOT_FOUND" });
    assert.equal(calls, 20);
  }
});

test("MoeMail repeated cursors and malformed lists remain indeterminate", async () => {
  const cfg = { id: "channel", type: "moemail", baseUrl: "https://moe.test", apiKey: "test", settings: {} };
  for (const data of [{ emails: [], nextCursor: "loop" }, { emails: [], nextCursor: 123 }, {}, null]) {
    let calls = 0;
    const adapter = new MoeMailAdapter({ fetchFn: async () => { calls++; return Response.json(data); } });
    await assert.rejects(adapter.resolveByAddress(cfg, "missing@shared.test"), { code: "UNAVAILABLE" });
    assert(calls <= 2);
  }
});

test("settings edits merge unrelated monitor changes, including removals and null values", async () => {
  const f = await fixture();
  try {
    const initial = { name: "channel", baseUrl: "https://channel.test", enabled: true, settings: { defaultExpiryMs: 86400000, removed: "old", nullable: "before", nested: { b: 2, a: 1 } } };
    await f.seedChannel("channel", "moemail", initial.settings);
    await f.admin("/admin/upstreams/channel/monitor", "PUT", { disabled: true, intervalMs: 600000, autoSyncDomains: false });
    const draft = { ...initial, settings: { defaultExpiryMs: 3600000, nullable: null, nested: { a: 1, b: 2 } } };
    const res = await f.admin("/admin/upstreams/channel", "PUT", changedUpstreamFields(initial, draft));
    assert.equal(res.status, 200);
    assert.deepEqual((await f.stores.upstreams.get("channel"))!.settingsJson, { ...draft.settings, monitorDisabled: true, monitorIntervalMs: 600000, autoSyncDomains: false });
  } finally { f.sqlite.close(); }
});

test("conflicting settings edits return 409 without partially saving name or secrets", async () => {
  const f = await fixture();
  try {
    await f.seedChannel("channel", "moemail", { defaultExpiryMs: 86400000 });
    const before = await f.stores.upstreams.get("channel");
    await f.admin("/admin/upstreams/channel", "PUT", { settings: { defaultExpiryMs: 3600000 } });
    const res = await f.admin("/admin/upstreams/channel", "PUT", { name: "lost-update", apiKey: "should-not-save", settings: { defaultExpiryMs: 259200000 }, expectedSettings: { defaultExpiryMs: 86400000 } });
    assert.equal(res.status, 409);
    const after = (await f.stores.upstreams.get("channel"))!;
    assert.equal(after.name, "channel");
    assert.equal(after.apiKeyEnc, before!.apiKeyEnc);
    assert.deepEqual(after.settingsJson, { defaultExpiryMs: 3600000 });
    assert.equal((await f.admin("/admin/upstreams/channel", "PUT", { expectedSettings: {} })).status, 400);
  } finally { f.sqlite.close(); }
});

test("a settings change between read and write is merged atomically on retry", async () => {
  const f = await fixture();
  try {
    await f.seedChannel("channel", "moemail", { defaultExpiryMs: 86400000 });
    const original = f.stores.upstreams.updateIfSettingsMatch;
    let writes = 0;
    f.stores.upstreams.updateIfSettingsMatch = async (id, patch, expected) => {
      if (++writes === 1) await f.stores.upstreams.update(id, { settingsJson: { ...expected, monitorDisabled: true } });
      return original(id, patch, expected);
    };
    const res = await f.admin("/admin/upstreams/channel", "PUT", { settings: { defaultExpiryMs: 3600000 }, expectedSettings: { defaultExpiryMs: 86400000 } });
    assert.equal(res.status, 200);
    assert.equal(writes, 2);
    assert.deepEqual((await f.stores.upstreams.get("channel"))!.settingsJson, { defaultExpiryMs: 3600000, monitorDisabled: true });
  } finally { f.sqlite.close(); }
});

test("monitor read-modify-write preserves an adapter edit that arrives concurrently", async () => {
  const f = await fixture();
  try {
    await f.seedChannel("channel", "moemail", { defaultExpiryMs: 86400000 });
    const original = f.stores.upstreams.updateIfSettingsMatch;
    let writes = 0;
    f.stores.upstreams.updateIfSettingsMatch = async (id, patch, expected) => {
      if (++writes === 1) await f.stores.upstreams.update(id, { settingsJson: { ...expected, defaultExpiryMs: 3600000 } });
      return original(id, patch, expected);
    };
    const res = await f.admin("/admin/upstreams/channel/monitor", "PUT", { disabled: true });
    assert.equal(res.status, 200);
    assert.deepEqual((await f.stores.upstreams.get("channel"))!.settingsJson, { defaultExpiryMs: 3600000, monitorDisabled: true });
  } finally { f.sqlite.close(); }
});

test("deleted selected channels stay visible and can be explicitly removed without changing other restrictions", async () => {
  const f = await fixture();
  try {
    await f.seedChannel("removed"); await f.seedChannel("retained");
    await f.admin(`/admin/keys/${f.key.id}`, "PATCH", { channels: ["removed", "retained"] });
    assert.equal((await f.admin("/admin/upstreams/removed", "DELETE")).status, 204);
    const selected = (await f.stores.apiKeys.get(f.key.id))!.channels!;
    assert.deepEqual(selected, ["removed", "retained"]);
    const markup = renderToStaticMarkup(createElement(ChannelPicker, { upstreams: [{ id: "retained", name: "Retained", type: "moemail", baseUrl: "https://retained.test", enabled: true, hasApiKey: true, domainCount: 1, createdAt: "2026-11-19T00:00:00Z" }], selected, onChange: () => {} }));
    assert.match(markup, /移除失效渠道 removed/);
    assert.match(markup, /Retained/);
    const res = await f.admin(`/admin/keys/${f.key.id}`, "PATCH", { channels: selected.filter((id) => id !== "removed"), mailboxesPerHour: 120 });
    assert.equal(res.status, 200);
    assert.deepEqual((await f.stores.apiKeys.get(f.key.id))!.channels, ["retained"]);
    assert.equal((await f.stores.apiKeys.get(f.key.id))!.mailboxesPerHour, 120);
  } finally { f.sqlite.close(); }
});

test("failed channel loading never presents missing selections as removable deleted channels", () => {
  for (const state of [{ loading: true }, { error: "network error" }]) {
    const markup = renderToStaticMarkup(createElement(ChannelPicker, { upstreams: [], selected: ["keep"], onChange: () => {}, ...state }));
    assert.doesNotMatch(markup, /移除失效渠道/);
    assert.match(markup, /已限 1 个渠道/);
  }
});

test("millisecond intervals round-trip without phantom changes and persist for both settings", async () => {
  for (const ms of [60000, 60001, 65001, 65002, 127999, 128001, 300001, 3600001, 86399999, 86400000]) {
    assert.equal(secondsToMilliseconds(String(ms / 1000)), ms);
    assert.equal(parseIntervalSeconds(String(ms / 1000), "间隔"), ms);
  }
  const f = await fixture();
  try {
    const res = await f.admin("/admin/settings", "PATCH", { healthCheckIntervalMs: parseIntervalSeconds("65.001", "验活间隔"), mailboxCleanupIntervalMs: parseIntervalSeconds("65.002", "清理间隔") });
    assert.equal(res.status, 200);
    const saved = (await f.stores.settings.get())!;
    assert.equal(secondsToMilliseconds(String(saved.healthCheckIntervalMs! / 1000)), saved.healthCheckIntervalMs);
    assert.equal(secondsToMilliseconds(String(saved.mailboxCleanupIntervalMs! / 1000)), saved.mailboxCleanupIntervalMs);
  } finally { f.sqlite.close(); }
});

test("interval normalization does not silently round invalid values into valid settings", () => {
  for (const value of ["", " ", "nope", "Infinity", "65.0015", "59.999", "86400.001", "-65", "1e30"]) {
    assert.throws(() => parseIntervalSeconds(value, "间隔"), /60 至 86400/);
  }
});
