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
import { newId } from "../../src/core/ids";
import type { GatewayDeps } from "../../src/core/app";

/**
 * 统一 API 的邮箱列表（G1）、删除分档（G2）与过期清理（G4）。
 * 核心不变量：列表按 apiKeyId 严格归属——透传自动登记的共享记录（apiKeyId 为 null）
 * 默认不出现在任何 key 的列表里，否则批量注册的邮箱会灌进普通客户端；
 * 而读取口径仍允许访问共享记录（requireMailbox），两者刻意不同。
 */

const ADMIN_PASSWORD = "test-admin-pw";
const MASTER_KEY = "test-master-key-0123456789";

describe("统一 API：邮箱列表 / 删除分档 / 过期清理", () => {
  let app: ReturnType<typeof createApp>;
  let deps: GatewayDeps;
  let dummy: ReturnType<typeof registerDummyAdapter>;
  let cookie: string;
  let upstreamId: string;

  async function admin(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** 签发一把 key，返回明文与行 id */
  async function issueKey(name: string): Promise<{ key: string; id: string }> {
    const res = await admin("POST", "/admin/keys", { name });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: { id: string; key: string } };
    return { key: body.key.key, id: body.key.id };
  }

  async function createMailbox(key: string, localPart: string): Promise<string> {
    const res = await app.request("/v1/mailboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ domain: "m.test", localPart }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { mailbox: { id: string } }).mailbox.id;
  }

  async function listMailboxes(key: string, query = "") {
    const res = await app.request(`/v1/mailboxes${query}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { total: number; mailboxes: { id: string; address: string }[] };
  }
  beforeEach(async () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite, resolve("migrations"));
    deps = buildDeps({
      stores: createDrizzleStores(drizzle(sqlite) as never),
      crypto: createWebCryptoCipher(MASTER_KEY),
      config: { adminPassword: ADMIN_PASSWORD, masterKey: MASTER_KEY },
    });
    dummy = registerDummyAdapter(deps);
    dummy.reset();
    app = createApp(deps);

    const login = await app.request("/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(204);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const up = await admin("POST", "/admin/upstreams", {
      name: "d1",
      type: "dummy",
      baseUrl: "memory://d1",
      settings: { domains: ["m.test"] },
    });
    expect(up.status).toBe(201);
    upstreamId = ((await up.json()) as { upstream: { id: string } }).upstream.id;
  });

  describe("G1 列表归属与过滤", () => {
    it("只列出本 key 创建的邮箱，看不到其他 key 的", async () => {
      const a = await issueKey("A");
      const b = await issueKey("B");
      await createMailbox(a.key, "a1");
      await createMailbox(a.key, "a2");
      await createMailbox(b.key, "b1");

      const listA = await listMailboxes(a.key);
      expect(listA.total).toBe(2);
      expect(listA.mailboxes.map((m) => m.address).sort()).toEqual(["a1@m.test", "a2@m.test"]);

      const listB = await listMailboxes(b.key);
      expect(listB.total).toBe(1);
      expect(listB.mailboxes[0]!.address).toBe("b1@m.test");
    });

    it("透传登记的共享记录（apiKeyId 为 null）默认不列出，includeShared 才并入", async () => {
      const a = await issueKey("A");
      await createMailbox(a.key, "mine");
      // 模拟透传自动登记：passthrough.ts 写入的记录 apiKeyId 恒为 null
      await deps.stores.mailboxes.create({
        id: newId(),
        upstreamId,
        address: "viapassthrough@m.test",
        localPart: "viapassthrough",
        domain: "m.test",
        upstreamMailboxId: "dm_viapassthrough@m.test",
        credentialsEnc: null,
        passwordEnc: null,
        apiKeyId: null,
        expiresAt: null,
      });

      const strict = await listMailboxes(a.key);
      expect(strict.total).toBe(1);
      expect(strict.mailboxes.map((m) => m.address)).toEqual(["mine@m.test"]);

      const shared = await listMailboxes(a.key, "?includeShared=1");
      expect(shared.total).toBe(2);
      expect(shared.mailboxes.map((m) => m.address).sort()).toEqual([
        "mine@m.test",
        "viapassthrough@m.test",
      ]);
    });

    it("已过期记录默认不列出，includeExpired 才并入", async () => {
      const a = await issueKey("A");
      await createMailbox(a.key, "alive");
      await deps.stores.mailboxes.create({
        id: newId(),
        upstreamId,
        address: "dead@m.test",
        localPart: "dead",
        domain: "m.test",
        upstreamMailboxId: "dm_dead@m.test",
        credentialsEnc: null,
        passwordEnc: null,
        apiKeyId: a.id,
        expiresAt: new Date(Date.now() - 60_000),
      });

      const fresh = await listMailboxes(a.key);
      expect(fresh.mailboxes.map((m) => m.address)).toEqual(["alive@m.test"]);
      // total 必须与列表同口径，否则前端分页页码算错
      expect(fresh.total).toBe(1);

      const all = await listMailboxes(a.key, "?includeExpired=true");
      expect(all.total).toBe(2);
    });

    it("分页：limit/offset 生效且 total 为过滤后的总数（新→旧）", async () => {
      const a = await issueKey("A");
      for (const localPart of ["p1", "p2", "p3"]) await createMailbox(a.key, localPart);

      const page1 = await listMailboxes(a.key, "?limit=2");
      expect(page1.total).toBe(3);
      expect(page1.mailboxes).toHaveLength(2);

      const page2 = await listMailboxes(a.key, "?limit=2&offset=2");
      expect(page2.total).toBe(3);
      expect(page2.mailboxes).toHaveLength(1);

      const seen = [...page1.mailboxes, ...page2.mailboxes].map((m) => m.address).sort();
      expect(seen).toEqual(["p1@m.test", "p2@m.test", "p3@m.test"]);
    });
  });

  describe("G2 删除分档", () => {
    async function del(key: string, id: string, query = "") {
      return app.request(`/v1/mailboxes/${id}${query}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key}` },
      });
    }

    it("默认严格语义：上游删除失败 → 502 且保留网关记录", async () => {
      const a = await issueKey("A");
      const id = await createMailbox(a.key, "strict");
      dummy.failDeleteMailbox("UNAVAILABLE");

      const res = await del(a.key, id);
      expect(res.status).toBe(502);
      expect(await deps.stores.mailboxes.get(id)).not.toBeNull();
    });

    it("force=1：上游失败也删记录，并如实回报 upstreamDeleted=false", async () => {
      const a = await issueKey("A");
      const id = await createMailbox(a.key, "forced");
      dummy.failDeleteMailbox("UNAVAILABLE");

      const res = await del(a.key, id, "?force=1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        deleted: boolean;
        upstreamDeleted: boolean;
        upstreamError?: { code: string; message: string };
      };
      expect(body.deleted).toBe(true);
      expect(body.upstreamDeleted).toBe(false);
      expect(body.upstreamError?.code).toBe("UNAVAILABLE");
      expect(await deps.stores.mailboxes.get(id)).toBeNull();
    });

    it("上游报「不存在」视为幂等成功：无需 force 也删记录并回 204", async () => {
      const a = await issueKey("A");
      const id = await createMailbox(a.key, "gone");
      dummy.failDeleteMailbox("NOT_FOUND");

      const res = await del(a.key, id);
      expect(res.status).toBe(204);
      expect(await deps.stores.mailboxes.get(id)).toBeNull();
    });

    it("凭证型上游（如 DuckMail）拒绝 force：409 且保留记录，留住重试能力", async () => {
      const a = await issueKey("A");
      const id = await createMailbox(a.key, "credbound");
      dummy.requiresMailboxCredentials = true;
      dummy.failDeleteMailbox("UNAVAILABLE");

      const res = await del(a.key, id, "?force=1");
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("FORCE_DELETE_UNSAFE");
      expect(await deps.stores.mailboxes.get(id)).not.toBeNull();
    });

    it("凭证型上游的上游「不存在」仍算幂等成功（不需要 force）", async () => {
      const a = await issueKey("A");
      const id = await createMailbox(a.key, "credgone");
      dummy.requiresMailboxCredentials = true;
      dummy.failDeleteMailbox("NOT_FOUND");

      const res = await del(a.key, id, "?force=1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { upstreamDeleted: boolean };
      expect(body.upstreamDeleted).toBe(false);
      expect(await deps.stores.mailboxes.get(id)).toBeNull();
    });

    it("一切正常时 force 也回报 upstreamDeleted=true", async () => {
      const a = await issueKey("A");
      const id = await createMailbox(a.key, "clean");
      const res = await del(a.key, id, "?force=true");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { upstreamDeleted: boolean; upstreamError?: unknown };
      expect(body.upstreamDeleted).toBe(true);
      expect(body.upstreamError).toBeUndefined();
    });

    it("force=0 视为未启用（不认任意非空字符串为真）", async () => {
      const a = await issueKey("A");
      const id = await createMailbox(a.key, "notforced");
      dummy.failDeleteMailbox("UNAVAILABLE");
      expect((await del(a.key, id, "?force=0")).status).toBe(502);
      expect((await del(a.key, id, "?force=false")).status).toBe(502);
      expect(await deps.stores.mailboxes.get(id)).not.toBeNull();
    });
  });

  describe("G4 过期记录清理", () => {
    it("只删已过期记录，未到期与无到期时间的都保留，且不向上游发请求", async () => {
      const a = await issueKey("A");
      const alive = await createMailbox(a.key, "keepalive");
      const future = await deps.stores.mailboxes.create({
        id: newId(),
        upstreamId,
        address: "future@m.test",
        localPart: "future",
        domain: "m.test",
        upstreamMailboxId: "dm_future@m.test",
        credentialsEnc: null,
        passwordEnc: null,
        apiKeyId: a.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      const expired = await deps.stores.mailboxes.create({
        id: newId(),
        upstreamId,
        address: "expired@m.test",
        localPart: "expired",
        domain: "m.test",
        upstreamMailboxId: "dm_expired@m.test",
        credentialsEnc: null,
        passwordEnc: null,
        apiKeyId: a.id,
        expiresAt: new Date(Date.now() - 1000),
      });
      // 上游侧仍存在这个邮箱：清理只删网关记录，不应触发上游删除
      dummy.failDeleteMailbox("UNAVAILABLE");

      const res = await admin("POST", "/admin/mailboxes/prune-expired");
      expect(res.status).toBe(200);
      expect((await res.json()) as { deleted: number }).toEqual({ deleted: 1 });

      expect(await deps.stores.mailboxes.get(expired.id)).toBeNull();
      expect(await deps.stores.mailboxes.get(future.id)).not.toBeNull();
      expect(await deps.stores.mailboxes.get(alive)).not.toBeNull();
    });

    it("未登录不可调用清理", async () => {
      const res = await app.request("/admin/mailboxes/prune-expired", { method: "POST" });
      expect(res.status).toBe(401);
    });
  });

  describe("G9 地址纳管（POST /admin/mailboxes/import）", () => {
    /**
     * 造一个「上游有、网关注册表没有」的邮箱——正是纳管要解决的场景。
     * 直接调适配器建箱，绕过统一 API，所以不会写入网关注册表。
     */
    async function createUpstreamOnly(localPart: string): Promise<string> {
      const cfg = { id: upstreamId, type: "dummy", baseUrl: "memory://d1", settings: { domains: ["m.test"] } };
      const ref = await dummy.createMailbox(cfg, { localPart, domain: "m.test" });
      return ref.address;
    }

    async function importAddresses(addresses: string[], apiKeyId?: string | null) {
      const res = await admin("POST", "/admin/mailboxes/import", { addresses, apiKeyId });
      return {
        status: res.status,
        body: (await res.json()) as {
          imported?: { address: string; id: string; upstreamId: string }[];
          failed?: { address: string; code: string; message: string }[];
          error?: { code: string; message: string };
        },
      };
    }

    it("纳管上游已存在的地址：登记后统一 API 可读", async () => {
      const a = await issueKey("A");
      const address = await createUpstreamOnly("legacy1");
      // 纳管前：统一 API 完全看不到它
      expect(await deps.stores.mailboxes.findByAddress(address)).toBeNull();

      const { status, body } = await importAddresses([address], a.id);
      expect(status).toBe(200);
      expect(body.failed).toEqual([]);
      expect(body.imported).toHaveLength(1);
      expect(body.imported![0]!.address).toBe(address);
      expect(body.imported![0]!.upstreamId).toBe(upstreamId);

      // 纳管后：归属该 key，列表可见、收件箱可读
      const listed = await listMailboxes(a.key);
      expect(listed.mailboxes.map((m) => m.address)).toContain(address);
      const msgs = await app.request(`/v1/mailboxes/${body.imported![0]!.id}/messages`, {
        headers: { Authorization: `Bearer ${a.key}` },
      });
      expect(msgs.status).toBe(200);
    });

    it("上游不存在该地址 → 单条失败 UPSTREAM_NOT_FOUND，不写注册表", async () => {
      const { status, body } = await importAddresses(["ghost@m.test"]);
      expect(status).toBe(200);
      expect(body.imported).toEqual([]);
      expect(body.failed).toHaveLength(1);
      expect(body.failed![0]!.code).toBe("UPSTREAM_NOT_FOUND");
      expect(await deps.stores.mailboxes.findByAddress("ghost@m.test")).toBeNull();
    });

    it("逐地址独立结算：一个失败不影响其余地址", async () => {
      const ok1 = await createUpstreamOnly("mix1");
      const ok2 = await createUpstreamOnly("mix2");
      const { body } = await importAddresses([ok1, "ghost@m.test", ok2, "bad-address"]);
      expect(body.imported!.map((m) => m.address).sort()).toEqual([ok1, ok2].sort());
      expect(body.failed!.map((f) => f.code).sort()).toEqual(["UPSTREAM_NOT_FOUND", "VALIDATION_ERROR"]);
    });

    it("已在注册表中的地址 → CONFLICT，不重复登记", async () => {
      const a = await issueKey("A");
      await createMailbox(a.key, "already"); // 经统一 API 建，已在注册表
      const { body } = await importAddresses(["already@m.test"]);
      expect(body.imported).toEqual([]);
      expect(body.failed![0]!.code).toBe("CONFLICT");
    });

    it("域名不归属任何启用渠道 → DOMAIN_NOT_ROUTED", async () => {
      const { body } = await importAddresses(["someone@elsewhere.test"]);
      expect(body.failed![0]!.code).toBe("DOMAIN_NOT_ROUTED");
    });

    it("凭证型上游（无 resolveByAddress 能力）→ CAPABILITY_MISSING", async () => {
      const address = await createUpstreamOnly("nocap");
      dummy.hideResolveByAddress(true);
      const { body } = await importAddresses([address]);
      expect(body.imported).toEqual([]);
      expect(body.failed![0]!.code).toBe("CAPABILITY_MISSING");
      expect(body.failed![0]!.message).toContain("每邮箱独立凭证");
    });

    it("缺省 apiKeyId 登记为共享邮箱：任何 key 可读，但默认不进列表", async () => {
      const a = await issueKey("A");
      const address = await createUpstreamOnly("sharedone");
      const { body } = await importAddresses([address]); // 不传 apiKeyId
      expect(body.imported).toHaveLength(1);

      // 严格列表口径：共享记录默认不出现
      expect((await listMailboxes(a.key)).mailboxes.map((m) => m.address)).not.toContain(address);
      // 开 includeShared 才出现
      expect(
        (await listMailboxes(a.key, "?includeShared=1")).mailboxes.map((m) => m.address),
      ).toContain(address);
      // 但读取口径宽松：任何 key 都能读它
      const detail = await app.request(`/v1/mailboxes/${body.imported![0]!.id}`, {
        headers: { Authorization: `Bearer ${a.key}` },
      });
      expect(detail.status).toBe(200);
    });

    it("指定不存在的 apiKeyId → 404，整批不执行", async () => {
      const address = await createUpstreamOnly("badkey");
      const { status, body } = await importAddresses([address], "no-such-key");
      expect(status).toBe(404);
      expect(body.error!.code).toBe("NOT_FOUND");
      expect(await deps.stores.mailboxes.findByAddress(address)).toBeNull();
    });

    it("未登录不可纳管", async () => {
      const res = await app.request("/admin/mailboxes/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addresses: ["x@m.test"] }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("尽力删除的残留可见性（孤儿记录）", () => {
    async function listOrphans() {
      const res = await admin("GET", "/admin/orphan-mailboxes");
      expect(res.status).toBe(200);
      return (await res.json()) as {
        orphans: { id: string; address: string; upstreamName: string; errorCode: string | null; error: string | null }[];
      };
    }

    it("force 删除时上游失败 → 记一条残留，带地址与上游错误", async () => {
      const a = await issueKey("A");
      const id = await createMailbox(a.key, "leftover");
      dummy.failDeleteMailbox("UNAVAILABLE");

      const res = await app.request(`/v1/mailboxes/${id}?force=1`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${a.key}` },
      });
      expect(res.status).toBe(200);

      const { orphans } = await listOrphans();
      expect(orphans).toHaveLength(1);
      expect(orphans[0]!.address).toBe("leftover@m.test");
      expect(orphans[0]!.upstreamName).toBe("d1");
      expect(orphans[0]!.errorCode).toBe("UNAVAILABLE");
      expect(orphans[0]!.error).toContain("dummy");
    });

    it("上游报「不存在」不算残留（上游本来就没了，无需人工清理）", async () => {
      const a = await issueKey("A");
      const id = await createMailbox(a.key, "gonealready");
      dummy.failDeleteMailbox("NOT_FOUND");

      const res = await app.request(`/v1/mailboxes/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${a.key}` },
      });
      expect(res.status).toBe(204);
      expect((await listOrphans()).orphans).toHaveLength(0);
    });

    it("删除成功不留残留", async () => {
      const a = await issueKey("A");
      const id = await createMailbox(a.key, "clean");
      const res = await app.request(`/v1/mailboxes/${id}?force=1`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${a.key}` },
      });
      expect(res.status).toBe(200);
      expect((await listOrphans()).orphans).toHaveLength(0);
    });

    it("严格删除（无 force）被 502 拦下时也不留残留：记录还在，谈不上孤儿", async () => {
      const a = await issueKey("A");
      const id = await createMailbox(a.key, "strictkeep");
      dummy.failDeleteMailbox("UNAVAILABLE");

      const res = await app.request(`/v1/mailboxes/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${a.key}` },
      });
      expect(res.status).toBe(502);
      expect(await deps.stores.mailboxes.get(id)).not.toBeNull();
      expect((await listOrphans()).orphans).toHaveLength(0);
    });

    it("可逐条消账与整体清空", async () => {
      const a = await issueKey("A");
      dummy.failDeleteMailbox("UNAVAILABLE");
      for (const localPart of ["o1", "o2", "o3"]) {
        const id = await createMailbox(a.key, localPart);
        await app.request(`/v1/mailboxes/${id}?force=1`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${a.key}` },
        });
      }
      let { orphans } = await listOrphans();
      expect(orphans).toHaveLength(3);

      const one = await admin("DELETE", `/admin/orphan-mailboxes/${orphans[0]!.id}`);
      expect(one.status).toBe(204);
      ({ orphans } = await listOrphans());
      expect(orphans).toHaveLength(2);

      const all = await admin("DELETE", "/admin/orphan-mailboxes");
      expect(all.status).toBe(200);
      expect((await all.json()) as { deleted: number }).toEqual({ deleted: 2 });
      expect((await listOrphans()).orphans).toHaveLength(0);
    });

    it("未登录不可读写残留列表", async () => {
      expect((await app.request("/admin/orphan-mailboxes")).status).toBe(401);
      expect((await app.request("/admin/orphan-mailboxes", { method: "DELETE" })).status).toBe(401);
    });
  });

  describe("过期邮箱的读写分档（410 MAILBOX_EXPIRED）", () => {
    /** 造一条已过期的、归属该 key 的记录 */
    async function makeExpired(apiKeyId: string) {
      return deps.stores.mailboxes.create({
        id: newId(),
        upstreamId,
        address: `stale-${apiKeyId}@m.test`,
        localPart: `stale-${apiKeyId}`,
        domain: "m.test",
        upstreamMailboxId: `dm_stale-${apiKeyId}@m.test`,
        credentialsEnc: null,
        passwordEnc: null,
        apiKeyId,
        expiresAt: new Date(Date.now() - 60_000),
      });
    }

    it("读信/读单封/删单封/原始报文 → 410，且明确指出已过期（不再退化成上游 502）", async () => {
      const a = await issueKey("A");
      const row = await makeExpired(a.id);
      const auth = { Authorization: `Bearer ${a.key}` };

      const paths = [
        `/v1/mailboxes/${row.id}/messages`,
        `/v1/mailboxes/${row.id}/messages/whatever`,
        `/v1/mailboxes/${row.id}/messages/whatever/source`,
      ];
      for (const path of paths) {
        const res = await app.request(path, { headers: auth });
        expect(res.status).toBe(410);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("MAILBOX_EXPIRED");
        expect(body.error.message).toContain("已于");
      }

      const del = await app.request(`/v1/mailboxes/${row.id}/messages/whatever`, {
        method: "DELETE",
        headers: auth,
      });
      expect(del.status).toBe(410);
    });

    it("详情与删除自身放行过期记录：客户端要能看到状态、也要能删掉它", async () => {
      const a = await issueKey("A");
      const row = await makeExpired(a.id);
      const auth = { Authorization: `Bearer ${a.key}` };

      const detail = await app.request(`/v1/mailboxes/${row.id}`, { headers: auth });
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as { mailbox: { expiresAt: string | null } };
      expect(body.mailbox.expiresAt).toBeTruthy();

      const del = await app.request(`/v1/mailboxes/${row.id}`, { method: "DELETE", headers: auth });
      expect(del.status).toBe(204);
      expect(await deps.stores.mailboxes.get(row.id)).toBeNull();
    });

    it("未过期与无到期时间的邮箱读信不受影响", async () => {
      const a = await issueKey("A");
      const id = await createMailbox(a.key, "fresh"); // dummy 建箱不带 expiresAt
      const res = await app.request(`/v1/mailboxes/${id}/messages`, {
        headers: { Authorization: `Bearer ${a.key}` },
      });
      expect(res.status).toBe(200);
    });

    it("其他 key 的过期邮箱仍按 404 处理（租户隔离优先于过期判定，不泄露 ID 存在性）", async () => {
      const a = await issueKey("A");
      const b = await issueKey("B");
      const row = await makeExpired(a.id);
      const res = await app.request(`/v1/mailboxes/${row.id}/messages`, {
        headers: { Authorization: `Bearer ${b.key}` },
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MAILBOX_NOT_FOUND");
    });
  });
});
