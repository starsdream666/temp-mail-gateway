import { describe, expect, it } from "vitest";
import { DuckMailAdapter } from "../../src/adapters/upstreams/duckmail";
import { runAdapterContractTests } from "./adapter-contract";
import { createDuckMailMock, duckCfg } from "./mocks/duckmail-mock";

describe("duckmail adapter", () => {
  const mock = createDuckMailMock(["duck.test", "alt.duck.test"]);
  const adapter = new DuckMailAdapter({ fetchFn: mock.fetch });

  runAdapterContractTests("duckmail", () => ({
    adapter,
    cfg: duckCfg("cfg-duck", mock),
    supports: { deleteMessage: true, getSource: true },
    // mock 支持按账号 id（upstreamMailboxId）投递
    deliver: async (mailboxId, subject) =>
      mock.deliverMessage(mailboxId, { from: "sender@example.org", subject, text: `body of ${subject}` }),
  }));
});

describe("duckmail 适配器细节", () => {
  it("域名分页：超过 30 个域名时自动翻页取全", async () => {
    const many = Array.from({ length: 45 }, (_, i) => `page${i}.duck.test`);
    const mock = createDuckMailMock(many);
    const adapter = new DuckMailAdapter({ fetchFn: mock.fetch });
    const domains = await adapter.listDomains(duckCfg("cfg-pg", mock));
    expect(domains).toHaveLength(45);
  });

  it("带 dk_ API Key 时可见私有域名", async () => {
    const mock = createDuckMailMock(["duck.test"], ["private.duck.test"]);
    const adapter = new DuckMailAdapter({ fetchFn: mock.fetch });

    const anon = await adapter.listDomains(duckCfg("cfg-anon", mock));
    expect(anon.map((d) => d.domain)).not.toContain("private.duck.test");

    const withKey = await adapter.listDomains(duckCfg("cfg-key", mock, true));
    const priv = withKey.find((d) => d.domain === "private.duck.test");
    expect(priv?.isPrivate).toBe(true);
  });

  it("建箱流程：密码代管、token 落入凭证、expiresIn 推算到期", async () => {
    const mock = createDuckMailMock(["exp.duck.test"]);
    const adapter = new DuckMailAdapter({ fetchFn: mock.fetch });
    const cfg = duckCfg("cfg-exp", mock);

    const ref = await adapter.createMailbox(cfg, {
      domain: "exp.duck.test",
      localPart: "expirycheck",
      expiresInSeconds: 7200,
    });
    expect(ref.address).toBe("expirycheck@exp.duck.test");
    expect(ref.password).toMatch(/^[0-9a-f]{32}$/); // 代管密码 ≥6 位
    expect(ref.credentials).toMatch(/^duck-token-/);
    expect(ref.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 7000 * 1000);

    // 未传 expiresInSeconds → 上游缺省 24h
    const ref2 = await adapter.createMailbox(cfg, { domain: "exp.duck.test", localPart: "defaultcheck" });
    expect(ref2.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 23.9 * 3600 * 1000);
  });

  it("过短用户名：上游 422 原样映射为 BAD_REQUEST", async () => {
    const mock = createDuckMailMock(["duck.test"]);
    const adapter = new DuckMailAdapter({ fetchFn: mock.fetch });
    await expect(
      adapter.createMailbox(duckCfg("cfg-short", mock), { domain: "duck.test", localPart: "ab" }),
    ).rejects.toThrow(/at least 3 characters/);
  });

  it("收件箱分页：新到旧的列表在适配器内转为升序后交给游标", async () => {
    const mock = createDuckMailMock(["pg.duck.test"]);
    const adapter = new DuckMailAdapter({ fetchFn: mock.fetch });
    const cfg = duckCfg("cfg-inbox", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "pg.duck.test" });

    const ids: string[] = [];
    for (let i = 1; i <= 35; i++) {
      ids.push(mock.deliverMessage(ref.address, { from: "s@example.org", subject: `m${i}`, text: "x" }));
    }
    const page1 = await adapter.listMessages(cfg, ref);
    expect(page1).toHaveLength(35); // 2 页都取回
    expect(page1[0]!.subject).toBe("m1"); // 升序
    expect(page1[34]!.subject).toBe("m35");

    // 游标：since 之后的增量
    const incremental = await adapter.listMessages(cfg, ref, { since: ids[33]! });
    expect(incremental.map((m) => m.subject)).toEqual(["m35"]);
  });

  it("透传观察：POST /accounts 按 expiresIn 推算到期，DELETE /accounts/{id} 注销", () => {
    const adapter = new DuckMailAdapter();

    const created = adapter.inspectPassthrough!({
      method: "POST",
      path: "/accounts",
      status: 201,
      requestBodyText: JSON.stringify({ address: "p@duck.test", expiresIn: 3600 }),
      responseBodyText: JSON.stringify({ id: "acc-1", address: "p@duck.test" }),
    });
    expect(created).toEqual({
      action: "created",
      ref: { upstreamMailboxId: "acc-1", address: "p@duck.test", credentials: undefined, expiresAt: expect.any(Date) },
    });

    // 0 = 永久 → 不带 expiresAt
    const permanent = adapter.inspectPassthrough!({
      method: "POST",
      path: "/accounts",
      status: 201,
      requestBodyText: JSON.stringify({ address: "q@duck.test", expiresIn: 0 }),
      responseBodyText: JSON.stringify({ id: "acc-2", address: "q@duck.test" }),
    });
    expect((permanent as { ref: { expiresAt?: Date } }).ref.expiresAt).toBeUndefined();

    expect(adapter.inspectPassthrough!({
      method: "DELETE",
      path: "/accounts/acc-1",
      status: 204,
    })).toEqual({ action: "deleted", upstreamMailboxId: "acc-1" });
  });

  it("透传列表过滤：GET /domains 的 hydra:member 按可用域名过滤", () => {
    const adapter = new DuckMailAdapter();
    const filtered = adapter.filterPassthroughList!({
      path: "/domains",
      responseBodyText: JSON.stringify({
        "hydra:member": [{ domain: "good.test" }, { domain: "bad.test" }, { ownerId: null }],
        "hydra:totalItems": 3,
      }),
      isDomainAllowed: (d) => d === "good.test",
    });
    const parsed = JSON.parse(filtered!) as { "hydra:member": { domain?: string }[] };
    expect(parsed["hydra:member"].map((x) => x.domain)).toEqual(["good.test", undefined]);
  });

  it("收件箱超过 90 封时继续翻页（上限 20 页 / 600 封）", async () => {
    const mock = createDuckMailMock(["pg.duck.test"]);
    const adapter = new DuckMailAdapter({ fetchFn: mock.fetch });
    const cfg = duckCfg("cfg-many", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "pg.duck.test" });
    for (let i = 1; i <= 95; i += 1) {
      mock.deliverMessage(ref.address, { from: "s@example.org", subject: `m${i}`, text: "x" });
    }
    const listed = await adapter.listMessages(cfg, ref);
    expect(listed).toHaveLength(95);
    expect(listed[0]!.subject).toBe("m1");
    expect(listed[94]!.subject).toBe("m95");
  });

  it("token 过期后用代管密码换新票，读信不失败", async () => {
    const mock = createDuckMailMock(["tok.duck.test"]);
    const adapter = new DuckMailAdapter({ fetchFn: mock.fetch });
    const cfg = duckCfg("cfg-tok", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "tok.duck.test", localPart: "refreshme" });
    mock.deliverMessage(ref.address, { from: "s@example.org", subject: "hello", text: "x" });
    mock.rotateToken(ref.address);
    const listed = await adapter.listMessages(cfg, ref);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.subject).toBe("hello");
  });

  it("建箱后 /token 失败仍登记邮箱（密码代管）；首次读信再换票", async () => {
    const mock = createDuckMailMock(["tok.duck.test"]);
    mock.failNextToken(true);
    const adapter = new DuckMailAdapter({ fetchFn: mock.fetch });
    const cfg = duckCfg("cfg-tok2", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "tok.duck.test", localPart: "latetoken" });
    expect(ref.password).toBeTruthy();
    expect(ref.credentials).toBeUndefined();
    mock.deliverMessage(ref.address, { from: "s@example.org", subject: "late", text: "x" });
    const listed = await adapter.listMessages(cfg, ref);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.subject).toBe("late");
    expect(ref.credentials).toMatch(/^duck-token-/);
  });
});
