import { describe, expect, it } from "vitest";
import { YydsMailAdapter } from "../../src/adapters/upstreams/yydsmail";
import { runAdapterContractTests } from "./adapter-contract";
import { createYydsMailMock, yydsCfg } from "./mocks/yydsmail-mock";

describe("yydsmail adapter", () => {
  const mock = createYydsMailMock(["yyds.test", "alt.yyds.test"]);
  const adapter = new YydsMailAdapter({ fetchFn: mock.fetch });

  runAdapterContractTests("yydsmail", () => ({
    adapter,
    cfg: yydsCfg("cfg-yyds", mock),
    supports: { deleteMessage: true, getSource: true },
    deliver: async (mailboxId, subject) =>
      mock.deliverMessage(mailboxId, {
        from: { name: "Sender", address: "sender@example.org" },
        subject,
        text: `body of ${subject}`,
      }),
  }));
});

describe("yydsmail 适配器细节", () => {
  it("baseUrl 带 /v1 与不带 /v1 两种写法均可工作", async () => {
    const mock = createYydsMailMock(["base.test"]);
    const adapter = new YydsMailAdapter({ fetchFn: mock.fetch });

    const domains1 = await adapter.listDomains(yydsCfg("cfg-b1", mock));
    expect(domains1.map((d) => d.domain)).toContain("base.test");

    const cfg2 = { ...yydsCfg("cfg-b2", mock), baseUrl: `${mock.baseUrl}/v1` };
    const domains2 = await adapter.listDomains(cfg2);
    expect(domains2.map((d) => d.domain)).toContain("base.test");
  });

  it("createMailbox：携带 Idempotency-Key，credentials 存 temp token，expiresAt 取响应值", async () => {
    const mock = createYydsMailMock(["exp.test"]);
    let idempotencyKey: string | null = null;
    const adapter = new YydsMailAdapter({
      fetchFn: async (input, init) => {
        const key = (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"];
        if (String(input).endsWith("/v1/accounts") && key) idempotencyKey = key;
        return mock.fetch(input, init);
      },
    });
    const cfg = yydsCfg("cfg-c1", mock);

    const before = Date.now();
    const ref = await adapter.createMailbox(cfg, { domain: "exp.test", localPart: "withkey" });

    expect(idempotencyKey).toBeTruthy();
    expect(ref.credentials).toMatch(/^temp_/);
    expect(ref.upstreamMailboxId).toBeTruthy();
    // mock 响应 expiresAt = createdAt + 24h
    expect(ref.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 86_400_000 - 5000);
  });

  it("响应缺 expiresAt 时按 createdAt + 24h 官方留存策略推算", async () => {
    const mock = createYydsMailMock(["exp.test"]);
    const adapter = new YydsMailAdapter({
      fetchFn: async (input, init) => {
        const res = await mock.fetch(input, init);
        const url = new URL(String(input));
        if (url.pathname === "/v1/accounts" && res.ok) {
          const env = (await res.json()) as { data?: Record<string, unknown> };
          const { expiresAt: _dropped, ...rest } = env.data ?? {};
          return new Response(JSON.stringify({ ...env, data: rest }), {
            status: res.status,
            headers: res.headers,
          });
        }
        return res;
      },
    });

    const before = Date.now();
    const ref = await adapter.createMailbox(yydsCfg("cfg-c2", mock), { domain: "exp.test" });
    expect(ref.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 86_400_000 - 5000);
    expect(ref.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 86_400_000 + 5000);
  });

  it("2xx 但信封 success=false 视为上游业务失败", async () => {
    const mock = createYydsMailMock(["exp.test"]);
    const adapter = new YydsMailAdapter({
      fetchFn: async () =>
        new Response(JSON.stringify({ success: false, error: "额度不足", errorCode: "QUOTA_EXHAUSTED" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    await expect(adapter.listDomains(yydsCfg("cfg-c3", mock))).rejects.toThrow(/额度不足.*QUOTA_EXHAUSTED/s);
  });

  it("读路径信封 success=false（errorCode 含 NOT_FOUND）→ 抛 NOT_FOUND（映射 404 而非 502）", async () => {
    const mock = createYydsMailMock(["exp.test"]);
    const adapter = new YydsMailAdapter({
      fetchFn: async () =>
        new Response(JSON.stringify({ success: false, error: "not found", errorCode: "MAILBOX_NOT_FOUND" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    await expect(adapter.listDomains(yydsCfg("cfg-c4", mock))).rejects.toMatchObject({
      name: "UpstreamError",
      code: "NOT_FOUND",
    });
  });

  it("inspectPassthrough：建邮箱登记（含 token/expiresAt）、删邮箱注销、/token 刷新不登记", () => {
    const adapter = new YydsMailAdapter();
    const now = new Date().toISOString();

    const created = adapter.inspectPassthrough!({
      method: "POST",
      path: "/v1/accounts",
      status: 200,
      requestBodyText: JSON.stringify({ domain: "yyds.test" }),
      responseBodyText: JSON.stringify({
        success: true,
        data: { id: "acc-1", address: "a@yyds.test", token: "temp_x", createdAt: now, expiresAt: null },
      }),
    });
    expect(created).toEqual({
      action: "created",
      ref: { upstreamMailboxId: "acc-1", address: "a@yyds.test", credentials: "temp_x", expiresAt: expect.any(Date) },
    });

    // legacy 别名同样识别
    expect(adapter.inspectPassthrough!({
      method: "POST", path: "/v1/emails", status: 201,
      responseBodyText: JSON.stringify({ success: true, data: { id: "acc-2", address: "b@yyds.test" } }),
    })).toMatchObject({ action: "created", ref: { address: "b@yyds.test" } });

    expect(adapter.inspectPassthrough!({
      method: "DELETE", path: "/v1/accounts/acc-1", status: 200,
    })).toEqual({ action: "deleted", upstreamMailboxId: "acc-1" });

    // token 刷新/消息面端点不触发登记
    expect(adapter.inspectPassthrough!({
      method: "POST", path: "/v1/token", status: 200,
      responseBodyText: JSON.stringify({ success: true, data: { id: "acc-1", address: "a@yyds.test", token: "t2" } }),
    })).toBeNull();
    expect(adapter.inspectPassthrough!({
      method: "POST", path: "/v1/messages/mark-read", status: 200,
    })).toBeNull();
  });

  it("listMessages 的 from 格式化：有 name 时为 name <address>", async () => {
    const mock = createYydsMailMock(["fmt.test"]);
    const adapter = new YydsMailAdapter({ fetchFn: mock.fetch });
    const cfg = yydsCfg("cfg-f1", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "fmt.test" });
    mock.deliverMessage(ref.upstreamMailboxId, {
      from: { name: "Alice", address: "alice@example.com" },
      subject: "named",
      text: "hi",
    });

    const messages = await adapter.listMessages(cfg, ref);
    expect(messages[0]!.from).toBe("Alice <alice@example.com>");
    expect(messages[0]!.to).toEqual([ref.address]);
  });

  it("收件箱超过单页 200 时按 offset 翻页，不丢更早的信", async () => {
    const mock = createYydsMailMock(["pg.test"]);
    const adapter = new YydsMailAdapter({ fetchFn: mock.fetch });
    const cfg = yydsCfg("cfg-pg", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "pg.test" });
    const ids: string[] = [];
    for (let i = 1; i <= 250; i += 1) {
      ids.push(mock.deliverMessage(ref.upstreamMailboxId, {
        from: { address: `s${i}@x.test` },
        subject: `m${i}`,
        text: `b${i}`,
      }));
    }
    const listed = await adapter.listMessages(cfg, ref);
    expect(listed).toHaveLength(250);
    expect(listed.map((m) => m.subject)).toContain("m1");
    expect(listed.map((m) => m.subject)).toContain("m250");
    const detail = await adapter.getMessage(cfg, ref, ids[0]!);
    expect(detail.subject).toBe("m1");
  });

  describe("删除接口：2xx 但信封 success=false 视为业务失败", () => {
    async function setup() {
      const mock = createYydsMailMock(["del.test"]);
      const adapter = new YydsMailAdapter({ fetchFn: mock.fetch });
      const cfg = yydsCfg("cfg-del", mock);
      const ref = await adapter.createMailbox(cfg, { domain: "del.test" });
      const messageId = mock.deliverMessage(ref.upstreamMailboxId, {
        from: { name: "Sender", address: "sender@example.org" },
        subject: "del",
        text: "hi",
      });
      return { mock, adapter, cfg, ref, messageId };
    }

    it("deleteMailbox：200 + success=false（errorCode NOT_FOUND）→ 抛 NOT_FOUND（幂等“已不存在”）", async () => {
      const { mock, adapter, cfg, ref } = await setup();
      mock.failDelete("NOT_FOUND");
      await expect(adapter.deleteMailbox(cfg, ref)).rejects.toMatchObject({
        name: "UpstreamError",
        code: "NOT_FOUND",
      });
    });

    it("deleteMailbox：200 + success=false（errorCode 与 NOT_FOUND 无关）→ 抛 UNKNOWN", async () => {
      const { mock, adapter, cfg, ref } = await setup();
      mock.failDelete("SOMETHING_ELSE");
      await expect(adapter.deleteMailbox(cfg, ref)).rejects.toMatchObject({
        name: "UpstreamError",
        code: "UNKNOWN",
      });
    });

    it("deleteMessage：200 + success=false（errorCode NOT_FOUND）→ 抛 NOT_FOUND", async () => {
      const { mock, adapter, cfg, ref, messageId } = await setup();
      mock.failDelete("NOT_FOUND");
      await expect(adapter.deleteMessage(cfg, ref, messageId)).rejects.toMatchObject({
        name: "UpstreamError",
        code: "NOT_FOUND",
      });
    });

    it("删除成功（200 success:true 信封或 204 空 body）正常 resolve，不被误判为失败", async () => {
      // mock 默认形态：200 + success:true
      const { adapter, cfg, ref, messageId } = await setup();
      await expect(adapter.deleteMessage(cfg, ref, messageId)).resolves.toBeUndefined();
      await expect(adapter.deleteMailbox(cfg, ref)).resolves.toBeUndefined();

      // 真实上游常对 DELETE 回 204 无响应体：应视为合法成功而不是抛错
      const mock2 = createYydsMailMock(["del.test"]);
      const adapter2 = new YydsMailAdapter({
        fetchFn: async (input, init) => {
          const res = await mock2.fetch(input, init);
          if (init?.method === "DELETE" && res.ok) return new Response(null, { status: 204 });
          return res;
        },
      });
      const cfg2 = yydsCfg("cfg-del2", mock2);
      const ref2 = await adapter2.createMailbox(cfg2, { domain: "del.test" });
      await expect(adapter2.deleteMailbox(cfg2, ref2)).resolves.toBeUndefined();
    });
  });
});
