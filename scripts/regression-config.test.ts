import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createDrizzleStores } from "../src/adapters/stores/drizzle";
import { createWebCryptoCipher } from "../src/adapters/crypto/webcrypto";
import { runMigrations } from "../src/db/migrate-node";
import { buildDeps } from "../src/bootstrap";
import { createApp } from "../src/core/app";
import worker from "../src/entries/worker";
import { changedUpstreamFields } from "../frontend/src/utils/upstream";
import { resolveApiBaseUrl } from "../frontend/src/api/url";
import viteConfig from "../frontend/vite.config";
import { createServer as createViteServer } from "../frontend/node_modules/vite/dist/node/index.js";

async function fixture() {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite, resolve("migrations"));
  const deps = buildDeps({
    stores: createDrizzleStores(drizzle(sqlite) as never),
    crypto: createWebCryptoCipher("config-test-master"),
    config: { masterKey: "config-test-master", adminPassword: "config-test-password", maxConcurrentRequestsPerKey: 1 },
  });
  const app = createApp(deps);
  const login = await app.request("/admin/session", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: deps.config.adminPassword }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const admin = (path: string, method = "GET", body?: unknown) => app.request(path, {
    method, headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const keyResponse = await admin("/admin/keys", "POST", { name: "config-test" });
  assert.equal(keyResponse.status, 201);
  const { key } = await keyResponse.json() as { key: { key: string } };
  return { sqlite, deps, app, admin, auth: { Authorization: `Bearer ${key.key}` } };
}

test("HEAD success and errors release the sole concurrency slot without reading a body", async () => {
  const f = await fixture();
  try {
    for (const [path, status] of [["/v1/domains", 200], ["/v1/mailboxes/missing", 404]] as const) {
      for (let i = 0; i < 3; i++) {
        const head = await f.app.request(path, { method: "HEAD", headers: f.auth });
        assert.equal(head.status, status);
        assert.equal(head.body, null);
        const next = await f.app.request("/v1/domains", { headers: f.auth });
        assert.equal(next.status, 200, "HEAD must not leave the key permanently rate limited");
        await next.text();
      }
    }
  } finally { f.sqlite.close(); }
});

test("HEAD still counts while its handler is running, then releases its slot", async () => {
  const f = await fixture();
  let finish!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const original = f.deps.stores.upstreams.listActiveDomains;
  f.deps.stores.upstreams.listActiveDomains = async () => { started(); await pending; return original(); };
  try {
    const head = f.app.request("/v1/domains", { method: "HEAD", headers: f.auth });
    await ready;
    const blocked = await f.app.request("/v1/domains", { headers: f.auth });
    assert.equal(blocked.status, 429);
    await blocked.text();
    finish();
    assert.equal((await head).status, 200);
    const next = await f.app.request("/v1/domains", { headers: f.auth });
    assert.equal(next.status, 200);
    await next.text();
  } finally { finish(); f.sqlite.close(); }
});

test("Workers deep links fetch the canonical SPA asset and preserve cache headers", async () => {
  const html = '<!doctype html><div id="root"></div>';
  const assetPaths: string[] = [];
  const env = {
    DB: {} as D1Database,
    MASTER_KEY: "worker-spa-regression-master",
    ADMIN_PASSWORD: "worker-spa-regression-password",
    ASSETS: { async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      assetPaths.push(path);
      // Cloudflare 默认 HTML handling 会将显式 index.html 重定向到根路径。
      if (path === "/index.html") return new Response(null, { status: 307, headers: { Location: "/" } });
      assert.equal(path, "/");
      const headers = { "Content-Type": "text/html; charset=utf-8", ETag: '"spa-v1"', "Cache-Control": "public, max-age=0, must-revalidate" };
      return request.headers.get("if-none-match") === '"spa-v1"'
        ? new Response(null, { status: 304, headers })
        : new Response(html, { headers });
    } } as unknown as Fetcher,
  };
  for (const path of ["/login", "/settings", "/upstreams", "/api-docs", "/deep/nested"]) {
    const res = await worker.fetch(new Request(`https://gateway.test${path}`), env);
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), html);
    assert.equal(res.headers.get("etag"), '"spa-v1"');
    assert.equal(res.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  }
  const cached = await worker.fetch(new Request("https://gateway.test/settings", { headers: { "If-None-Match": '"spa-v1"' } }), env);
  assert.equal(cached.status, 304);
  assert.equal(cached.body, null);
  assert.equal(cached.headers.get("etag"), '"spa-v1"');
  assert.deepEqual(assetPaths, Array(6).fill("/"));
  const info = await worker.fetch(new Request("https://gateway.test/api/info"), env);
  assert.equal(info.headers.get("content-type"), "application/json");
});

test("renaming from an open form preserves monitor changes saved after the form was loaded", async () => {
  const f = await fixture();
  try {
    await f.deps.stores.upstreams.create({ id: "channel", name: "original", type: "moemail", baseUrl: "https://upstream.test", apiKeyEnc: null, enabled: true, settingsJson: { defaultExpiryMs: 86400000 } });
    const initial = { name: "original", baseUrl: "https://upstream.test", enabled: true, settings: { defaultExpiryMs: 86400000 } };
    const monitor = await f.admin("/admin/upstreams/channel/monitor", "PUT", { disabled: true, intervalMs: 600000, autoSyncDomains: false });
    assert.equal(monitor.status, 200);
    const patch = changedUpstreamFields(initial, { ...initial, name: "renamed", settings: JSON.parse(JSON.stringify(initial.settings, null, 2)) });
    const saved = await f.admin("/admin/upstreams/channel", "PUT", patch);
    assert.equal(saved.status, 200);
    const row = await f.deps.stores.upstreams.get("channel");
    assert.equal(row!.name, "renamed");
    assert.deepEqual(row!.settingsJson, { defaultExpiryMs: 86400000, monitorDisabled: true, monitorIntervalMs: 600000, autoSyncDomains: false });
    assert.deepEqual(changedUpstreamFields(initial, initial), {});
    assert.deepEqual(changedUpstreamFields(initial, { ...initial, settings: {} }), { settings: {}, expectedSettings: initial.settings }, "explicitly clearing settings must still be saved with its edit baseline");
  } finally { f.sqlite.close(); }
});

test("API bases support same-origin, split deployment and reverse-proxy path prefixes", () => {
  assert.equal(resolveApiBaseUrl("", "https://admin.test"), "https://admin.test");
  assert.equal(resolveApiBaseUrl(" https://api.test/gateway/// ", "https://admin.test"), "https://api.test/gateway");
  assert.equal(resolveApiBaseUrl("/gateway/", "https://admin.test"), "https://admin.test/gateway");
  assert.equal(resolveApiBaseUrl("/", "https://admin.test"), "https://admin.test");
});

test("Vite forwards API examples while retaining similarly named SPA routes", async () => {
  const upstream = createHttpServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ forwarded: req.url, authorization: req.headers.authorization }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const proxy = Object.fromEntries(Object.entries(viteConfig.server!.proxy!).map(([route, options]) => [route, { ...(typeof options === "string" ? {} : options), target: `http://127.0.0.1:${address.port}` }]));
  const vite = await createViteServer({
    ...viteConfig, configFile: false, root: resolve("frontend"), logLevel: "silent",
    server: { ...viteConfig.server, proxy, host: "127.0.0.1", port: 0, watch: null, hmr: false },
  });
  try {
    await vite.listen();
    const serverAddress = vite.httpServer!.address();
    assert(serverAddress && typeof serverAddress !== "string");
    const base = `http://127.0.0.1:${serverAddress.port}`;
    for (const path of ["/admin/me", "/api/doc", "/v1/mailboxes", "/upstream/moemail/api/config"]) {
      const response = await fetch(`${base}${path}`, { headers: { Authorization: "Bearer test-key" } });
      assert.equal(response.headers.get("content-type"), "application/json");
      assert.deepEqual(await response.json(), { forwarded: path, authorization: "Bearer test-key" });
    }
    for (const path of ["/upstreams", "/api-docs"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type")!, /text\/html/);
      assert.match(await response.text(), /id="root"/);
    }
  } finally {
    await vite.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
