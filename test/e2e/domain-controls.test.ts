import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { resolve } from "node:path";
import { createDrizzleStores } from "../../src/adapters/stores/drizzle";
import { createWebCryptoCipher } from "../../src/adapters/crypto/webcrypto";
import { buildDeps } from "../../src/bootstrap";
import { createApp } from "../../src/core/app";
import { runMigrations } from "../../src/db/migrate-node";
import { registerDummyAdapter } from "../helpers";

/**
 * 域名管控 e2e：管理端开/关域名调用 + key 域名白名单。
 */

const ADMIN_PASSWORD = "test-admin-pw";
const MASTER_KEY = "test-master-key-0123456789";

function makeApp() {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite, resolve("migrations"));
  const deps = buildDeps({
    stores: createDrizzleStores(drizzle(sqlite) as never),
    crypto: createWebCryptoCipher(MASTER_KEY),
    config: { adminPassword: ADMIN_PASSWORD, masterKey: MASTER_KEY },
  });
  registerDummyAdapter(deps);
  return createApp(deps);
}

interface DomainDetail {
  domain: string;
  enabled: boolean;
  isPrivate: boolean;
}

describe("域名管控：管理端开/关域名调用", () => {
  let app: ReturnType<typeof makeApp>;
  let cookie: string;
  let apiKey: string;
  let upstreamId: string;

  beforeEach(async () => {
    app = makeApp();
    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const upRes = await admin("POST", "/admin/upstreams", {
      name: "双域名上游",
      type: "dummy",
      baseUrl: "memory://dual",
      settings: { domains: ["a.test", "b.test"] },
    });
    upstreamId = ((await upRes.json()) as { upstream: { id: string } }).upstream.id;
    const keyRes = await admin("POST", "/admin/keys", { name: "k" });
    apiKey = ((await keyRes.json()) as { key: { key: string } }).key.key;
  });

  async function admin(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function detailDomains(): Promise<DomainDetail[]> {
    const res = await admin("GET", `/admin/upstreams/${upstreamId}`);
    const { upstream } = (await res.json()) as { upstream: { domains: DomainDetail[] } };
    return upstream.domains;
  }

  async function createMailbox(domain?: string) {
    return app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(domain ? { domain, localPart: `u${Math.random().toString(36).slice(2, 8)}` } : {}),
    });
  }

  async function v1Domains(): Promise<string[]> {
    const res = await app.request("/v1/domains", { headers: { Authorization: `Bearer ${apiKey}` } });
    const { domains } = (await res.json()) as { domains: { domain: string }[] };
    return domains.map((d) => d.domain);
  }

  it("停用后：/v1/domains 不列出、创建被拒 403；重新启用后恢复", async () => {
    // 停用 b.test
    const off = await admin("PUT", `/admin/upstreams/${upstreamId}/domains/b.test`, { enabled: false });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { domain: DomainDetail }).domain.enabled).toBe(false);

    expect(await v1Domains()).toEqual(["a.test"]);

    const rejected = await createMailbox("b.test");
    expect(rejected.status).toBe(403);
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_DISABLED");

    // 未指定域名时只在启用域名中随机挑选
    for (let i = 0; i < 3; i++) {
      const res = await createMailbox();
      expect(res.status).toBe(201);
      const { mailbox } = (await res.json()) as { mailbox: { address: string } };
      expect(mailbox.address.endsWith("@a.test")).toBe(true);
    }

    // 重新启用 → 恢复可用
    const on = await admin("PUT", `/admin/upstreams/${upstreamId}/domains/b.test`, { enabled: true });
    expect(((await on.json()) as { domain: DomainDetail }).domain.enabled).toBe(true);
    const ok = await createMailbox("b.test");
    expect(ok.status).toBe(201);

    // 存量邮箱不受开关影响（a.test 建的仍可读）
    const list = await app.request("/v1/domains", { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(list.status).toBe(200);
  });

  it("停用的域名：管理端详情仍列出（enabled=false）；未知域名 toggle 返回 404", async () => {
    await admin("PUT", `/admin/upstreams/${upstreamId}/domains/a.test`, { enabled: false });
    const domains = await detailDomains();
    expect(domains.find((d) => d.domain === "a.test")!.enabled).toBe(false);
    expect(domains.find((d) => d.domain === "b.test")!.enabled).toBe(true);

    const missing = await admin("PUT", `/admin/upstreams/${upstreamId}/domains/none.test`, { enabled: false });
    expect(missing.status).toBe(404);
  });

  it("GET /admin/domains 返回全量域名（含停用与归属上游信息）", async () => {
    await admin("PUT", `/admin/upstreams/${upstreamId}/domains/b.test`, { enabled: false });
    const res = await admin("GET", "/admin/domains");
    const { domains } = (await res.json()) as {
      domains: { domain: string; upstreamName: string; upstreamEnabled: boolean; enabled: boolean }[];
    };
    const b = domains.find((d) => d.domain === "b.test")!;
    expect(b.enabled).toBe(false);
    expect(b.upstreamName).toBe("双域名上游");
    expect(b.upstreamEnabled).toBe(true);
    expect(domains).toHaveLength(2);
  });

  it("同步域名保留停用状态；新增域名默认启用", async () => {
    await admin("PUT", `/admin/upstreams/${upstreamId}/domains/b.test`, { enabled: false });

    // 上游新增 c.test 后重新同步
    await admin("PUT", `/admin/upstreams/${upstreamId}`, {
      settings: { domains: ["a.test", "b.test", "c.test"] },
    });
    const sync = await admin("POST", `/admin/upstreams/${upstreamId}/sync-domains`);
    expect(sync.status).toBe(200);

    const domains = await detailDomains();
    expect(domains.find((d) => d.domain === "b.test")!.enabled).toBe(false); // 保留停用
    expect(domains.find((d) => d.domain === "c.test")!.enabled).toBe(true); // 新域名默认启用
    expect(domains.find((d) => d.domain === "a.test")!.enabled).toBe(true);
  });

  it("全部域名停用后，未指定域名的创建返回 400 DOMAIN_NOT_ROUTED", async () => {
    await admin("PUT", `/admin/upstreams/${upstreamId}/domains/a.test`, { enabled: false });
    await admin("PUT", `/admin/upstreams/${upstreamId}/domains/b.test`, { enabled: false });

    const res = await createMailbox();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_NOT_ROUTED");
  });

  it("创建上游时 enabled=false 持久化并阻止路由，手动启用后才可用", async () => {
    const created = await admin("POST", "/admin/upstreams", {
      name: "disabled", type: "dummy", baseUrl: "memory://disabled", enabled: false,
      settings: { domains: ["disabled.test"] },
    });
    expect(created.status).toBe(201);
    const { upstream } = await created.json() as { upstream: { id: string; enabled: boolean } };
    expect(upstream.enabled).toBe(false);
    const detail = await admin("GET", `/admin/upstreams/${upstream.id}`);
    expect(await detail.json()).toMatchObject({ upstream: { enabled: false } });
    expect(await v1Domains()).not.toContain("disabled.test");
    const blocked = await createMailbox("disabled.test");
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({ error: { code: "DOMAIN_NOT_ROUTED" } });
    await admin("PUT", `/admin/upstreams/${upstream.id}`, { enabled: true });
    expect((await createMailbox("disabled.test")).status).toBe(201);
  });
});

describe("域名同步并发", () => {
  it.each([false, true])("同步不覆盖同时设置的 enabled=%s", async (enabled) => {
    const sqlite = new Database(":memory:");
    try {
      runMigrations(sqlite, resolve("migrations"));
      const stores = createDrizzleStores(drizzle(sqlite) as never);
      await stores.upstreams.create({
        id: "concurrent", name: "concurrent", type: "dummy", baseUrl: "memory://concurrent",
        apiKeyEnc: null, settingsJson: {},
      });
      await stores.upstreams.replaceDomains("concurrent", [{
        domain: "concurrent.test", upstreamId: "concurrent", isPrivate: false, enabled: true, syncedAt: new Date(),
      }]);
      for (const batch of [false, true]) {
        await stores.upstreams.setDomainEnabled("concurrent", "concurrent.test", !enabled);
        const snapshot = await stores.upstreams.listDomainsByUpstream("concurrent");
        await Promise.all([
          stores.upstreams.replaceDomains("concurrent", snapshot),
          batch
            ? stores.upstreams.setAllDomainsEnabled("concurrent", enabled)
            : stores.upstreams.setDomainEnabled("concurrent", "concurrent.test", enabled),
        ]);
        expect((await stores.upstreams.getDomain("concurrent", "concurrent.test"))!.enabled).toBe(enabled);
      }
    } finally {
      sqlite.close();
    }
  });
});

describe("key 域名白名单", () => {
  let app: ReturnType<typeof makeApp>;
  let cookie: string;

  beforeEach(async () => {
    app = makeApp();
    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    await admin("POST", "/admin/upstreams", {
      name: "u-a",
      type: "dummy",
      baseUrl: "memory://ua",
      settings: { domains: ["a.test"] },
    });
    await admin("POST", "/admin/upstreams", {
      name: "u-b",
      type: "dummy",
      baseUrl: "memory://ub",
      settings: { domains: ["b.test"] },
    });
  });

  async function admin(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function createMailbox(key: string, domain?: string) {
    return app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(domain ? { domain, localPart: `u${Math.random().toString(36).slice(2, 8)}` } : {}),
    });
  }

  it("白名单内可建、白名单外 403 DOMAIN_NOT_ALLOWED；/v1/domains 按白名单过滤", async () => {
    const keyRes = await admin("POST", "/admin/keys", { name: "limited", domains: [" A.TEST "] });
    expect(keyRes.status).toBe(201);
    const created = ((await keyRes.json()) as { key: { key: string; domains: string[] | null } }).key;
    // 归一化：trim + 小写
    expect(created.domains).toEqual(["a.test"]);

    // 签发响应与列表都带 domains
    const list = await admin("GET", "/admin/keys");
    const { keys } = (await list.json()) as { keys: { name: string; domains: string[] | null }[] };
    expect(keys[0]!.domains).toEqual(["a.test"]);

    const ok = await createMailbox(created.key, "a.test");
    expect(ok.status).toBe(201);

    const denied = await createMailbox(created.key, "b.test");
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_NOT_ALLOWED");

    // 域名列表按白名单过滤
    const domainsRes = await app.request("/v1/domains", { headers: { Authorization: `Bearer ${created.key}` } });
    const { domains } = (await domainsRes.json()) as { domains: { domain: string }[] };
    expect(domains.map((d) => d.domain)).toEqual(["a.test"]);

    // 未指定域名时只在白名单内随机
    for (let i = 0; i < 3; i++) {
      const res = await createMailbox(created.key);
      const { mailbox } = (await res.json()) as { mailbox: { address: string } };
      expect(mailbox.address.endsWith("@a.test")).toBe(true);
    }
  });

  it("PATCH 更新白名单：数组替换、null/空数组清除限制、未知 key 404", async () => {
    const keyRes = await admin("POST", "/admin/keys", { name: "patch-me", domains: ["a.test"] });
    const { key: created } = (await keyRes.json()) as { key: { id: string; key: string } };

    // 换白名单 → b.test 可用，a.test 被拒
    const toB = await admin("PATCH", `/admin/keys/${created.id}`, { domains: ["b.test"] });
    expect(((await toB.json()) as { key: { domains: string[] | null } }).key.domains).toEqual(["b.test"]);
    expect((await createMailbox(created.key, "b.test")).status).toBe(201);
    expect((await createMailbox(created.key, "a.test")).status).toBe(403);

    // null 清除限制
    const cleared = await admin("PATCH", `/admin/keys/${created.id}`, { domains: null });
    expect(((await cleared.json()) as { key: { domains: string[] | null } }).key.domains).toBeNull();
    expect((await createMailbox(created.key, "a.test")).status).toBe(201);

    // 空数组同样视为不限制
    const emptied = await admin("PATCH", `/admin/keys/${created.id}`, { domains: [] });
    expect(((await emptied.json()) as { key: { domains: string[] | null } }).key.domains).toBeNull();

    const missing = await admin("PATCH", "/admin/keys/no-such-key", { domains: ["a.test"] });
    expect(missing.status).toBe(404);
  });

  it("域名停用与白名单双重校验：白名单内但域名停用 → 403 DOMAIN_DISABLED", async () => {
    const upRes = await admin("GET", "/admin/upstreams");
    const { upstreams } = (await upRes.json()) as { upstreams: { id: string }[] };
    await admin("PUT", `/admin/upstreams/${upstreams[0]!.id}/domains/a.test`, { enabled: false });

    const keyRes = await admin("POST", "/admin/keys", { name: "half", domains: ["a.test", "b.test"] });
    const { key } = ((await keyRes.json()) as { key: { key: string } }).key;

    const res = await createMailbox(key, "a.test");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_DISABLED");
    // 白名单内未停用的域名正常
    expect((await createMailbox(key, "b.test")).status).toBe(201);
  });
});

// ---------- 渠道白名单与渠道批量开关 ----------

describe("key 渠道白名单", () => {
  let app: ReturnType<typeof makeApp>;
  let cookie: string;
  let upstreamAId: string;
  let upstreamBId: string;

  beforeEach(async () => {
    app = makeApp();
    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const a = await admin("POST", "/admin/upstreams", {
      name: "渠道A", type: "dummy", baseUrl: "memory://ca", settings: { domains: ["a.test", "a2.test"] },
    });
    upstreamAId = ((await a.json()) as { upstream: { id: string } }).upstream.id;
    const b = await admin("POST", "/admin/upstreams", {
      name: "渠道B", type: "dummy", baseUrl: "memory://cb", settings: { domains: ["b.test"] },
    });
    upstreamBId = ((await b.json()) as { upstream: { id: string } }).upstream.id;
  });

  async function admin(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function createMailbox(key: string, domain?: string) {
    return app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(domain ? { domain, localPart: `u${Math.random().toString(36).slice(2, 8)}` } : {}),
    });
  }

  it("渠道白名单内可建、渠道外 403 CHANNEL_NOT_ALLOWED；/v1/domains 按渠道过滤", async () => {
    const keyRes = await admin("POST", "/admin/keys", { name: "chan", channels: [upstreamAId] });
    const created = ((await keyRes.json()) as { key: { key: string; channels: string[] | null } }).key;
    expect(created.channels).toEqual([upstreamAId]);

    const ok = await createMailbox(created.key, "a2.test");
    expect(ok.status).toBe(201);
    const denied = await createMailbox(created.key, "b.test");
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("CHANNEL_NOT_ALLOWED");

    const domainsRes = await app.request("/v1/domains", { headers: { Authorization: `Bearer ${created.key}` } });
    const { domains } = (await domainsRes.json()) as { domains: { domain: string }[] };
    expect(domains.map((d) => d.domain).sort()).toEqual(["a.test", "a2.test"]);

    // 未指定域名时只在渠道白名单内随机
    for (let i = 0; i < 3; i++) {
      const res = await createMailbox(created.key);
      const { mailbox } = (await res.json()) as { mailbox: { address: string } };
      expect(mailbox.address.endsWith("@a.test") || mailbox.address.endsWith("@a2.test")).toBe(true);
    }
  });

  it("渠道白名单自动覆盖该渠道后续同步的新域名", async () => {
    const keyRes = await admin("POST", "/admin/keys", { name: "chan", channels: [upstreamAId] });
    const created = ((await keyRes.json()) as { key: { key: string } }).key;

    // 渠道 A 后来新增域名（重新同步）→ 无需改 key 即可用
    await admin("PUT", `/admin/upstreams/${upstreamAId}`, {
      settings: { domains: ["a.test", "a2.test", "anew.test"] },
    });
    await admin("POST", `/admin/upstreams/${upstreamAId}/sync-domains`);
    const res = await createMailbox(created.key, "anew.test");
    expect(res.status).toBe(201);
  });

  it("PATCH channels 数组替换、null 清除；未知渠道 id 400", async () => {
    const keyRes = await admin("POST", "/admin/keys", { name: "patch-chan", channels: [upstreamAId] });
    const created = ((await keyRes.json()) as { key: { id: string; key: string } }).key;

    const toB = await admin("PATCH", `/admin/keys/${created.id}`, { channels: [upstreamBId] });
    expect(((await toB.json()) as { key: { channels: string[] | null } }).key.channels).toEqual([upstreamBId]);
    expect((await createMailbox(created.key, "b.test")).status).toBe(201);
    expect((await createMailbox(created.key, "a.test")).status).toBe(403);

    const cleared = await admin("PATCH", `/admin/keys/${created.id}`, { channels: null });
    expect(((await cleared.json()) as { key: { channels: string[] | null } }).key.channels).toBeNull();
    expect((await createMailbox(created.key, "a.test")).status).toBe(201);

    const unknown = await admin("PATCH", `/admin/keys/${created.id}`, { channels: ["no-such-channel"] });
    expect(unknown.status).toBe(400);
  });

  it("域名白名单与渠道白名单同时配置时取交集", async () => {
    const keyRes = await admin("POST", "/admin/keys", {
      name: "both", domains: ["a.test", "b.test"], channels: [upstreamBId],
    });
    const created = ((await keyRes.json()) as { key: { key: string } }).key;

    // b.test 在域名白名单且属于渠道 B → 放行
    expect((await createMailbox(created.key, "b.test")).status).toBe(201);
    // a.test 在域名白名单但渠道不符 → 403
    const denied = await createMailbox(created.key, "a.test");
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("CHANNEL_NOT_ALLOWED");
  });
});

describe("渠道域名批量开关", () => {
  let app: ReturnType<typeof makeApp>;
  let cookie: string;
  let apiKey: string;
  let upstreamId: string;

  beforeEach(async () => {
    app = makeApp();
    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const up = await admin("POST", "/admin/upstreams", {
      name: "批量渠道", type: "dummy", baseUrl: "memory://batch", settings: { domains: ["x1.test", "x2.test", "x3.test"] },
    });
    upstreamId = ((await up.json()) as { upstream: { id: string } }).upstream.id;
    const keyRes = await admin("POST", "/admin/keys", { name: "k" });
    apiKey = ((await keyRes.json()) as { key: { key: string } }).key.key;
  });

  async function admin(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("一键停用渠道全部域名 → 全部 403；一键恢复 → 可用；上游实例仍可读", async () => {
    const off = await admin("PUT", `/admin/upstreams/${upstreamId}/domains`, { enabled: false });
    expect(((await off.json()) as { affected: number }).affected).toBe(3);

    for (const domain of ["x1.test", "x2.test"]) {
      const res = await app.request("/v1/mailboxes", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ domain, localPart: `u${Math.random().toString(36).slice(2, 8)}` }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_DISABLED");
    }

    // 批量停用只挡创建：上游实例本身仍在（管理端可见、上游未停用）
    const upstreams = (await (await admin("GET", "/admin/upstreams")).json()) as {
      upstreams: { id: string; enabled: boolean }[];
    };
    expect(upstreams.upstreams.find((u) => u.id === upstreamId)!.enabled).toBe(true);

    const on = await admin("PUT", `/admin/upstreams/${upstreamId}/domains`, { enabled: true });
    expect(((await on.json()) as { affected: number }).affected).toBe(3);
    const res = await app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "x1.test", localPart: "after-on" }),
    });
    expect(res.status).toBe(201);
  });
});

// ---------- D-01 回归：复合主键下多渠道共享域名 ----------

describe("多渠道共享同一域名（复合主键）", () => {
  let app: ReturnType<typeof makeApp>;
  let cookie: string;
  let upstreamAId: string;
  let upstreamBId: string;
  let apiKey: string;

  beforeEach(async () => {
    app = makeApp();
    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    // 渠道 A 先拥有 shared.test（先创建 → 主归属）；渠道 B 后同步也返回 shared.test + 自有域名。
    // 旧实现（domain 全局主键 + 全删全插）：B 同步时 INSERT 冲突 → B 的域名被清空且不回滚。
    const a = await admin("POST", "/admin/upstreams", {
      name: "渠道A", type: "dummy", baseUrl: "memory://sa", settings: { domains: ["shared.test"] },
    });
    upstreamAId = ((await a.json()) as { upstream: { id: string } }).upstream.id;
    const b = await admin("POST", "/admin/upstreams", {
      name: "渠道B", type: "dummy", baseUrl: "memory://sb", settings: { domains: ["only-b.test"] },
    });
    upstreamBId = ((await b.json()) as { upstream: { id: string } }).upstream.id;

    const keyRes = await admin("POST", "/admin/keys", { name: "k" });
    apiKey = ((await keyRes.json()) as { key: { key: string } }).key.key;
  });

  async function admin(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function domainsOf(upstreamId: string): Promise<string[]> {
    const res = await admin("GET", `/admin/upstreams/${upstreamId}`);
    const { upstream } = (await res.json()) as { upstream: { domains: { domain: string }[] } };
    return upstream.domains.map((d) => d.domain).sort();
  }

  it("渠道 B 同步含 A 已拥有的域名时不再冲突、不再清空 B 的域名", async () => {
    // B 第一次同步就返回 shared.test（模拟两个实例配了同一域名）
    await admin("PUT", `/admin/upstreams/${upstreamBId}`, {
      settings: { domains: ["only-b.test", "shared.test"] },
    });
    const sync = await admin("POST", `/admin/upstreams/${upstreamBId}/sync-domains`);
    expect(sync.status).toBe(200);

    // 旧实现会抛 UNIQUE constraint failed 且 B 域名表变空；现在两渠道都完整
    expect(await domainsOf(upstreamAId)).toEqual(["shared.test"]);
    expect(await domainsOf(upstreamBId)).toEqual(["only-b.test", "shared.test"]);
  });

  it("B 后续同步只保留自身集合，不动 A 的行；A 再同步也互不影响", async () => {
    await admin("PUT", `/admin/upstreams/${upstreamBId}`, {
      settings: { domains: ["only-b.test", "shared.test"] },
    });
    await admin("POST", `/admin/upstreams/${upstreamBId}/sync-domains`);
    // B 后来不再有 shared.test → 只删 B 自己的行，A 的行保留
    await admin("PUT", `/admin/upstreams/${upstreamBId}`, { settings: { domains: ["only-b.test"] } });
    const sync2 = await admin("POST", `/admin/upstreams/${upstreamBId}/sync-domains`);
    expect(sync2.status).toBe(200);
    expect(await domainsOf(upstreamAId)).toEqual(["shared.test"]);
    expect(await domainsOf(upstreamBId)).toEqual(["only-b.test"]);

    // A 再同步仍保留 shared.test（自己的行不被 B 的变化波及）
    await admin("POST", `/admin/upstreams/${upstreamAId}/sync-domains`);
    expect(await domainsOf(upstreamAId)).toEqual(["shared.test"]);
  });

  it("重复同步幂等：不产生重复行、不报错", async () => {
    await admin("PUT", `/admin/upstreams/${upstreamBId}`, {
      settings: { domains: ["only-b.test", "shared.test"] },
    });
    for (let i = 0; i < 3; i++) {
      const sync = await admin("POST", `/admin/upstreams/${upstreamBId}/sync-domains`);
      expect(sync.status).toBe(200);
    }
    expect(await domainsOf(upstreamBId)).toEqual(["only-b.test", "shared.test"]);
    expect(await domainsOf(upstreamAId)).toEqual(["shared.test"]);
  });

  it("统一 API 候选感知：不受限 key 路由到最早的启用候选；主归属停用后落到次候选，全停用才 403", async () => {
    // 让 B 也登记 shared.test（构成双候选）
    await admin("PUT", `/admin/upstreams/${upstreamBId}`, {
      settings: { domains: ["only-b.test", "shared.test"] },
    });
    await admin("POST", `/admin/upstreams/${upstreamBId}/sync-domains`);

    const res = await app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "shared.test", localPart: `u${Math.random().toString(36).slice(2, 8)}` }),
    });
    expect(res.status).toBe(201);
    const { mailbox } = (await res.json()) as { mailbox: { upstreamId: string; address: string } };
    expect(mailbox.upstreamId).toBe(upstreamAId); // 渠道 A 先创建 → 最早候选

    // 主归属（A）停用 shared.test：候选感知下不受影响，路由到仍启用的 B
    await admin("PUT", `/admin/upstreams/${upstreamAId}/domains/shared.test`, { enabled: false });
    const ok = await app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "shared.test", localPart: "x123" }),
    });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { mailbox: { upstreamId: string } }).mailbox.upstreamId).toBe(upstreamBId);

    // 全部候选都停用 → 403 DOMAIN_DISABLED
    await admin("PUT", `/admin/upstreams/${upstreamBId}/domains/shared.test`, { enabled: false });
    const denied = await app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "shared.test", localPart: "x124" }),
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_DISABLED");
  });

  it("逐渠道独立停用：停用 B 名下的 shared.test 不影响 A；A 路由创建照常", async () => {
    // B 名下登记 shared.test，然后只停用 B 的这一行
    await admin("PUT", `/admin/upstreams/${upstreamBId}`, {
      settings: { domains: ["only-b.test", "shared.test"] },
    });
    await admin("POST", `/admin/upstreams/${upstreamBId}/sync-domains`);
    const off = await admin("PUT", `/admin/upstreams/${upstreamBId}/domains/shared.test`, { enabled: false });
    expect(off.status).toBe(200);

    // B 的同步状态、A 的行均不受影响：A 名下 shared.test 仍启用
    expect((await domainsOf(upstreamAId))).toEqual(["shared.test"]);
    const bDetail = (await (await admin("GET", `/admin/upstreams/${upstreamBId}`)).json()) as {
      upstream: { domains: { domain: string; enabled: boolean }[] };
    };
    const bShared = bDetail.upstream.domains.find((d) => d.domain === "shared.test")!;
    expect(bShared.enabled).toBe(false);

    // 统一 API 路由到主归属 A → 创建照常
    const viaApi = await app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "shared.test", localPart: `u${Math.random().toString(36).slice(2, 8)}` }),
    });
    expect(viaApi.status).toBe(201);
    expect(((await viaApi.json()) as { mailbox: { upstreamId: string } }).mailbox.upstreamId).toBe(upstreamAId);
  });
});

// ---------- R-01/R-02 回归：受限 key + 共享域名 + 逐渠道停用的候选感知选主 ----------

describe("候选感知选主：受限 key 与共享域名", () => {
  let app: ReturnType<typeof makeApp>;
  let cookie: string;
  let upstreamAId: string;
  let upstreamBId: string;

  beforeEach(async () => {
    app = makeApp();
    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    // A 先建（登记 shared.test），B 后建并也登记 shared.test —— 旧全局选主会选到 A
    const a = await admin("POST", "/admin/upstreams", {
      name: "渠道A", type: "dummy", baseUrl: "memory://ra", settings: { domains: ["shared.test"] },
    });
    upstreamAId = ((await a.json()) as { upstream: { id: string } }).upstream.id;
    const b = await admin("POST", "/admin/upstreams", {
      name: "渠道B", type: "dummy", baseUrl: "memory://rb", settings: { domains: ["b-only.test", "shared.test"] },
    });
    upstreamBId = ((await b.json()) as { upstream: { id: string } }).upstream.id;
  });

  async function admin(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function createMailbox(key: string, domain: string) {
    return app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain, localPart: `u${Math.random().toString(36).slice(2, 8)}` }),
    });
  }

  async function makeChannelKey(channels: string[]): Promise<string> {
    const res = await admin("POST", "/admin/keys", { name: "ch-key", channels });
    return ((await res.json()) as { key: { key: string } }).key.key;
  }

  it("R-01：受限 key 用共享域名建箱成功，路由到白名单内的候选（不再 403 指错渠道）", async () => {
    const keyB = await makeChannelKey([upstreamBId]);

    // /v1/domains 宣告 shared.test 可用（属于 B）
    const domainsRes = await app.request("/v1/domains", { headers: { Authorization: `Bearer ${keyB}` } });
    const { domains } = (await domainsRes.json()) as { domains: { domain: string; upstreamId: string }[] };
    expect(domains.map((d) => d.domain).sort()).toEqual(["b-only.test", "shared.test"]);

    // 旧实现：全局选主选到 A（不在白名单）→ 403 CHANNEL_NOT_ALLOWED，错误指向渠道 A
    // 现在：候选感知在 B 的行上建箱成功
    const ok = await createMailbox(keyB, "shared.test");
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { mailbox: { upstreamId: string } }).mailbox.upstreamId).toBe(upstreamBId);
  });

  it("R-01 反面：域名不在任何白名单渠道 → 403 CHANNEL_NOT_ALLOWED（不再误报 DOMAIN_NOT_ALLOWED）", async () => {
    const keyA = await makeChannelKey([upstreamAId]);
    const denied = await createMailbox(keyA, "b-only.test");
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("CHANNEL_NOT_ALLOWED");
  });

  it("R-02：主归属（A）停用 shared.test 不影响白名单内的 B；B 停用后才 403 DOMAIN_DISABLED", async () => {
    const keyB = await makeChannelKey([upstreamBId]);
    // A 停用 shared.test（A 是全局最早创建的「主归属」）
    const off = await admin("PUT", `/admin/upstreams/${upstreamAId}/domains/shared.test`, { enabled: false });
    expect(off.status).toBe(200);

    // key 仍可见并可用 B 的 shared.test（逐渠道独立）
    const ok = await createMailbox(keyB, "shared.test");
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { mailbox: { upstreamId: string } }).mailbox.upstreamId).toBe(upstreamBId);

    // B 也停用 → 该 key 没有任何可用候选 → 403 DOMAIN_DISABLED
    await admin("PUT", `/admin/upstreams/${upstreamBId}/domains/shared.test`, { enabled: false });
    const denied = await createMailbox(keyB, "shared.test");
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_DISABLED");
  });

  it("R-01/R-02 组合：渠道+域名双重白名单 key，共享域名逐渠道停用仍按交集选主", async () => {
    // 域名白名单含 shared.test 但渠道只限 B；A 已停用 shared.test
    await admin("PUT", `/admin/upstreams/${upstreamAId}/domains/shared.test`, { enabled: false });
    const keyRes = await admin("POST", "/admin/keys", {
      name: "both-r", domains: ["shared.test"], channels: [upstreamBId],
    });
    const keyB = ((await keyRes.json()) as { key: { key: string } }).key.key;

    const ok = await createMailbox(keyB, "shared.test");
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { mailbox: { upstreamId: string } }).mailbox.upstreamId).toBe(upstreamBId);

    // 域名白名单外 → DOMAIN_NOT_ALLOWED
    const outside = await createMailbox(keyB, "b-only.test");
    expect(outside.status).toBe(403);
    expect(((await outside.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_NOT_ALLOWED");
  });

  it("pickDomain 随机挑选与显式域名语义一致（都在交集内）", async () => {
    const keyB = await makeChannelKey([upstreamBId]);
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/v1/mailboxes", {
        method: "POST",
        headers: { Authorization: `Bearer ${keyB}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const { mailbox } = (await res.json()) as { mailbox: { upstreamId: string; address: string } };
      expect(mailbox.upstreamId).toBe(upstreamBId);
      expect(mailbox.address.endsWith("@b-only.test") || mailbox.address.endsWith("@shared.test")).toBe(true);
    }
  });
});

// ---------- D-04 回归：统一 API 邮箱归属隔离 ----------

describe("统一 API 邮箱归属隔离（D-04）", () => {
  let app: ReturnType<typeof makeApp>;
  let cookie: string;

  beforeEach(async () => {
    app = makeApp();
    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    await admin("POST", "/admin/upstreams", {
      name: "归属渠道", type: "dummy", baseUrl: "memory://owner", settings: { domains: ["own.test"] },
    });
  });

  async function admin(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function makeKey(name: string): Promise<string> {
    const res = await admin("POST", "/admin/keys", { name });
    return ((await res.json()) as { key: { key: string } }).key.key;
  }

  async function createMailbox(key: string): Promise<{ id: string; status: number }> {
    const res = await app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "own.test", localPart: `u${Math.random().toString(36).slice(2, 8)}` }),
    });
    const body = (await res.json()) as { mailbox?: { id: string } };
    return { id: body.mailbox?.id ?? "", status: res.status };
  }

  it("key A 建的邮箱，key B 读取/删除一律 404（不泄露存在性）；A 自己可读可删", async () => {
    const keyA = await makeKey("key-a");
    const keyB = await makeKey("key-b");
    const { id, status } = await createMailbox(keyA);
    expect(status).toBe(201);

    // B 读详情 / 列消息 / 删邮箱 → 404
    for (const method of ["GET", "DELETE"]) {
      const res = await app.request(`/v1/mailboxes/${id}`, { method, headers: { Authorization: `Bearer ${keyB}` } });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MAILBOX_NOT_FOUND");
    }
    const msgs = await app.request(`/v1/mailboxes/${id}/messages`, { headers: { Authorization: `Bearer ${keyB}` } });
    expect(msgs.status).toBe(404);

    // A 自己正常
    const mine = await app.request(`/v1/mailboxes/${id}`, { headers: { Authorization: `Bearer ${keyA}` } });
    expect(mine.status).toBe(200);
  });

  it("同一 key 自建的邮箱可读可删（无回归）", async () => {
    const keyA = await makeKey("key-a");
    const { id, status } = await createMailbox(keyA);
    expect(status).toBe(201);
    const del = await app.request(`/v1/mailboxes/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${keyA}` } });
    expect(del.status).toBe(204);
  });
});

// ---------- S-02 / S-03 回归 ----------

describe("S-02 错误归因与 S-03 去重/均等挑选", () => {
  let app: ReturnType<typeof makeApp>;
  let cookie: string;
  let upstreamAId: string;
  let upstreamBId: string;
  let apiKey: string;

  beforeEach(async () => {
    app = makeApp();
    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    // A 有共享域名 shared.test + 独享 a-only.test；B、C 也登记 shared.test
    const a = await admin("POST", "/admin/upstreams", {
      name: "A", type: "dummy", baseUrl: "memory://s2a", settings: { domains: ["shared.test", "a-only.test"] },
    });
    upstreamAId = ((await a.json()) as { upstream: { id: string } }).upstream.id;
    const b = await admin("POST", "/admin/upstreams", {
      name: "B", type: "dummy", baseUrl: "memory://s2b", settings: { domains: ["shared.test"] },
    });
    upstreamBId = ((await b.json()) as { upstream: { id: string } }).upstream.id;
    await admin("POST", "/admin/upstreams", {
      name: "C", type: "dummy", baseUrl: "memory://s2c", settings: { domains: ["shared.test"] },
    });

    const keyRes = await admin("POST", "/admin/keys", { name: "s2" });
    apiKey = ((await keyRes.json()) as { key: { key: string } }).key.key;
  });

  async function admin(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function createMailbox(domain?: string) {
    return app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(domain ? { domain, localPart: `u${Math.random().toString(36).slice(2, 8)}` } : {}),
    });
  }

  it("S-02：停用上游实例（域名行仍启用）→ 400 DOMAIN_NOT_ROUTED，不误报 DOMAIN_DISABLED", async () => {
    // 场景来自 §9.3：solo.test 只登记在 B。先给 B 同步上 solo.test（A/C 无此行）
    await admin("PUT", `/admin/upstreams/${upstreamBId}`, {
      settings: { domains: ["shared.test", "solo.test"] },
    });
    await admin("POST", `/admin/upstreams/${upstreamBId}/sync-domains`);

    // 停用 B 实例本身（solo.test 域名行仍是启用）
    const off = await admin("PUT", `/admin/upstreams/${upstreamBId}`, { enabled: false });
    expect(off.status).toBe(200);

    // 旧行为：403 DOMAIN_DISABLED（把上游停用误归因给域名开关）；
    // 现在：没有任何启用上游拥有该域名 → 400 DOMAIN_NOT_ROUTED
    const denied = await createMailbox("solo.test");
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_NOT_ROUTED");

    // 对照：B 恢复但 solo.test 域名行停用 → 403 DOMAIN_DISABLED（这时才是域名开关）
    await admin("PUT", `/admin/upstreams/${upstreamBId}`, { enabled: true });
    await admin("PUT", `/admin/upstreams/${upstreamBId}/domains/solo.test`, { enabled: false });
    const disabled = await createMailbox("solo.test");
    expect(disabled.status).toBe(403);
    expect(((await disabled.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_DISABLED");
  });

  it("S-02 域名停用对照：启用上游但域名行全停用 → 403 DOMAIN_DISABLED", async () => {
    await admin("PUT", `/admin/upstreams/${upstreamAId}/domains/shared.test`, { enabled: false });
    const cUpstreams = (await (await admin("GET", "/admin/upstreams")).json()) as {
      upstreams: { id: string }[];
    };
    const cId = cUpstreams.upstreams.find((u) => u.id !== upstreamAId && u.id !== upstreamBId)!.id;
    await admin("PUT", `/admin/upstreams/${cId}/domains/shared.test`, { enabled: false });
    await admin("PUT", `/admin/upstreams/${upstreamBId}/domains/shared.test`, { enabled: false });

    // 上游实例都在、域名行全停 → DOMAIN_DISABLED
    const denied = await createMailbox("shared.test");
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_DISABLED");
  });

  it("S-03：/v1/domains 对共享域名只返回一条（不重复）", async () => {
    const res = await app.request("/v1/domains", { headers: { Authorization: `Bearer ${apiKey}` } });
    const { domains } = (await res.json()) as { domains: { domain: string }[] };
    const all = domains.map((d) => d.domain);
    expect(new Set(all).size).toBe(all.length); // 无重复
    expect(all.sort()).toEqual(["a-only.test", "shared.test"]); // shared.test 只出现一次
  });

  it("S-03：不指定域名随机建箱对每个域名等概率（不被多渠道登记放大）", async () => {
    // 三个渠道都登记 shared.test，只有 A 有 a-only.test ——
    // 旧实现（行级等概率）会让 shared.test 占 ~3/4；按域名归组后应约 1/2
    const counts: Record<string, number> = {};
    for (let i = 0; i < 40; i++) {
      const res = await createMailbox();
      expect(res.status).toBe(201);
      const { mailbox } = (await res.json()) as { mailbox: { domain: string } };
      counts[mailbox.domain] = (counts[mailbox.domain] ?? 0) + 1;
    }
    const shared = counts["shared.test"] ?? 0;
    const aOnly = counts["a-only.test"] ?? 0;
    // 40 次里期望 20/20；允许 ±30% 抖动（14~26），旧实现 shared 会 ~30 次
    expect(shared).toBeGreaterThanOrEqual(14);
    expect(shared).toBeLessThanOrEqual(26);
    expect(aOnly).toBeGreaterThanOrEqual(14);
    expect(aOnly).toBeLessThanOrEqual(26);
  });
});
