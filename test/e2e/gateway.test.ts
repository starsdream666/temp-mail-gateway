import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { resolve } from "node:path";
import { registerDummyAdapter } from "../helpers";
import { createDrizzleStores } from "../../src/adapters/stores/drizzle";
import { createWebCryptoCipher } from "../../src/adapters/crypto/webcrypto";
import { buildDeps } from "../../src/bootstrap";
import { createApp } from "../../src/core/app";
import { runMigrations } from "../../src/db/migrate-node";
import { hashApiKey } from "../../src/core/keys";
import type { GatewayDeps } from "../../src/core/app";
import type { UpstreamConfig } from "../../src/ports/upstream";

/**
 * 端到端（进程内）：sqlite 内存库 + Dummy 适配器。
 * 流程：登录 → 建上游 → 同步域名 → 签发 key → 建邮箱 → 投递假邮件 → 读消息 → 删邮箱。
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
  const dummy = registerDummyAdapter(deps);
  const app = createApp(deps);
  return { app, dummy, deps };
}

/** 构造与网关内一致的 dummy 上游配置（id 用上游实例 id） */
function dummyCfg(upstreamId: string): UpstreamConfig {
  return { id: upstreamId, type: "dummy", baseUrl: "memory://dummy", settings: {} };
}

describe("gateway e2e (dummy upstream)", () => {
  let app: ReturnType<typeof makeApp>["app"];
  let deps: GatewayDeps | undefined;
  let dummy: ReturnType<typeof registerDummyAdapter>;
  let cookie: string;
  let apiKey: string;

  beforeEach(async () => {
    const ctx = makeApp();
    app = ctx.app;
    deps = ctx.deps;
    dummy = ctx.dummy;
    dummy.reset();

    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(204);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });

  async function admin(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function createUpstream(name: string, domains: string[]): Promise<string> {
    const res = await admin("POST", "/admin/upstreams", {
      name,
      type: "dummy",
      baseUrl: `memory://${name}`,
      settings: { domains },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      upstream: { id: string; domainCount: number; domains: { domain: string }[] };
    };
    expect(body.upstream.domains.map((d) => d.domain)).toEqual(expect.arrayContaining(domains));
    // 回归：domainCount 曾误传邮箱数
    expect(body.upstream.domainCount).toBe(domains.length);
    return body.upstream.id;
  }

  it("上游列表的 domainCount 反映域名数而非邮箱数", async () => {
    await createUpstream("双域名上游", ["a.test", "b.test"]);

    const keyRes = await admin("POST", "/admin/keys", { name: "count" });
    const key = ((await keyRes.json()) as { key: { key: string } }).key.key;
    // 建两个邮箱，domainCount 不应被邮箱数污染
    for (const localPart of ["u1", "u2"]) {
      const res = await app.request("/v1/mailboxes", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ domain: "a.test", localPart }),
      });
      expect(res.status).toBe(201);
    }

    const list = await admin("GET", "/admin/upstreams");
    const { upstreams } = (await list.json()) as { upstreams: { domainCount: number }[] };
    expect(upstreams[0]!.domainCount).toBe(2);
  });

  it("签发的 API key 是完整 base64url，且可直接用于 /v1", async () => {
    await createUpstream("keycheck", ["k.test"]);
    const keyRes = await admin("POST", "/admin/keys", { name: "fmt" });
    const created = ((await keyRes.json()) as { key: { key: string; prefix: string } }).key;

    // 回归：曾因字节越界生成 "tmg_undefinedFundefined..." 这类残缺 key
    expect(created.key).toMatch(/^tmg_[A-Za-z0-9_-]{40,}$/);
    expect(created.key).not.toContain("undefined");
    expect(created.prefix).toBe(created.key.slice(0, 12));

    const ok = await app.request("/v1/domains", {
      headers: { Authorization: `Bearer ${created.key}` },
    });
    expect(ok.status).toBe(200);
  });

  it("全流程：建上游 → key → 邮箱 → 收信 → 删除", async () => {
    const upstreamId = await createUpstream("本地假上游", ["mail.test"]);

    // 签发网关 key（明文只出现一次）
    const keyRes = await admin("POST", "/admin/keys", { name: "e2e" });
    expect(keyRes.status).toBe(201);
    apiKey = ((await keyRes.json()) as { key: { key: string } }).key.key;
    expect(apiKey).toMatch(/^tmg_/);

    // 未带 key 访问被拒
    const noAuth = await app.request("/v1/domains");
    expect(noAuth.status).toBe(401);
    expect(((await noAuth.json()) as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");

    // 查域名（带 key），且能看出归属上游
    const domainsRes = await app.request("/v1/domains", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(domainsRes.status).toBe(200);
    const { domains } = (await domainsRes.json()) as { domains: { domain: string; upstreamId: string }[] };
    expect(domains.map((d) => d.domain)).toContain("mail.test");
    expect(domains.find((d) => d.domain === "mail.test")!.upstreamId).toBe(upstreamId);

    // 创建邮箱（指定域名 → 路由到该上游）
    const mbRes = await app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "mail.test", localPart: "e2e-user" }),
    });
    expect(mbRes.status).toBe(201);
    const { mailbox } = (await mbRes.json()) as { mailbox: { id: string; address: string } };
    expect(mailbox.address).toBe("e2e-user@mail.test");

    // 重复地址被拒
    const dup = await app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "mail.test", localPart: "e2e-user" }),
    });
    expect(dup.status).toBe(409);

    // 通过 dummy 的测试钩子投递邮件，再从统一 API 读出来
    const cfg = dummyCfg(upstreamId);
    dummy.deliver(cfg, `dm_e2e-user@mail.test`, {
      from: "noreply@example.com",
      subject: "你的验证码",
      text: "123456",
    });

    const listRes = await app.request(`/v1/mailboxes/${mailbox.id}/messages`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(listRes.status).toBe(200);
    const { messages } = (await listRes.json()) as { messages: { id: string; subject: string }[] };
    expect(messages).toHaveLength(1);
    expect(messages[0]!.subject).toBe("你的验证码");

    // 增量拉取：since 之后再投一封
    dummy.deliver(cfg, `dm_e2e-user@mail.test`, {
      from: "noreply@example.com",
      subject: "第二封",
      text: "ok",
    });
    const incRes = await app.request(`/v1/mailboxes/${mailbox.id}/messages?since=${messages[0]!.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const { messages: incMessages } = (await incRes.json()) as { messages: { subject: string }[] };
    expect(incMessages.map((m) => m.subject)).toEqual(["第二封"]);

    // 消息详情 + 原始报文
    const detailRes = await app.request(`/v1/mailboxes/${mailbox.id}/messages/${messages[0]!.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const detail = (await detailRes.json()) as { message: { text?: string } };
    expect(detail.message.text).toBe("123456");

    const srcRes = await app.request(`/v1/mailboxes/${mailbox.id}/messages/${messages[0]!.id}/source`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(srcRes.headers.get("content-type")).toContain("message/rfc822");
    expect(await srcRes.text()).toContain("Subject: 你的验证码");

    // 删除邮箱
    const del = await app.request(`/v1/mailboxes/${mailbox.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(del.status).toBe(204);
    const gone = await app.request(`/v1/mailboxes/${mailbox.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(gone.status).toBe(404);
  });

  it("主 API 兼容多种请求头形式携带网关 key", async () => {
    const upstreamId = await createUpstream("hdr", ["hdr.test"]);
    const keyRes = await admin("POST", "/admin/keys", { name: "hdr-forms" });
    const key = ((await keyRes.json()) as { key: { key: string } }).key.key;

    const forms: Record<string, string>[] = [
      { Authorization: `Bearer ${key}` }, // 标准形式
      { Authorization: key }, // 无 scheme 裸值
      { "X-API-Key": key }, // MoeMail 客户端风格
      { "X-Admin-Auth": key }, // cloudflare_temp_email 客户端风格
      { "X-Gateway-Key": key }, // 网关自有头
    ];
    for (const headers of forms) {
      const res = await app.request("/v1/domains", { headers });
      expect(res.status, `头形式 ${Object.keys(headers)[0]} 应可用`).toBe(200);
    }

    // 无任何凭证仍是 401
    const noAuth = await app.request("/v1/domains");
    expect(noAuth.status).toBe(401);
    void upstreamId;
  });

  it("管理面：key 吊销后立即删除（列表移除、/v1 失效）；上游带邮箱时禁止删除", async () => {
    const upstreamId = await createUpstream("u1", ["revoke.test"]);

    const keyRes = await admin("POST", "/admin/keys", { name: "short-lived" });
    const key = ((await keyRes.json()) as { key: { key: string } }).key.key;

    const ok = await app.request("/v1/domains", { headers: { Authorization: `Bearer ${key}` } });
    expect(ok.status).toBe(200);

    // 建一个邮箱，验证上游删除保护
    const mb = await app.request("/v1/mailboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "revoke.test" }),
    });
    expect(mb.status).toBe(201);

    const keys = await admin("GET", "/admin/keys");
    const { keys: keyList } = (await keys.json()) as { keys: { id: string; prefix: string }[] };
    const target = keyList.find((k) => k.prefix === key.slice(0, 12))!;
    const revoke = await admin("POST", `/admin/keys/${target.id}/revoke`);
    expect(revoke.status).toBe(204);

    // 吊销即删除：列表不再包含该 key，且对 /v1 立即失效
    const afterList = (await (await admin("GET", "/admin/keys")).json()) as {
      keys: { id: string }[];
    };
    expect(afterList.keys.some((k) => k.id === target.id)).toBe(false);
    const after = await app.request("/v1/domains", { headers: { Authorization: `Bearer ${key}` } });
    expect(after.status).toBe(401);

    const delUpstream = await admin("DELETE", `/admin/upstreams/${upstreamId}`);
    expect(delUpstream.status).toBe(409);
  });

  it("reveal：可随时取回完整明文（与签发时一致且可用）；旧版本 key 无法取回", async () => {
    const keyRes = await admin("POST", "/admin/keys", { name: "reveal-me" });
    const created = ((await keyRes.json()) as { key: { id: string; key: string } }).key;

    const reveal = await admin("POST", `/admin/keys/${created.id}/reveal`);
    expect(reveal.status).toBe(200);
    const { key: revealed } = (await reveal.json()) as { key: string };
    expect(revealed).toBe(created.key);

    // 取回的明文可以直接调用 /v1
    const ok = await app.request("/v1/domains", { headers: { Authorization: `Bearer ${revealed}` } });
    expect(ok.status).toBe(200);

    // 旧版本 key（keyEnc 为 null，直接经 store 插入）→ 409 KEY_PLAINTEXT_UNAVAILABLE
    await deps!.stores.apiKeys.create({
      id: "legacy-key-01",
      name: "legacy",
      keyHash: await hashApiKey("tmg_legacy_plain"),
      prefix: "tmg_legacy",
      keyEnc: null,
      domains: null,
      channels: null,
    });
    const legacyReveal = await admin("POST", "/admin/keys/legacy-key-01/reveal");
    expect(legacyReveal.status).toBe(409);
    expect(((await legacyReveal.json()) as { error: { code: string } }).error.code).toBe(
      "KEY_PLAINTEXT_UNAVAILABLE",
    );
  });

  it("密码错误登录返回 401；/admin 未登录 401", async () => {
    const bad = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(bad.status).toBe(401);

    const me = await app.request("/admin/me");
    expect(me.status).toBe(401);
  });

  it("OpenAPI 文档可访问", async () => {
    const doc = await app.request("/api/doc");
    expect(doc.status).toBe(200);
    const json = (await doc.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(json.paths)).toContain("/v1/mailboxes");
    expect(Object.keys(json.paths)).toContain("/admin/upstreams");
  });
});
