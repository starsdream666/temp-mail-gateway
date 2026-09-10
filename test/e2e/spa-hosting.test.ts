import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { resolve } from "node:path";
import { createDrizzleStores } from "../../src/adapters/stores/drizzle";
import { createWebCryptoCipher } from "../../src/adapters/crypto/webcrypto";
import { buildDeps } from "../../src/bootstrap";
import { createApp, type SpaAssets } from "../../src/core/app";
import { runMigrations } from "../../src/db/migrate-node";

/**
 * SPA 托管接入：静态资源、API、SPA 回退三者的路由优先级不得互相抢占。
 * 用一个假的 SpaAssets 替代真实 frontend/dist，使测试不依赖前端是否已构建。
 */

const INDEX_HTML = "<!doctype html><html><body><div id=\"root\"></div></body></html>";

function makeApp(withAssets: boolean) {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite, resolve("migrations"));

  const assets: SpaAssets | undefined = withAssets
    ? {
        // 模拟 serveStatic：只认 /assets/ 前缀，其余交给后续路由
        middleware: async (c, next) => {
          if (c.req.path.startsWith("/assets/")) {
            return c.body("console.log('bundle')", 200, { "Content-Type": "text/javascript" });
          }
          await next();
        },
        indexHtml: (c) => c.html(INDEX_HTML),
      }
    : undefined;

  return createApp({
    ...buildDeps({
      stores: createDrizzleStores(drizzle(sqlite) as never),
      crypto: createWebCryptoCipher("spa-test-master-key-0123456789"),
      config: { adminPassword: "spa-pw", masterKey: "spa-test-master-key-0123456789" },
    }),
    assets,
  });
}

describe("SPA 托管模式", () => {
  const app = makeApp(true);

  it("根路径返回 SPA index.html", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('id="root"');
  });

  it("静态资源由资源中间件命中", async () => {
    const res = await app.request("/assets/index-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("前端深链（/upstreams、/keys）回退到 index.html 交给前端路由", async () => {
    for (const path of ["/upstreams", "/keys", "/mailboxes", "/login", "/deep/nested/route"]) {
      const res = await app.request(path);
      expect(res.status, `${path} 应回退 SPA`).toBe(200);
      expect(await res.text()).toContain('id="root"');
    }
  });

  it("API 命名空间不被 SPA 回退吞掉：未授权仍是 JSON 401", async () => {
    const v1 = await app.request("/v1/domains");
    expect(v1.status).toBe(401);
    expect(v1.headers.get("content-type")).toContain("application/json");
    expect(((await v1.json()) as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");

    const adminMe = await app.request("/admin/me");
    expect(adminMe.status).toBe(401);
    expect(adminMe.headers.get("content-type")).toContain("application/json");
  });

  it("API 命名空间下的未知路径返回 JSON 而非 HTML", async () => {
    // 未授权时鉴权中间件先拦截（401 早于 404，避免向匿名调用者暴露端点是否存在）
    const anon = await app.request("/v1/nope");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("content-type")).toContain("application/json");

    // 带有效 key 时才暴露 404，且必须是 JSON 信封
    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "spa-pw" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const keyRes = await app.request("/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "spa-404" }),
    });
    const key = ((await keyRes.json()) as { key: { key: string } }).key.key;

    const res = await app.request("/v1/nope", { headers: { Authorization: `Bearer ${key}` } });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("OpenAPI 文档与 /api/info 仍可访问", async () => {
    expect((await app.request("/api/doc")).status).toBe(200);
    const info = await app.request("/api/info");
    expect(info.status).toBe(200);
    expect(((await info.json()) as { name: string }).name).toBe("temp-mail-gateway");
  });
});

describe("纯 API 模式（未构建前端）", () => {
  const app = makeApp(false);

  it("根路径返回服务信息 JSON", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { name: string }).name).toBe("temp-mail-gateway");
  });

  it("非 API 路径返回 JSON 404（无 SPA 可回退）", async () => {
    const res = await app.request("/upstreams");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("登录限速", () => {
  it("同一来源连续错误登录触发 429", async () => {
    const app = makeApp(false);
    const attempt = () =>
      app.request("/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9" },
        body: JSON.stringify({ password: "wrong" }),
      });

    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await attempt()).status);

    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
