import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { resolve } from "node:path";
import { createDrizzleStores } from "../../src/adapters/stores/drizzle";
import { createWebCryptoCipher } from "../../src/adapters/crypto/webcrypto";
import { buildDeps } from "../../src/bootstrap";
import { createApp } from "../../src/core/app";
import { runMigrations } from "../../src/db/migrate-node";
import type { UpstreamAdapter } from "../../src/ports/upstream";
import { MoeMailAdapter } from "../../src/adapters/upstreams/moemail";
import { YydsMailAdapter } from "../../src/adapters/upstreams/yydsmail";
import { DuckMailAdapter } from "../../src/adapters/upstreams/duckmail";
import { CfTempEmailAdapter } from "../../src/adapters/upstreams/cftempemail";
import { newId } from "../../src/core/ids";

/**
 * 原生格式透传 e2e：
 * 1. /upstream/{上游ID}/** 精确转发（头注入、凭证剥离、原样转发）；
 * 2. /upstream/{类型}/** 类型级路由（单实例直转、域名路由、GET 合并、DELETE 唯一归属）。
 */

const ADMIN_PASSWORD = "pt-admin-pw";
const MASTER_KEY = "pt-master-key-0123456789abcdef";
const UPSTREAM_BASE = "https://moe-upstream.test";
const UPSTREAM_KEY = "upstream-secret-key";
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

describe("/upstream/{上游ID}/** 精确转发", () => {
  let app: ReturnType<typeof makeCtx>["app"];
  let captured: CapturedRequest[];
  let setUpstreamResponse: (status: number, body: unknown) => void;
  let cookie: string;
  let gatewayKey: string;
  let moeUpstreamId: string;
  let bareUpstreamId: string;

  beforeEach(async () => {
    const ctx = makeCtx();
    app = ctx.app;
    captured = ctx.captured;
    setUpstreamResponse = ctx.setUpstreamResponse;

    const session = await ctx.admin(ctx, app);
    cookie = session.cookie;
    gatewayKey = session.gatewayKey;
    moeUpstreamId = await ctx.createUpstream(app, cookie, {
      name: "moe-pt",
      type: "moemail",
      baseUrl: UPSTREAM_BASE,
      apiKey: UPSTREAM_KEY,
    });
    bareUpstreamId = await ctx.createUpstream(app, cookie, {
      name: "bare-pt",
      type: "bare",
      baseUrl: UPSTREAM_BASE,
    });
    // 建上游时的自动域名同步也走 mock，清掉 setup 期间的捕获，仅保留用例自身的请求
    captured.length = 0;
  });

  const authHeader = () => ({ Authorization: `Bearer ${gatewayKey}` });

  it("X-Gateway-Key 可用于鉴权，但不泄漏给上游", async () => {
    const res = await app.request(`/upstream/${moeUpstreamId}/api/emails`, {
      headers: { "X-Gateway-Key": gatewayKey },
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers["x-gateway-key"]).toBeUndefined();
    expect(captured[0]!.headers["x-api-key"]).toBe(UPSTREAM_KEY);
  });

  it("POST 转发：路径后缀、query、注入上游鉴权头、剥离网关凭证、body 原样", async () => {
    const res = await app.request(`/upstream/${moeUpstreamId}/api/emails/generate?foo=bar`, {
      method: "POST",
      headers: {
        ...authHeader(),
        "Content-Type": "application/json",
        "X-API-Key": "client-forged-key", // 客户端伪造必须被覆盖
      },
      body: JSON.stringify({ name: "pt-user", domain: "rtytr.bond", expiryTime: 3_600_000 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("x-upstream-marker")).toBe("yes"); // 响应头透传

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${UPSTREAM_BASE}/api/emails/generate?foo=bar`);
    expect(req.headers["x-api-key"]).toBe(UPSTREAM_KEY); // 注入真实上游 key
    expect(req.headers["x-api-key"]).not.toBe("client-forged-key");
    expect(req.headers["authorization"]).toBeUndefined(); // 网关 key 不外泄
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body!)).toEqual({ name: "pt-user", domain: "rtytr.bond", expiryTime: 3_600_000 });
  });

  it("GET + 多参数 query 原样转发；GET 不携带请求体", async () => {
    await app.request(`/upstream/${moeUpstreamId}/admin/mails?address=a@b.c&limit=20&offset=0`, {
      headers: authHeader(),
    });
    const req = captured[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${UPSTREAM_BASE}/admin/mails?address=a@b.c&limit=20&offset=0`);
    expect(req.body).toBeNull();
  });

  it("上游错误状态与错误体原样透传（4xx 不改写）", async () => {
    setUpstreamResponse(400, { error: "无效的过期时间" });
    const res = await app.request(`/upstream/${moeUpstreamId}/api/emails/generate`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", domain: "rtytr.bond", expiryTime: 123 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "无效的过期时间" });
  });

  it("原生客户端兼容：仅带 x-admin-auth 或 X-API-Key 头（无 Bearer）也能过网关鉴权", async () => {
    // floatmail Temp 渠道的调用形态：x-admin-auth 携带网关 key
    const viaAdminAuth = await app.request(`/upstream/${moeUpstreamId}/api/emails`, {
      headers: { "x-admin-auth": gatewayKey },
    });
    expect(viaAdminAuth.status).toBe(200);

    // floatmail MoeMail 渠道的调用形态：X-API-Key 携带网关 key
    const viaApiKey = await app.request(`/upstream/${moeUpstreamId}/api/emails`, {
      headers: { "X-API-Key": gatewayKey },
    });
    expect(viaApiKey.status).toBe(200);

    // 原生头携带无效值 → 401（伪造上游凭证无法通过）
    const forged = await app.request(`/upstream/${moeUpstreamId}/api/emails`, {
      headers: { "X-API-Key": "not-a-gateway-key" },
    });
    expect(forged.status).toBe(401);
  });

  it("floatmail 探测公开端点的形态：无任何 key 头、仅管理员会话 cookie → 放行", async () => {
    // 登录拿管理会话 cookie（模拟用户登录过管理后台的浏览器环境）
    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    const adminCookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const res = await app.request(`/upstream/${moeUpstreamId}/open_api/settings`, {
      headers: { Cookie: adminCookie }, // 无 Authorization / X-API-Key / X-Admin-Auth
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    // 管理员会话 cookie 不得外泄给上游
    expect(captured[0]!.headers["cookie"]).toBeUndefined();

    // 伪造/过期的会话 cookie → 401
    const forged = await app.request(`/upstream/${moeUpstreamId}/open_api/settings`, {
      headers: { Cookie: "tmg_admin_session=9999999999999.deadbeef" },
    });
    expect(forged.status).toBe(401);
  });

  it("透传创建的邮箱自动登记进网关注册表（管理端可见），删除后自动注销", async () => {
    const admin = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const before = (await (await admin("GET", "/admin/mailboxes")).json()) as { total: number };
    expect(before.total).toBe(0);

    // 原生客户端（floatmail）形态创建邮箱：响应必须原样返回，同时后台登记
    setUpstreamResponse(200, { id: "uuid-reg-1", email: "reg-01@rtytr.bond" });
    const gen = await app.request(`/upstream/${moeUpstreamId}/api/emails/generate`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "reg-01", domain: "rtytr.bond", expiryTime: 3_600_000 }),
    });
    expect(gen.status).toBe(200);
    expect(await gen.json()).toEqual({ id: "uuid-reg-1", email: "reg-01@rtytr.bond" });

    const listed = (await (await admin("GET", "/admin/mailboxes")).json()) as {
      total: number;
      mailboxes: { id: string; address: string; upstreamId: string; expiresAt: string | null }[];
    };
    expect(listed.total).toBe(1);
    const record = listed.mailboxes[0]!;
    expect(record.address).toBe("reg-01@rtytr.bond");
    expect(record.upstreamId).toBe(moeUpstreamId);
    // expiresAt 由观察到的请求 expiryTime 推算（约 1h）
    expect(record.expiresAt).not.toBeNull();

    // 统一 API 也能操作它（适配器用账号级凭证）
    const v1list = await app.request(`/v1/mailboxes/${record.id}/messages`, { headers: authHeader() });
    expect(v1list.status).toBe(200);

    // 原生格式删除 → 注册表自动注销
    setUpstreamResponse(200, { ok: true });
    const del = await app.request(`/upstream/${moeUpstreamId}/api/emails/uuid-reg-1`, {
      method: "DELETE",
      headers: authHeader(),
    });
    expect(del.status).toBe(200);
    const after = (await (await admin("GET", "/admin/mailboxes")).json()) as { total: number };
    expect(after.total).toBe(0);
  });

  it("无网关 key 返回 401 JSON；未知上游 404；未实现 authHeaders 的类型 501", async () => {
    const noAuth = await app.request(`/upstream/${moeUpstreamId}/api/emails`);
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("content-type")).toContain("application/json");

    const unknown = await app.request(`/upstream/01ZZZZZZZZZZZZZZZZZZZZZZZZ/api/emails`, { headers: authHeader() });
    expect(unknown.status).toBe(404);

    const bare = await app.request(`/upstream/${bareUpstreamId}/anything`, { headers: authHeader() });
    expect(bare.status).toBe(501);
    expect(((await bare.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_MISSING");
    expect(captured).toHaveLength(0);
  });

  it("停用上游 403；settings 关闭透传 403", async () => {
    const admin = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    await admin("PUT", `/admin/upstreams/${moeUpstreamId}`, { enabled: false });
    const disabled = await app.request(`/upstream/${moeUpstreamId}/api/emails`, { headers: authHeader() });
    expect(disabled.status).toBe(403);
    await admin("PUT", `/admin/upstreams/${moeUpstreamId}`, { enabled: true });

    await admin("PUT", `/admin/upstreams/${moeUpstreamId}`, { settings: { passthroughEnabled: false } });
    const optedOut = await app.request(`/upstream/${moeUpstreamId}/api/emails`, { headers: authHeader() });
    expect(optedOut.status).toBe(403);
  });
});

describe("/upstream/{适配器类型}/** 类型级路由", () => {
  let app: ReturnType<typeof makeCtx>["app"];
  let captured: CapturedRequest[];
  let setResponder: (fn: (req: CapturedRequest) => { status: number; body: unknown }) => void;
  let registerDomains: (upstreamId: string, domains: string[]) => void;
  let cookie: string;
  let gatewayKey: string;
  let upstreamAId: string;
  let upstreamBId: string;
  let deps: Ctx["deps"];
  /** 更早创建、非 moemail 类型的渠道（R-03 的全局主归属干扰源） */
  let earlyCfId: string;

  beforeEach(async () => {
    const ctx = makeCtx();
    app = ctx.app;
    captured = ctx.captured;
    setResponder = ctx.setResponder;
    deps = ctx.deps;

    const session = await ctx.admin(ctx, app);
    cookie = session.cookie;
    gatewayKey = session.gatewayKey;

    // R-03 干扰源：先建一个 cf-temp-email 并登记 shared.test —— 若选主是「全局最早」，
    // shared.test 的主归属会是它而非 moemail 实例
    earlyCfId = await ctx.createUpstream(app, cookie, {
      name: "早建的CF",
      type: "cf-temp-email",
      baseUrl: "https://cf-early.test",
      apiKey: "key-cf",
    });
    upstreamAId = await ctx.createUpstream(app, cookie, {
      name: "实例A",
      type: "moemail",
      baseUrl: "https://moe-a.test",
      apiKey: "key-a",
    });
    upstreamBId = await ctx.createUpstream(app, cookie, {
      name: "实例B",
      type: "moemail",
      baseUrl: "https://moe-b.test",
      apiKey: "key-b",
    });
    // 直接登记域名（绕过需要真实网络的同步流程）
    registerDomains = (id, domains) =>
      void ctx.deps.stores.upstreams.replaceDomains(
        id,
        domains.map((domain) => ({
          domain,
          upstreamId: id,
          isPrivate: false,
          enabled: true,
          syncedAt: new Date(),
        })),
      );
    registerDomains(earlyCfId, ["shared.test"]);
    registerDomains(upstreamAId, ["a.test", "shared.test"]);
    registerDomains(upstreamBId, ["b.test"]);
    // 建上游时的自动域名同步也走 mock，清掉 setup 期间的捕获，仅保留用例自身的请求
    captured.length = 0;
  });

  const authHeader = () => ({ Authorization: `Bearer ${gatewayKey}` });

  it("body 带 domain：路由到拥有该域名的实例，响应带 X-Gateway-Upstream-Id", async () => {
    const res = await app.request(`/upstream/moemail/api/emails/generate`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "u1", domain: "b.test", expiryTime: 3_600_000 }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-upstream-id")).toBe(upstreamBId);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://moe-b.test/api/emails/generate");
    expect(captured[0]!.headers["x-api-key"]).toBe("key-b");
  });

  it("query 带邮箱参数（address/query）：按邮箱域名路由（cf-temp_email 风格）", async () => {
    await app.request(`/upstream/moemail/api/lookup?address=user@a.test`, { headers: authHeader() });
    expect(captured[0]!.url).toBe("https://moe-a.test/api/lookup?address=user@a.test");
    expect(captured[0]!.headers["x-api-key"]).toBe("key-a");
  });

  it("域名不属于该类型任何实例 → 400 DOMAIN_NOT_ROUTED", async () => {
    const res = await app.request(`/upstream/moemail/api/emails/generate`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "u1", domain: "elsewhere.test" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_NOT_ROUTED");
    expect(captured).toHaveLength(0);
  });

  it("R-03：共享域名在更早创建的其他类型渠道登记时，类型寻址仍路由到本类型的候选", async () => {
    // 全局主归属是早建的 CF（earliest）；但 moemail 类型里 A 也登记了 shared.test
    const res = await app.request(`/upstream/moemail/api/emails/generate`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "u1", domain: "shared.test", expiryTime: 3_600_000 }),
    });

    // 旧实现：拿全局主归属（CF）比 type → 400 DOMAIN_NOT_ROUTED 且一次都不转发
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-upstream-id")).toBe(upstreamAId);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://moe-a.test/api/emails/generate");
    expect(captured[0]!.headers["x-api-key"]).toBe("key-a");
  });

  it("R-03 逐渠道：类型内某实例停用该域名后，类型寻址落到类型内仍启用的实例", async () => {
    const admin = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    // 让 B 也登记 shared.test，再停用 A 名下那一行
    registerDomains(upstreamBId, ["b.test", "shared.test"]);
    const off = await admin("PUT", `/admin/upstreams/${upstreamAId}/domains/shared.test`, { enabled: false });
    expect(off.status).toBe(200);
    captured.length = 0;

    const res = await app.request(`/upstream/moemail/api/emails/generate`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "u1", domain: "shared.test", expiryTime: 3_600_000 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-upstream-id")).toBe(upstreamBId);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://moe-b.test/api/emails/generate");
  });

  it("S-01：域名停用后，类型寻址的 GET/DELETE 读信清理不受域名开关影响（仍 200 且转发）", async () => {
    const admin = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    // 让 A、B 都登记 shared.test，然后停用 A 名下那一行（A 是类型内最早的启用实例）
    registerDomains(upstreamBId, ["b.test", "shared.test"]);
    const off = await admin("PUT", `/admin/upstreams/${upstreamAId}/domains/shared.test`, { enabled: false });
    expect(off.status).toBe(200);
    captured.length = 0;

    // 旧实现：类型寻址的 GET/DELETE 也被 domainEnabled 过滤 → 403 DOMAIN_DISABLED、0 次转发
    // 现在：读信/清理不受域名开关约束 → 路由到最早的启用实例 A 并转发
    const getRes = await app.request(`/upstream/moemail/api/emails?address=user@shared.test`, {
      headers: authHeader(),
    });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("x-gateway-upstream-id")).toBe(upstreamAId);

    await registerMailbox(deps, upstreamAId, "abc", "user@shared.test");
    const delRes = await app.request(`/upstream/moemail/api/emails/abc?address=user@shared.test`, {
      method: "DELETE",
      headers: authHeader(),
    });
    expect(delRes.status).toBe(200);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.url).toBe("https://moe-a.test/api/emails?address=user@shared.test");
    expect(captured[1]!.url).toBe("https://moe-a.test/api/emails/abc?address=user@shared.test");

    // 对照：写请求仍被域名开关拦（只有 B 启用）
    const writeRes = await app.request(`/upstream/moemail/api/emails/generate`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "u1", domain: "shared.test", expiryTime: 3_600_000 }),
    });
    expect(writeRes.status).toBe(200);
    expect(writeRes.headers.get("x-gateway-upstream-id")).toBe(upstreamBId);
  });

  it("S-01 全停用：域名在所有类型实例都停用后，读信仍放行（域名开关只约束建箱）", async () => {
    const admin = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    // A、B 都停用 shared.test
    registerDomains(upstreamBId, ["b.test", "shared.test"]);
    await admin("PUT", `/admin/upstreams/${upstreamAId}/domains/shared.test`, { enabled: false });
    await admin("PUT", `/admin/upstreams/${upstreamBId}/domains/shared.test`, { enabled: false });
    captured.length = 0;

    const getRes = await app.request(`/upstream/moemail/api/emails?address=user@shared.test`, {
      headers: authHeader(),
    });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("x-gateway-upstream-id")).toBe(upstreamAId);
    expect(captured).toHaveLength(1);

    // 写请求此时全部停用 → DOMAIN_DISABLED（handler 预检即拦）
    const writeRes = await app.request(`/upstream/moemail/api/emails/generate`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "u1", domain: "shared.test", expiryTime: 3_600_000 }),
    });
    expect(writeRes.status).toBe(403);
    expect(((await writeRes.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_DISABLED");
    expect(captured).toHaveLength(1); // 写请求没有转发
  });

  it("多实例下无域名的写操作 → 400 DOMAIN_REQUIRED（防重复副作用）", async () => {
    const res = await app.request(`/upstream/moemail/api/whatever`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-domain" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_REQUIRED");
    expect(captured).toHaveLength(0);
  });

  it("GET 无域名 → 扇出全部实例并合并数组字段", async () => {
    setResponder((req) => {
      if (req.url.startsWith("https://moe-a.test")) return { status: 200, body: { emails: [{ id: "A1" }, { id: "A2" }], total: 2 } };
      return { status: 200, body: { emails: [{ id: "B1" }], total: 1 } };
    });
    const res = await app.request(`/upstream/moemail/api/emails`, { headers: authHeader() });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emails: [{ id: "A1" }, { id: "A2" }, { id: "B1" }], total: 2 });
    expect(res.headers.get("x-gateway-merged-upstreams")).toBe("2");
    expect(res.headers.get("x-gateway-upstream-ids")?.split(",")).toEqual([upstreamAId, upstreamBId]);
  });

  it("GET 指定资源：仅拥有该资源的实例返回 2xx 时原样透传该响应", async () => {
    setResponder((req) => {
      if (req.url.startsWith("https://moe-a.test")) return { status: 404, body: { error: "not found" } };
      return { status: 200, body: { id: "uuid-1", email: "u@b.test" } };
    });
    const res = await app.request(`/upstream/moemail/api/emails/uuid-1`, { headers: authHeader() });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "uuid-1", email: "u@b.test" });
    expect(res.headers.get("x-gateway-upstream-id")).toBe(upstreamBId);
    expect(res.headers.get("x-gateway-partial-failure")).not.toBeNull(); // A 的 404 被记录
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-upstream-marker")).toBe("yes");
  });

  it("DELETE 无域名且没有已登记的唯一归属时拒绝，不请求任何上游", async () => {
    setResponder((req) => {
      if (req.url.startsWith("https://moe-a.test")) return { status: 404, body: { error: "not found" } };
      return { status: 200, body: { ok: true } };
    });
    const res = await app.request(`/upstream/moemail/api/emails/uuid-1`, { method: "DELETE", headers: authHeader() });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "UPSTREAM_REQUIRED" } });
    expect(captured).toHaveLength(0);
  });

  it("DELETE 根据已登记邮箱路由一次，并注销本地记录", async () => {
    const mailbox = await registerMailbox(deps, upstreamBId, "uuid-1", "user@b.test");
    const res = await app.request("/upstream/moemail/api/emails/uuid-1", { method: "DELETE", headers: authHeader() });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-upstream-id")).toBe(upstreamBId);
    expect(captured.map((r) => r.url)).toEqual(["https://moe-b.test/api/emails/uuid-1"]);
    expect(await deps.stores.mailboxes.get(mailbox.id)).toBeNull();
  });

  it("删除邮件可由路径中的邮箱 ID 定位，但不注销邮箱本身", async () => {
    const mailbox = await registerMailbox(deps, upstreamBId, "box-1", "user@b.test");
    const res = await app.request("/upstream/moemail/api/emails/box-1/message-1", {
      method: "DELETE", headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(captured.map((r) => r.url)).toEqual(["https://moe-b.test/api/emails/box-1/message-1"]);
    expect(await deps.stores.mailboxes.get(mailbox.id)).not.toBeNull();
  });

  it("重复邮箱 ID 或只有共享域名时拒绝删除；地址可唯一定位已登记邮箱", async () => {
    await deps.stores.upstreams.replaceDomains(upstreamBId, [{
      domain: "shared.test", upstreamId: upstreamBId, isPrivate: false, enabled: true, syncedAt: new Date(),
    }]);
    const a = await registerMailbox(deps, upstreamAId, "same-id", "a@shared.test");
    const b = await registerMailbox(deps, upstreamBId, "same-id", "b@shared.test");
    for (const path of ["/api/emails/same-id", "/api/emails/unknown?address=unknown@shared.test"]) {
      const res = await app.request(`/upstream/moemail${path}`, { method: "DELETE", headers: authHeader() });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "UPSTREAM_REQUIRED" } });
    }
    expect(captured).toHaveLength(0);
    const res = await app.request("/upstream/moemail/api/emails/same-id?address=b@shared.test", {
      method: "DELETE", headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(res.headers.get("x-gateway-upstream-id")).toBe(upstreamBId);
    expect(await deps.stores.mailboxes.get(a.id)).not.toBeNull();
    expect(await deps.stores.mailboxes.get(b.id)).toBeNull();
  });

  it("透传关闭的实例不参与 GET 合并，域名定向也不能绕过开关", async () => {
    await deps.stores.upstreams.update(upstreamAId, { settingsJson: { passthroughEnabled: false } });
    const get = await app.request("/upstream/moemail/api/emails", { headers: authHeader() });
    expect(get.status).toBe(200);
    expect(captured.map((r) => r.url)).toEqual(["https://moe-b.test/api/emails"]);
    captured.length = 0;
    for (const method of ["POST", "DELETE"]) {
      const res = await app.request("/upstream/moemail/api/emails?address=user@a.test", {
        method, headers: authHeader(),
      });
      expect(res.status).toBe(403);
    }
    expect(captured).toHaveLength(0);
    await deps.stores.upstreams.update(upstreamBId, { settingsJson: { passthroughEnabled: false } });
    const none = await app.request("/upstream/moemail/api/emails", { headers: authHeader() });
    expect(none.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it("共享域名的写请求选择透传开启的实例；已登记的删除不能转移到另一实例", async () => {
    await deps.stores.upstreams.replaceDomains(upstreamBId, [{
      domain: "shared.test", upstreamId: upstreamBId, isPrivate: false, enabled: true, syncedAt: new Date(),
    }]);
    await deps.stores.upstreams.update(upstreamAId, { settingsJson: { passthroughEnabled: false } });
    const mailbox = await registerMailbox(deps, upstreamAId, "known-id", "a@shared.test");
    const create = await app.request("/upstream/moemail/api/emails/generate", {
      method: "POST", headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "shared.test" }),
    });
    expect(create.status).toBe(200);
    expect(create.headers.get("x-gateway-upstream-id")).toBe(upstreamBId);
    captured.length = 0;
    const del = await app.request("/upstream/moemail/api/emails/known-id", { method: "DELETE", headers: authHeader() });
    expect(del.status).toBe(403);
    expect(captured).toHaveLength(0);
    expect(await deps.stores.mailboxes.get(mailbox.id)).not.toBeNull();
  });

  it("无法合并的成功响应保留原始响应头", async () => {
    setResponder(() => ({ status: 200, body: "native-value" }));
    const res = await app.request("/upstream/moemail/api/resource", { headers: authHeader() });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe("native-value");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-upstream-marker")).toBe("yes");
  });

  it("全部实例失败时原样返回非 2xx 响应", async () => {
    setResponder(() => ({ status: 404, body: { error: "not found" } }));
    const res = await app.request(`/upstream/moemail/api/emails/uuid-1`, { headers: authHeader() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("类型下没有启用的上游 → 404；未注册的类型 → 404", async () => {
    // 停用 beforeEach 建的 cf 实例（原本无实例的 cf-temp-email 现在有了，用来构造"全停用"）
    const admin = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const off = await admin("PUT", `/admin/upstreams/${earlyCfId}`, { enabled: false });
    expect(off.status).toBe(200);

    const noInstances = await app.request(`/upstream/cf-temp-email/api/anything`, { headers: authHeader() });
    expect(noInstances.status).toBe(404);
    expect(((await noInstances.json()) as { error: { message: string } }).error.message).toContain("没有启用");

    const unknown = await app.request(`/upstream/nonexistent-type/api/anything`, { headers: authHeader() });
    expect(unknown.status).toBe(404);
  });
});

describe("透传删除与原生地址回归", () => {
  it.each([
    ["moemail", "/api/emails"],
    ["yydsmail", "/v1/accounts"],
    ["duckmail", "/accounts"],
  ])("%s 的 204 删除按 ID 和类型寻址均注销，响应保持空 body", async (type, path) => {
    const ctx = makeCtx();
    const { cookie, gatewayKey } = await ctx.admin(ctx, ctx.app);
    const a = await ctx.createUpstream(ctx.app, cookie, { name: "A", type, baseUrl: "https://a.test", apiKey: "test-a" });
    const b = await ctx.createUpstream(ctx.app, cookie, { name: "B", type, baseUrl: "https://b.test", apiKey: "test-b" });
    const boxA = await registerMailbox(ctx.deps, a, "box-a", "a@a.test");
    const boxB = await registerMailbox(ctx.deps, b, "box-b", "b@b.test");
    ctx.setUpstreamResponse(204, null);
    ctx.captured.length = 0;
    const headers = { Authorization: `Bearer ${gatewayKey}` };
    const direct = await ctx.app.request(`/upstream/${a}${path}/box-a`, { method: "DELETE", headers });
    expect(direct.status).toBe(204);
    expect(direct.body).toBeNull();
    expect(await ctx.deps.stores.mailboxes.get(boxA.id)).toBeNull();
    expect(await ctx.deps.stores.mailboxes.get(boxB.id)).not.toBeNull();
    const routed = await ctx.app.request(`/upstream/${type}${path}/box-b`, { method: "DELETE", headers });
    expect(routed.status).toBe(204);
    expect(routed.body).toBeNull();
    expect(routed.headers.get("x-gateway-upstream-id")).toBe(b);
    expect(await ctx.deps.stores.mailboxes.get(boxB.id)).toBeNull();
    expect(ctx.captured.map((r) => r.url)).toEqual([`https://a.test${path}/box-a`, `https://b.test${path}/box-b`]);
  });

  it("YYDS HTTP 200 的业务删除失败保持原始响应和邮箱登记", async () => {
    const ctx = makeCtx();
    const { cookie, gatewayKey } = await ctx.admin(ctx, ctx.app);
    const id = await ctx.createUpstream(ctx.app, cookie, {
      name: "YYDS", type: "yydsmail", baseUrl: "https://yyds.test", apiKey: "test-key",
    });
    const mailbox = await registerMailbox(ctx.deps, id, "box-1", "u@yyds.test");
    const failure = { success: false, error: "deletion failed", errorCode: "INTERNAL_ERROR" };
    ctx.setUpstreamResponse(200, failure);
    const res = await ctx.app.request(`/upstream/${id}/v1/accounts/box-1`, {
      method: "DELETE", headers: { Authorization: `Bearer ${gatewayKey}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(failure);
    expect(await ctx.deps.stores.mailboxes.get(mailbox.id)).not.toBeNull();
  });

  it("CF 的重复数字邮件 ID 不会跨实例误删，显式 ID 只删除目标实例", async () => {
    const ctx = makeCtx();
    const { cookie, gatewayKey } = await ctx.admin(ctx, ctx.app);
    const a = await ctx.createUpstream(ctx.app, cookie, {
      name: "CF A", type: "cf-temp-email", baseUrl: "https://cf-a.test", apiKey: "key-a",
    });
    await ctx.createUpstream(ctx.app, cookie, {
      name: "CF B", type: "cf-temp-email", baseUrl: "https://cf-b.test", apiKey: "key-b",
    });
    const messages = new Map([["cf-a.test", new Set(["1"])], ["cf-b.test", new Set(["1"])]]);
    ctx.setResponder((req) => {
      const url = new URL(req.url);
      const found = req.method === "DELETE" && messages.get(url.host)!.delete(url.pathname.split("/").at(-1)!);
      return { status: found ? 200 : 404, body: { deleted: found } };
    });
    ctx.captured.length = 0;
    const headers = { Authorization: `Bearer ${gatewayKey}` };
    const ambiguous = await ctx.app.request("/upstream/cf-temp-email/admin/mails/1", { method: "DELETE", headers });
    expect(ambiguous.status).toBe(400);
    expect(ctx.captured).toHaveLength(0);
    expect(messages.get("cf-a.test")!.has("1")).toBe(true);
    expect(messages.get("cf-b.test")!.has("1")).toBe(true);
    const direct = await ctx.app.request(`/upstream/${a}/admin/mails/1`, { method: "DELETE", headers });
    expect(direct.status).toBe(200);
    expect(messages.get("cf-a.test")!.has("1")).toBe(false);
    expect(messages.get("cf-b.test")!.has("1")).toBe(true);
    expect(ctx.captured).toHaveLength(1);
  });

  it.each(["id", "type"])("DuckMail 按 %s 透传建箱校验 body.address，冲突 domain 字段不能绕过管控", async (route) => {
    const ctx = makeCtx();
    const { cookie, gatewayKey } = await ctx.admin(ctx, ctx.app);
    const id = await ctx.createUpstream(ctx.app, cookie, {
      name: "Duck A", type: "duckmail", baseUrl: "https://duck-a.test", apiKey: "dk-test-a",
    });
    await ctx.createUpstream(ctx.app, cookie, {
      name: "Duck B", type: "duckmail", baseUrl: "https://duck-b.test", apiKey: "dk-test-b",
    });
    await ctx.deps.stores.upstreams.replaceDomains(id, ["allow.test", "block.test"].map((domain) => ({
      domain, upstreamId: id, isPrivate: false, enabled: true, syncedAt: new Date(),
    })));
    const keyRes = await ctx.app.request("/admin/keys", {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "restricted", domains: ["allow.test"] }),
    });
    const restricted = ((await keyRes.json()) as { key: { key: string } }).key.key;
    const path = `/upstream/${route === "id" ? id : "duckmail"}/accounts`;
    const create = (address: string, key: string, domain?: string) => ctx.app.request(path, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ address, password: "test-password", ...(domain ? { domain } : {}) }),
    });
    ctx.captured.length = 0;
    const restrictedRes = await create("user+tag@BLOCK.TEST", restricted);
    expect(restrictedRes.status).toBe(403);
    expect(await restrictedRes.json()).toMatchObject({ error: { code: "DOMAIN_NOT_ALLOWED" } });
    await ctx.deps.stores.upstreams.setDomainEnabled(id, "block.test", false);
    const disabled = await create("user@block.test", gatewayKey);
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toMatchObject({ error: { code: "DOMAIN_DISABLED" } });
    const spoofed = await create("user@block.test", restricted, "allow.test");
    expect(spoofed.status).toBe(400);
    expect(ctx.captured).toHaveLength(0);
    ctx.setUpstreamResponse(201, { id: "duck-box", address: "user@allow.test" });
    const allowed = await create("user@allow.test", restricted, "allow.test");
    expect(allowed.status).toBe(201);
    expect(ctx.captured.map((r) => r.url)).toEqual(["https://duck-a.test/accounts"]);
    expect(JSON.parse(ctx.captured[0]!.body!)).toMatchObject({ address: "user@allow.test", password: "test-password" });
  });
});

// ---------- 测试装配 ----------

interface Ctx {
  app: ReturnType<typeof createApp>;
  captured: CapturedRequest[];
  mockFetch: typeof fetch;
  setUpstreamResponse: (status: number, body: unknown) => void;
  setResponder: (fn: (req: CapturedRequest) => { status: number; body: unknown }) => void;
  deps: ReturnType<typeof buildDeps>;
  admin(
    ctx: Ctx,
    app: ReturnType<typeof createApp>,
  ): Promise<{ cookie: string; gatewayKey: string }>;
  createUpstream(
    app: ReturnType<typeof createApp>,
    cookie: string,
    body: Record<string, unknown>,
  ): Promise<string>;
}

function makeCtx(): Ctx {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  runMigrations(sqlite, resolve("migrations"));

  const captured: CapturedRequest[] = [];
  let upstreamStatus = 200;
  let upstreamBody: unknown = { ok: true };
  let responder: ((req: CapturedRequest) => { status: number; body: unknown }) | null = null;
  const mockFetch: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const rawBody = init?.body;
    // 兼容 string（适配器 upstreamSend 的 JSON.stringify）与 ArrayBuffer（透传转发）
    const bodyText =
      typeof rawBody === "string"
        ? rawBody
        : rawBody
          ? new TextDecoder().decode(rawBody as ArrayBuffer)
          : null;
    const req: CapturedRequest = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: bodyText,
    };
    captured.push(req);
    if (responder) {
      const r = responder(req);
      return new Response(r.status === 204 ? null : JSON.stringify(r.body), {
        status: r.status,
        headers: { "Content-Type": "application/json", "X-Upstream-Marker": "yes" },
      });
    }
    return new Response(upstreamStatus === 204 ? null : JSON.stringify(upstreamBody), {
      status: upstreamStatus,
      headers: { "Content-Type": "application/json", "X-Upstream-Marker": "yes" },
    });
  };

  const deps = buildDeps({
    stores: createDrizzleStores(drizzle(sqlite) as never),
    crypto: createWebCryptoCipher(MASTER_KEY),
    config: { adminPassword: ADMIN_PASSWORD, masterKey: MASTER_KEY },
    fetchFn: mockFetch,
  });

  // 让统一 API 与透传共用同一个模拟上游（生产环境两者都用真实网络）
  deps.registry.register(new MoeMailAdapter({ fetchFn: mockFetch }), {
    displayName: "MoeMail",
    description: "模拟上游",
  });
  for (const adapter of [new CfTempEmailAdapter({ fetchFn: mockFetch }), new YydsMailAdapter({ fetchFn: mockFetch }), new DuckMailAdapter({ fetchFn: mockFetch })]) {
    deps.registry.register(adapter, { displayName: adapter.type, description: "Mock upstream" });
  }

  // 一个不支持透传的裸适配器（未实现 authHeaders）
  const bareAdapter: UpstreamAdapter = {
    type: "bare",
    listDomains: async () => [],
    createMailbox: async () => {
      throw new Error("not implemented");
    },
    deleteMailbox: async () => {
      throw new Error("not implemented");
    },
    listMessages: async () => [],
    getMessage: async () => {
      throw new Error("not implemented");
    },
  };
  deps.registry.register(bareAdapter, { displayName: "Bare", description: "无透传能力的测试适配器" });

  const app = createApp(deps);

  const adminRequest = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  return {
    app,
    captured,
    mockFetch,
    setUpstreamResponse: (status, body) => {
      upstreamStatus = status;
      upstreamBody = body;
    },
    setResponder: (fn) => {
      responder = fn;
    },
    deps,
    async admin(_ctx, appRef) {
      const login = await appRef.request("/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const keyRes = await adminRequest(cookie, "POST", "/admin/keys", { name: "pt" });
      const gatewayKey = ((await keyRes.json()) as { key: { key: string } }).key.key;
      return { cookie, gatewayKey };
    },
    async createUpstream(appRef, cookie, body) {
      const res = await adminRequest(cookie, "POST", "/admin/upstreams", body);
      expect(res.status).toBe(201);
      return ((await res.json()) as { upstream: { id: string } }).upstream.id;
    },
  };
}

async function registerMailbox(deps: Ctx["deps"], upstreamId: string, upstreamMailboxId: string, address: string) {
  const [localPart, domain] = address.split("@");
  return deps.stores.mailboxes.create({
    id: newId(), upstreamId, upstreamMailboxId, address, localPart: localPart!, domain: domain!,
    credentialsEnc: null, passwordEnc: null, apiKeyId: null, expiresAt: null,
  });
}

// ---------- 透传域名管控 ----------

describe("透传域名管控（写请求受域名开关 + key 白名单约束）", () => {
  let app: ReturnType<typeof makeCtx>["app"];
  let captured: CapturedRequest[];
  let cookie: string;
  let gatewayKey: string;
  let adminCookie: string;
  let moeId: string;
  let restrictedKey: string;

  beforeEach(async () => {
    const ctx = makeCtx();
    app = ctx.app;
    captured = ctx.captured;

    const session = await ctx.admin(ctx, app);
    cookie = session.cookie;
    gatewayKey = session.gatewayKey;

    moeId = await ctx.createUpstream(app, cookie, {
      name: "moe-domctl",
      type: "moemail",
      baseUrl: "https://moe-domctl.test",
      apiKey: "key-dc",
    });
    ctx.deps.stores.upstreams.replaceDomains(
      moeId,
      ["allow.test", "block.test"].map((domain) => ({
        domain,
        upstreamId: moeId,
        isPrivate: false,
        enabled: true,
        syncedAt: new Date(),
      })),
    );

    // 白名单 key：仅 allow.test
    const keyRes = await app.request("/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "restricted", domains: ["allow.test"] }),
    });
    restrictedKey = ((await keyRes.json()) as { key: { key: string } }).key.key;

    // 管理员会话 cookie（floatmail 探测形态：无 key 头）
    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    adminCookie = login.headers.get("set-cookie")!.split(";")[0]!;

    captured.length = 0;
  });

  const gen = (key: string, domain: string) =>
    app.request(`/upstream/${moeId}/api/emails/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "u", domain, expiryTime: 3_600_000 }),
    });

  it("key 白名单外域名 → 403 DOMAIN_NOT_ALLOWED，且不转发", async () => {
    const res = await gen(restrictedKey, "block.test");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_NOT_ALLOWED");
    expect(captured).toHaveLength(0);
  });

  it("key 白名单内域名正常转发", async () => {
    const res = await gen(restrictedKey, "allow.test");
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
  });

  it("停用域名 → 403 DOMAIN_DISABLED（普通 key 与管理员会话均受限），恢复后放行", async () => {
    const admin = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    await admin("PUT", `/admin/upstreams/${moeId}/domains/block.test`, { enabled: false });

    const byKey = await gen(gatewayKey, "block.test"); // 无白名单的普通 key
    expect(byKey.status).toBe(403);
    expect(((await byKey.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_DISABLED");

    // 管理员会话（domains null，无白名单限制）同样被域名开关拦截
    const byAdmin = await app.request(`/upstream/${moeId}/api/emails/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ name: "u", domain: "block.test", expiryTime: 3_600_000 }),
    });
    expect(byAdmin.status).toBe(403);
    expect(captured).toHaveLength(0);

    await admin("PUT", `/admin/upstreams/${moeId}/domains/block.test`, { enabled: true });
    const ok = await gen(gatewayKey, "block.test");
    expect(ok.status).toBe(200);
  });

  it("类型寻址（/upstream/moemail）同样受管控", async () => {
    const res = await app.request(`/upstream/moemail/api/emails/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${restrictedKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "u", domain: "block.test", expiryTime: 3_600_000 }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_NOT_ALLOWED");
    expect(captured).toHaveLength(0);
  });

  it("GET 读信不受域名开关与白名单限制", async () => {
    await app.request(`/admin/upstreams/${moeId}/domains/block.test`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ enabled: false }),
    });
    const res = await app.request(`/upstream/${moeId}/api/emails?address=u@block.test`, {
      headers: { Authorization: `Bearer ${restrictedKey}` },
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
  });

  it("共享域名逐渠道停用（D-01）：停用某实例自己的域名行，按该实例 ID 透传建箱被拦；不影响其他实例", async () => {
    const ctx = makeCtx();
    const app2 = ctx.app;
    const session = await ctx.admin(ctx, app2);
    const cookie2 = session.cookie;
    const admin2 = (method: string, path: string, body?: unknown) =>
      app2.request(path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie2 },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    // 两个 moemail 实例都登记 shared.test（旧实现：全局主键 + 全删全插会直接清空第二个渠道）
    const moe1 = await ctx.createUpstream(app2, cookie2, {
      name: "moe-shared-1", type: "moemail", baseUrl: "https://moe-s1.test", apiKey: "k-s1",
    });
    const moe2 = await ctx.createUpstream(app2, cookie2, {
      name: "moe-shared-2", type: "moemail", baseUrl: "https://moe-s2.test", apiKey: "k-s2",
    });
    ctx.deps.stores.upstreams.replaceDomains(moe1, ["shared.test"].map((domain) => ({
      domain, upstreamId: moe1, isPrivate: false, enabled: true, syncedAt: new Date(),
    })));
    ctx.deps.stores.upstreams.replaceDomains(moe2, ["shared.test"].map((domain) => ({
      domain, upstreamId: moe2, isPrivate: false, enabled: true, syncedAt: new Date(),
    })));
    ctx.captured.length = 0;

    // 只停用 moe2 名下的 shared.test
    const off = await admin2("PUT", `/admin/upstreams/${moe2}/domains/shared.test`, { enabled: false });
    expect(off.status).toBe(200);

    // 按 moe1 的 ID 透传建 shared.test → 放行（moe1 的行仍启用）
    const via1 = await app2.request(`/upstream/${moe1}/api/emails/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.gatewayKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "u", domain: "shared.test", expiryTime: 3_600_000 }),
    });
    expect(via1.status).toBe(200);

    // 按 moe2 的 ID 透传建 shared.test → 该实例自身的行已停用 → 403 DOMAIN_DISABLED，且不转发
    const via2 = await app2.request(`/upstream/${moe2}/api/emails/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.gatewayKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "u", domain: "shared.test", expiryTime: 3_600_000 }),
    });
    expect(via2.status).toBe(403);
    expect(((await via2.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_DISABLED");
    expect(ctx.captured).toHaveLength(1); // 只有 moe1 那一次转发
  });
});

describe("透传渠道白名单", () => {
  it("key 渠道白名单：写请求只能命中白名单内的上游实例", async () => {
    const ctx = makeCtx();
    const app = ctx.app;
    const session = await ctx.admin(ctx, app);
    const cookie = session.cookie;

    const moeId = await ctx.createUpstream(app, cookie, {
      name: "moe-chan",
      type: "moemail",
      baseUrl: "https://moe-chan.test",
      apiKey: "key-chan",
    });
    ctx.deps.stores.upstreams.replaceDomains(
      moeId,
      ["allow.test"].map((domain) => ({
        domain, upstreamId: moeId, isPrivate: false, enabled: true, syncedAt: new Date(),
      })),
    );

    const keyRes = await app.request("/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "chan-key", channels: [moeId] }),
    });
    const chanKey = ((await keyRes.json()) as { key: { key: string } }).key.key;

    // 类型寻址（此时单实例直转）→ 目标即白名单渠道 → 放行
    const ok = await app.request(`/upstream/moemail/api/emails/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${chanKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "u", domain: "allow.test", expiryTime: 3_600_000 }),
    });
    expect(ok.status).toBe(200);

    // 渠道外的实例：ID 寻址写请求 → 403 CHANNEL_NOT_ALLOWED，不转发
    const otherRes = await app.request("/admin/upstreams", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "moe-other", type: "moemail", baseUrl: "https://moe-other.test", apiKey: "key-o" }),
    });
    const otherId = ((await otherRes.json()) as { upstream: { id: string } }).upstream.id;
    ctx.captured.length = 0;
    const denied = await app.request(`/upstream/${otherId}/api/emails/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${chanKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "u", domain: "other.test", expiryTime: 3_600_000 }),
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("CHANNEL_NOT_ALLOWED");
    expect(ctx.captured).toHaveLength(0);

    // 按 ID 显式寻址的 GET 不受渠道白名单限制（读存量邮箱不该被名单变化打断）
    const read = await app.request(`/upstream/${otherId}/api/emails`, {
      headers: { Authorization: `Bearer ${chanKey}` },
    });
    expect(read.status).toBe(200);
  });

  /**
   * G5：类型寻址 = 让网关替调用方选实例，因此候选必须先按渠道白名单收窄——读请求也要收。
   * 真实场景：同一上游软件的两个账户（"日常"与"批量注册"两把上游 key）注册成两个渠道，
   * 日常 key 用 /upstream/moemail 读列表时，扇出合并会把批量账户的邮箱泄漏出来；
   * filterPassthroughList 按域名过滤救不了——两个账户共享同一套域名。
   */
  describe("G5 类型寻址按渠道白名单收窄候选", () => {
    let ctx: Ctx;
    let app: Ctx["app"];
    let cookie: string;
    let dailyId: string;
    let bulkId: string;
    let dailyKey: string;
    let unrestrictedKey: string;

    beforeEach(async () => {
      ctx = makeCtx();
      app = ctx.app;
      const session = await ctx.admin(ctx, app);
      cookie = session.cookie;
      unrestrictedKey = session.gatewayKey;

      // 两个同类型渠道共享同一套域名（同一 MoeMail 实例的两个账户就是这个形态）
      // bulk 先建：若不收窄，"最早创建"选主会让日常 key 落到批量账户上
      bulkId = await ctx.createUpstream(app, cookie, {
        name: "批量注册账户",
        type: "moemail",
        baseUrl: "https://moe-bulk.test",
        apiKey: "key-bulk",
      });
      dailyId = await ctx.createUpstream(app, cookie, {
        name: "日常账户",
        type: "moemail",
        baseUrl: "https://moe-daily.test",
        apiKey: "key-daily",
      });
      for (const id of [bulkId, dailyId]) {
        await ctx.deps.stores.upstreams.replaceDomains(
          id,
          ["shared.test"].map((domain) => ({
            domain, upstreamId: id, isPrivate: false, enabled: true, syncedAt: new Date(),
          })),
        );
      }

      const keyRes = await app.request("/admin/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "daily-only", channels: [dailyId] }),
      });
      dailyKey = ((await keyRes.json()) as { key: { key: string } }).key.key;
      ctx.captured.length = 0;
    });

    it("不带域名的 GET 不再扇出到白名单外渠道（只转发白名单内那一个）", async () => {
      const res = await app.request("/upstream/moemail/api/emails", {
        headers: { Authorization: `Bearer ${dailyKey}` },
      });
      expect(res.status).toBe(200);
      // 收窄后类型下只剩 1 个候选 → 走单实例直转，不再是合并响应
      expect(ctx.captured).toHaveLength(1);
      expect(ctx.captured[0]!.url).toBe("https://moe-daily.test/api/emails");
      expect(ctx.captured[0]!.headers["x-api-key"]).toBe("key-daily");
      expect(res.headers.get("x-gateway-merged-upstreams")).toBeNull();
      expect(res.headers.get("x-gateway-upstream-id")).toBe(dailyId);
    });

    it("不限渠道的 key 仍按原行为扇出合并（收窄只影响受限 key）", async () => {
      const res = await app.request("/upstream/moemail/api/emails", {
        headers: { Authorization: `Bearer ${unrestrictedKey}` },
      });
      expect(res.status).toBe(200);
      expect(ctx.captured).toHaveLength(2);
      expect(res.headers.get("x-gateway-merged-upstreams")).toBe("2");
    });

    it("带域名的 GET 选主落在白名单内，而不是「最早创建」的白名单外渠道", async () => {
      const res = await app.request("/upstream/moemail/api/lookup?address=user@shared.test", {
        headers: { Authorization: `Bearer ${dailyKey}` },
      });
      expect(res.status).toBe(200);
      // 旧行为：shared.test 的类型内最早登记是 bulk → 读到批量账户
      expect(ctx.captured).toHaveLength(1);
      expect(ctx.captured[0]!.headers["x-api-key"]).toBe("key-daily");
      expect(res.headers.get("x-gateway-upstream-id")).toBe(dailyId);
    });

    it("类型下全部渠道都在白名单外 → 403 CHANNEL_NOT_ALLOWED 且零转发", async () => {
      // channels: [] 会被规范化为「不限渠道」，所以白名单里放一个别的类型的实例：
      // 这样 moemail 类型下就没有任何可用候选
      const cfId = await ctx.createUpstream(app, cookie, {
        name: "cf实例",
        type: "cf-temp-email",
        baseUrl: "https://cf-only.test",
        apiKey: "key-cf",
      });
      const cfKeyRes = await app.request("/admin/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "cf-channel-only", channels: [cfId] }),
      });
      const cfKey = ((await cfKeyRes.json()) as { key: { key: string } }).key.key;
      ctx.captured.length = 0;

      const res = await app.request("/upstream/moemail/api/emails", {
        headers: { Authorization: `Bearer ${cfKey}` },
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CHANNEL_NOT_ALLOWED");
      expect(ctx.captured).toHaveLength(0);
    });

    it("DELETE 无域名时也只在白名单内命中（不再对白名单外渠道发删除）", async () => {
      const res = await app.request("/upstream/moemail/api/emails/some-id", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${dailyKey}` },
      });
      expect(res.status).toBe(200);
      expect(ctx.captured).toHaveLength(1);
      expect(ctx.captured[0]!.url).toBe("https://moe-daily.test/api/emails/some-id");
    });
  });
});

describe("透传邮箱列表过滤（看到的邮箱 = 能创建的域名）", () => {
  async function setupListScenario() {
    const ctx = makeCtx();
    const app = ctx.app;
    const session = await ctx.admin(ctx, app);
    const cookie = session.cookie;

    const moeId = await ctx.createUpstream(app, cookie, {
      name: "moe-list",
      type: "moemail",
      baseUrl: "https://moe-list.test",
      apiKey: "key-list",
    });
    ctx.deps.stores.upstreams.replaceDomains(
      moeId,
      ["good.test", "blocked.test"].map((domain) => ({
        domain, upstreamId: moeId, isPrivate: false, enabled: true, syncedAt: new Date(),
      })),
    );

    // 上游返回混合域名的邮箱列表
    ctx.setUpstreamResponse(200, {
      emails: [
        { id: "1", address: "ok@good.test" },
        { id: "2", address: "no@blocked.test" },
        { id: "3", address: "off@blocked.test" },
        { id: "4" }, // 无 address 的条目应保守保留
      ],
    });

    // 停用 blocked.test
    await app.request(`/admin/upstreams/${moeId}/domains/blocked.test`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ enabled: false }),
    });

    const keyRes = await app.request("/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "list-key", domains: ["good.test"] }),
    });
    const listKey = ((await keyRes.json()) as { key: { key: string } }).key.key;

    // 无限制 key
    const plainKey = session.gatewayKey;

    return { app, ctx, cookie, moeId, listKey, plainKey };
  }

  it("受限 key：列表只保留可用域名上的邮箱", async () => {
    const { app, moeId, listKey } = await setupListScenario();
    const res = await app.request(`/upstream/${moeId}/api/emails`, {
      headers: { Authorization: `Bearer ${listKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { emails: { id: string }[] };
    // blocked.test 已停用且不在白名单 → 只剩 good.test 的和无 address 的
    expect(body.emails.map((e) => e.id)).toEqual(["1", "4"]);
  });

  it("无限制 key：停用域名的邮箱同样被隐藏", async () => {
    const { app, moeId, plainKey } = await setupListScenario();
    const res = await app.request(`/upstream/${moeId}/api/emails`, {
      headers: { Authorization: `Bearer ${plainKey}` },
    });
    const body = (await res.json()) as { emails: { id: string }[] };
    expect(body.emails.map((e) => e.id)).toEqual(["1", "4"]);
  });

  it("类型寻址单实例同样过滤；非列表端点不受影响", async () => {
    const { app, ctx, moeId, plainKey } = await setupListScenario();
    const typeRes = await app.request(`/upstream/moemail/api/emails`, {
      headers: { Authorization: `Bearer ${plainKey}` },
    });
    const typeBody = (await typeRes.json()) as { emails: { id: string }[] };
    expect(typeBody.emails.map((e) => e.id)).toEqual(["1", "4"]);

    // 单邮箱详情端点（/api/emails/{id}）不做过滤
    ctx.setUpstreamResponse(200, { id: "2", address: "no@blocked.test", messages: [] });
    const detail = await app.request(`/upstream/${moeId}/api/emails/2`, {
      headers: { Authorization: `Bearer ${plainKey}` },
    });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { id: string }).id).toBe("2");
  });
});

describe("透传域名列表过滤（floatmail 域名下拉来源）", () => {
  it("moemail GET /api/config 的 emailDomains 只保留可用域名", async () => {
    const ctx = makeCtx();
    const app = ctx.app;
    const session = await ctx.admin(ctx, app);
    const cookie = session.cookie;

    const moeId = await ctx.createUpstream(app, cookie, {
      name: "moe-cfg",
      type: "moemail",
      baseUrl: "https://moe-cfg.test",
      apiKey: "key-cfg",
    });
    ctx.deps.stores.upstreams.replaceDomains(
      moeId,
      ["good.test", "blocked.test"].map((domain) => ({
        domain, upstreamId: moeId, isPrivate: false, enabled: true, syncedAt: new Date(),
      })),
    );
    // 先停用 blocked.test（上游 config 报三个域名：blocked 在网关停用、ghost 未同步）
    await app.request(`/admin/upstreams/${moeId}/domains/blocked.test`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ enabled: false }),
    });
    ctx.setUpstreamResponse(200, {
      emailDomains: "good.test, blocked.test, ghost.test",
      maxEmails: "99",
    });

    // 无限制 key：可用域名 = 已同步且启用 → blocked.test 消失、未同步的 ghost.test 也消失
    const res = await app.request(`/upstream/${moeId}/api/config`, {
      headers: { Authorization: `Bearer ${session.gatewayKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { emailDomains: string; maxEmails: string };
    expect(body.emailDomains).toBe("good.test");
    expect(body.maxEmails).toBe("99"); // 其余字段原样保留

    // 全部停用后 emailDomains 为空
    await ctx.deps.stores.upstreams.setAllDomainsEnabled(moeId, false);
    const empty = await app.request(`/upstream/${moeId}/api/config`, {
      headers: { Authorization: `Bearer ${session.gatewayKey}` },
    });
    expect(((await empty.json()) as { emailDomains: string }).emailDomains).toBe("");
  });

  it("cf GET /open_api/settings 的 domains 只保留可用域名", async () => {
    const ctx = makeCtx();
    const app = ctx.app;
    const session = await ctx.admin(ctx, app);
    const cookie = session.cookie;

    const cfId = await ctx.createUpstream(app, cookie, {
      name: "cf-domctl",
      type: "cf-temp-email",
      baseUrl: "https://cf-domctl.test",
      apiKey: "cf-admin-token",
    });
    ctx.deps.stores.upstreams.replaceDomains(
      cfId,
      ["cfgood.test", "cfblocked.test"].map((domain) => ({
        domain, upstreamId: cfId, isPrivate: false, enabled: true, syncedAt: new Date(),
      })),
    );
    ctx.setUpstreamResponse(200, {
      domains: ["cfgood.test", "cfblocked.test", "cfgood2.test"],
      needAuth: false,
    });
    await app.request(`/admin/upstreams/${cfId}/domains/cfblocked.test`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ enabled: false }),
    });

    const res = await app.request(`/upstream/${cfId}/open_api/settings`, {
      headers: { Authorization: `Bearer ${session.gatewayKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domains: string[]; needAuth: boolean };
    // cfgood2.test 未同步进网关注册表 → 被过滤
    expect(body.domains).toEqual(["cfgood.test"]);
    expect(body.needAuth).toBe(false);
  });

  it("yyds GET /v1/domains 信封内的 data 数组只保留可用域名", async () => {
    const ctx = makeCtx();
    const app = ctx.app;
    const session = await ctx.admin(ctx, app);

    // 用 yydsmail 真适配器 + 模拟上游
    ctx.deps.registry.register(new YydsMailAdapter({ fetchFn: ctx.mockFetch }), {
      displayName: "YYDS",
      description: "test",
    });
    const yydsId = await ctx.createUpstream(app, session.cookie, {
      name: "yyds-domctl",
      type: "yydsmail",
      baseUrl: "https://yyds-domctl.test",
      apiKey: "AC-test",
    });
    ctx.deps.stores.upstreams.replaceDomains(
      yydsId,
      ["ygood.test", "yblocked.test"].map((domain) => ({
        domain, upstreamId: yydsId, isPrivate: false, enabled: true, syncedAt: new Date(),
      })),
    );
    ctx.setUpstreamResponse(200, {
      success: true,
      data: [
        { domain: "ygood.test", isPublic: true },
        { domain: "yblocked.test", isPublic: true },
      ],
    });
    await app.request(`/admin/upstreams/${yydsId}/domains/yblocked.test`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: session.cookie },
      body: JSON.stringify({ enabled: false }),
    });

    const res = await app.request(`/upstream/${yydsId}/v1/domains`, {
      headers: { Authorization: `Bearer ${session.gatewayKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { domain: string }[] };
    expect(body.success).toBe(true);
    expect(body.data.map((d) => d.domain)).toEqual(["ygood.test"]);
  });
});

// ---------- 矩阵测试：共享域名 × 访问路径 × 开关状态（§9.7 建议 5） ----------

/**
 * 三轮审查的漏项全部落在"某条路径没跟上"，这里用矩阵一次收口：
 * 两个 moemail 渠道共享 shared.test（X 先建 = 最早的启用实例，统一 API 与类型
 * 寻址的选主都落到它），对每条访问路径 × 每种开关状态断言期望行为。
 * （跨类型的全局选主干扰已由 R-03 专门用例覆盖，矩阵不重复造 cf。）
 * 核心不变量：域名开关只约束"建箱"（写）；读信/清理（GET/DELETE）不受域名开关
 * 影响；上游实例停用则读写都不可达。
 */
describe("矩阵：共享域名 × 四条访问路径 × 开关状态", () => {
  let ctx: ReturnType<typeof makeCtx>;
  let app: ReturnType<typeof makeCtx>["app"];
  let captured: CapturedRequest[];
  let cookie: string;
  let gatewayKey: string;
  let xId: string; // moemail 先建
  let yId: string; // moemail 后建

  beforeEach(async () => {
    ctx = makeCtx();
    app = ctx.app;
    captured = ctx.captured;
    const session = await ctx.admin(ctx, app);
    cookie = session.cookie;
    gatewayKey = session.gatewayKey;

    xId = await ctx.createUpstream(app, cookie, {
      name: "moemail-X", type: "moemail", baseUrl: "https://mx-x.test", apiKey: "k-x",
    });
    yId = await ctx.createUpstream(app, cookie, {
      name: "moemail-Y", type: "moemail", baseUrl: "https://mx-y.test", apiKey: "k-y",
    });
    const register = (id: string, domains: string[]) =>
      ctx.deps.stores.upstreams.replaceDomains(
        id,
        domains.map((domain) => ({
          domain, upstreamId: id, isPrivate: false, enabled: true, syncedAt: new Date(),
        })),
      );
    register(xId, ["shared.test"]);
    register(yId, ["shared.test"]);
    // mock：generate 返回邮箱；/api/emails/{id}（listMessages/读详情）返回消息列表
    ctx.setResponder((req) => {
      if (req.url.endsWith("/api/emails/generate")) {
        return { status: 200, body: { id: `m-${Math.random().toString(36).slice(2, 8)}`, email: "auto@shared.test" } };
      }
      if (req.url.includes("/api/emails/")) {
        return { status: 200, body: { messages: [] } }; // listMessages 读信 shape
      }
      return { status: 200, body: { ok: true } };
    });
    captured.length = 0;
  });

  const authHeader = () => ({ Authorization: `Bearer ${gatewayKey}` });
  const admin = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  // 统一 API 建箱（域名显式）与读信
  const v1Create = (domain: string) =>
    app.request("/v1/mailboxes", {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ domain, localPart: `u${Math.random().toString(36).slice(2, 8)}` }),
    });
  // 类型寻址透传：GET 读（定向 shared.test）、POST 写（建箱）
  const typeGet = () =>
    app.request(`/upstream/moemail/api/emails?address=someone@shared.test`, { headers: authHeader() });
  const typePost = () =>
    app.request(`/upstream/moemail/api/emails/generate`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "u", domain: "shared.test", expiryTime: 3_600_000 }),
    });
  // 按 ID 寻址透传（X）：GET 读 + POST 写
  const idGet = () =>
    app.request(`/upstream/${xId}/api/emails?address=someone@shared.test`, { headers: authHeader() });
  const idPost = () =>
    app.request(`/upstream/${xId}/api/emails/generate`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "u", domain: "shared.test", expiryTime: 3_600_000 }),
    });

  it("状态①全启用：统一 API 建箱路由 X（最早启用实例）；类型寻址读写都 200", async () => {
    // 统一 API 建箱 → X
    const created = await v1Create("shared.test");
    expect(created.status).toBe(201);
    expect(((await created.json()) as { mailbox: { upstreamId: string } }).mailbox.upstreamId).toBe(xId);

    // 类型寻址写 → X；读 → X（X 是最早启用实例，cf 不是 moemail 类型）
    expect((await typePost()).status).toBe(200);
    expect((await typeGet()).status).toBe(200);
    // 统一 API 建箱(1) + 类型写(1) + 类型读(1) 都路由到 X
    expect(captured.filter((r) => r.url.startsWith("https://mx-x.test"))).toHaveLength(3);
  });

  it("状态②X 域名行停用：统一 API 建箱落 Y；类型寻址读仍 200（落到 X，读不受域名开关约束）；写落 Y", async () => {
    await admin("PUT", `/admin/upstreams/${xId}/domains/shared.test`, { enabled: false });

    // 统一 API 建箱：X 的域名行停用 → 候选感知落到 Y
    const created = await v1Create("shared.test");
    expect(created.status).toBe(201);
    expect(((await created.json()) as { mailbox: { upstreamId: string } }).mailbox.upstreamId).toBe(yId);

    // 类型寻址写：X 停用 → Y
    const post = await typePost();
    expect(post.status).toBe(200);
    expect(post.headers.get("x-gateway-upstream-id")).toBe(yId);

    // 类型寻址读：域名停用不影响读 → 仍路由 X（最早的启用实例）
    const get = await typeGet();
    expect(get.status).toBe(200);
    expect(get.headers.get("x-gateway-upstream-id")).toBe(xId);

    // 按 ID（X）写：X 自己的域名行停用 → 403 DOMAIN_DISABLED；读 → 200
    const xPost = await idPost();
    expect(xPost.status).toBe(403);
    expect(((await xPost.json()) as { error: { code: string } }).error.code).toBe("DOMAIN_DISABLED");
    expect((await idGet()).status).toBe(200);
  });

  it("状态③X 实例停用：统一 API 建箱落 Y；类型寻址写落 Y；X 的 ID 寻址读/写都 403 FORBIDDEN", async () => {
    await admin("PUT", `/admin/upstreams/${xId}`, { enabled: false });

    const created = await v1Create("shared.test");
    expect(created.status).toBe(201);
    expect(((await created.json()) as { mailbox: { upstreamId: string } }).mailbox.upstreamId).toBe(yId);

    const post = await typePost();
    expect(post.status).toBe(200);
    expect(post.headers.get("x-gateway-upstream-id")).toBe(yId);
    expect((await typeGet()).status).toBe(200);

    const xGet = await idGet();
    expect(xGet.status).toBe(403);
    expect(((await xGet.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("统一 API 读信：域名停用后，存量邮箱消息仍可读（归属 key 校验放行）", async () => {
    // 先经统一 API 建箱（落 X，X 的域名行启用）
    const created = await v1Create("shared.test");
    expect(created.status).toBe(201);
    const { mailbox } = (await created.json()) as { mailbox: { id: string; upstreamId: string } };
    expect(mailbox.upstreamId).toBe(xId);

    // 停用 X 的域名行——存量邮箱不受域名开关影响
    await admin("PUT", `/admin/upstreams/${xId}/domains/shared.test`, { enabled: false });

    const msgs = await app.request(`/v1/mailboxes/${mailbox.id}/messages`, { headers: authHeader() });
    expect(msgs.status).toBe(200);
    // mock 对 GET /api/emails/{id} 返回 {ok:true}？moemail listMessages 的路径——不深究内容，只验证可达
    expect(msgs.status).toBe(200);
  });
});
