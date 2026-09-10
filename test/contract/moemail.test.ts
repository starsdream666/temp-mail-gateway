import { describe, expect, it } from "vitest";
import { MoeMailAdapter, MOEMAIL_DEFAULT_EXPIRY_PRESETS_MS, snapToPresets } from "../../src/adapters/upstreams/moemail";
import { runAdapterContractTests } from "./adapter-contract";
import { createMoeMailMock, moeCfg } from "./mocks/moemail-mock";

describe("moemail adapter", () => {
  const mock = createMoeMailMock(["moe.test", "alt.moe.test"]);
  const adapter = new MoeMailAdapter({ fetchFn: mock.fetch });

  runAdapterContractTests("moemail", () => ({
    adapter,
    cfg: moeCfg("cfg-moe", mock),
    // 上游有单封删除（DELETE /api/emails/{id}/{messageId}）；仍无原始报文端点
    supports: { deleteMessage: true, getSource: false },
    deliver: async (mailboxId, subject) =>
      mock.deliverMessage(mailboxId, {
        from_address: "sender@example.org",
        subject,
        content: `body of ${subject}`,
      }),
  }));

  it("deleteMessage 只删指定那一封，其余消息不受影响", async () => {
    const cfg = moeCfg("cfg-moe-del", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "moe.test", localPart: "multidel" });
    try {
      const keep = mock.deliverMessage(ref.upstreamMailboxId, {
        from_address: "a@example.org",
        subject: "keep",
        content: "keep",
      });
      const drop = mock.deliverMessage(ref.upstreamMailboxId, {
        from_address: "b@example.org",
        subject: "drop",
        content: "drop",
      });
      await adapter.deleteMessage!(cfg, ref, drop);
      const left = await adapter.listMessages(cfg, ref);
      expect(left.map((m) => m.subject)).toEqual(["keep"]);
      expect(left.map((m) => m.id)).toEqual([keep]);
    } finally {
      await adapter.deleteMailbox(cfg, ref);
    }
  });

  it("收件箱超过一页（上游 PAGE_SIZE=20）时跟随游标翻页，不丢更早的消息", async () => {
    const cfg = moeCfg("cfg-moe-paging", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "moe.test", localPart: "paging" });
    try {
      // 25 封 > 上游单页 20 封：早先只读第一页，第 21 封起既列不出也读不到
      const ids: string[] = [];
      for (let i = 1; i <= 25; i += 1) {
        ids.push(
          mock.deliverMessage(ref.upstreamMailboxId, {
            from_address: `s${i}@example.org`,
            subject: `m${i}`,
            content: `body ${i}`,
          }),
        );
      }

      const listed = await adapter.listMessages(cfg, ref);
      expect(listed).toHaveLength(25);
      // 最早那封（第 1 封）必须在列表里
      expect(listed.map((m) => m.subject)).toContain("m1");

      // 也必须能读到它的详情（走专用单封端点，不再靠重新列表过滤）
      const detail = await adapter.getMessage(cfg, ref, ids[0]!);
      expect(detail.subject).toBe("m1");
      expect(detail.text).toBe("body 1");
    } finally {
      await adapter.deleteMailbox(cfg, ref);
    }
  });

  it("纳管反查跨页有效：账号下邮箱超过一页时仍能按地址找到", async () => {
    const pageMock = createMoeMailMock(["moe.test"]);
    const pageAdapter = new MoeMailAdapter({ fetchFn: pageMock.fetch });
    const cfg = moeCfg("cfg-moe-resolve-paging", pageMock);

    // 建 23 个邮箱，目标是最早创建的那个（列表按 createdAt 倒序 → 落在第二页）
    const first = await pageAdapter.createMailbox(cfg, { domain: "moe.test", localPart: "oldest" });
    for (let i = 0; i < 22; i += 1) {
      await pageAdapter.createMailbox(cfg, { domain: "moe.test", localPart: `filler${i}` });
    }

    const resolved = await pageAdapter.resolveByAddress!(cfg, first.address);
    expect(resolved.address).toBe(first.address);
    expect(resolved.upstreamMailboxId).toBe(first.upstreamMailboxId);
    expect(resolved.expiresAt).toBeInstanceOf(Date);
  });

  it("纳管反查：上游确实没有该地址时报 NOT_FOUND，并提示过期邮箱不在列表中", async () => {
    const cfg = moeCfg("cfg-moe-resolve-miss", mock);
    await expect(adapter.resolveByAddress!(cfg, "nobody@moe.test")).rejects.toThrow(/不存在/);
  });

  it("deleteMessage 对不存在的消息报错（上游 404）", async () => {
    const cfg = moeCfg("cfg-moe-del404", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "moe.test", localPart: "del404" });
    try {
      await expect(adapter.deleteMessage!(cfg, ref, "no-such-message")).rejects.toThrow();
    } finally {
      await adapter.deleteMailbox(cfg, ref);
    }
  });
});

describe("moemail 有效期（可选配置 + 档位吸附，最大兼容）", () => {
  it("请求 1h 时按原档位发送，expiresAt 按实际上游档位推算", async () => {
    const mock = createMoeMailMock(["exp.test"]);
    const adapter = new MoeMailAdapter({ fetchFn: mock.fetch });
    const cfg = moeCfg("cfg-exp-1", mock);

    const before = Date.now();
    const ref = await adapter.createMailbox(cfg, { domain: "exp.test", expiresInSeconds: 3600 });

    expect(mock.lastGenerateBody()).toMatchObject({ expiryTime: 3_600_000 });
    expect(ref.expiresAt).not.toBeUndefined();
    expect(ref.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3_600_000 - 5000);
    expect(ref.expiresAt!.getTime()).toBeLessThanOrEqual(before + 3_600_000 + 5000);
  });

  it("请求 2h 吸附到 1h 档后，expiresAt 必须是 1h 而非请求的 2h（网关与上游一致）", async () => {
    const mock = createMoeMailMock(["exp.test"]);
    const adapter = new MoeMailAdapter({ fetchFn: mock.fetch });
    const cfg = moeCfg("cfg-exp-2", mock);

    const before = Date.now();
    const ref = await adapter.createMailbox(cfg, { domain: "exp.test", expiresInSeconds: 7200 });

    expect(mock.lastGenerateBody()).toMatchObject({ expiryTime: 3_600_000 });
    // 若错误地按请求值推算会是 +2h；这里必须反映吸附后上游真实接受的 1h
    expect(ref.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3_600_000 - 5000);
    expect(ref.expiresAt!.getTime()).toBeLessThanOrEqual(before + 3_600_000 + 5000);
  });

  it("完全未配置时使用内置默认 24h（保证配置永远非必填）", async () => {
    const mock = createMoeMailMock(["exp.test"]);
    const adapter = new MoeMailAdapter({ fetchFn: mock.fetch });
    const cfg = moeCfg("cfg-exp-3", mock);

    const before = Date.now();
    const ref = await adapter.createMailbox(cfg, { domain: "exp.test" });
    expect(mock.lastGenerateBody()).toMatchObject({ expiryTime: 86_400_000 });
    expect(ref.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 86_400_000 - 5000);
  });

  it("settings.defaultExpiryMs 作为兜底，显式请求优先", async () => {
    const mock = createMoeMailMock(["exp.test"]);
    const adapter = new MoeMailAdapter({ fetchFn: mock.fetch });
    const cfg = { ...moeCfg("cfg-exp-4", mock), settings: { defaultExpiryMs: 300_000 } };

    // 5min 不在档位表内 → 吸附到最近的 1h
    await adapter.createMailbox(cfg, { domain: "exp.test" });
    expect(mock.lastGenerateBody()).toMatchObject({ expiryTime: 3_600_000 });

    // 显式请求覆盖兜底：请求 3 天正好命中档位
    await adapter.createMailbox(cfg, { domain: "exp.test", expiresInSeconds: 259_200 });
    expect(mock.lastGenerateBody()).toMatchObject({ expiryTime: 259_200_000 });
  });

  it("请求超过最长档位（如 5 天 / 30 天）吸附到 3 天，而不是发出上游会拒的值", async () => {
    const mock = createMoeMailMock(["exp.test"]);
    const adapter = new MoeMailAdapter({ fetchFn: mock.fetch });
    const cfg = moeCfg("cfg-exp-long", mock);

    // 回归：档位表曾误含 7d（604800000），请求 5 天会吸附到 7d →
    // 真实上游 400「无效的过期时间」，建箱直接失败（已对真实实例复现）
    const ref = await adapter.createMailbox(cfg, { domain: "exp.test", expiresInSeconds: 432_000 });
    expect(mock.lastGenerateBody()).toMatchObject({ expiryTime: 259_200_000 });
    expect(ref.address).toContain("@exp.test");

    await adapter.createMailbox(cfg, { domain: "exp.test", expiresInSeconds: 2_592_000 });
    expect(mock.lastGenerateBody()).toMatchObject({ expiryTime: 259_200_000 });
  });

  it("settings.defaultExpiryMs=0 表示永久（上游合法档位），网关不写到期时间", async () => {
    const mock = createMoeMailMock(["exp.test"]);
    const adapter = new MoeMailAdapter({ fetchFn: mock.fetch });
    const cfg = { ...moeCfg("cfg-exp-forever", mock), settings: { defaultExpiryMs: 0 } };

    const ref = await adapter.createMailbox(cfg, { domain: "exp.test" });
    expect(mock.lastGenerateBody()).toMatchObject({ expiryTime: 0 });
    // 永久邮箱不应带到期时间（上游写的是 9999-01-01，网关侧用 undefined 表达）
    expect(ref.expiresAt).toBeUndefined();
  });

  it("永久档不参与就近吸附：请求 1 小时不会因为「离 0 更近」变成永久", async () => {
    const mock = createMoeMailMock(["exp.test"]);
    const adapter = new MoeMailAdapter({ fetchFn: mock.fetch });
    const cfg = moeCfg("cfg-exp-nosnap0", mock);

    await adapter.createMailbox(cfg, { domain: "exp.test", expiresInSeconds: 3600 });
    expect(mock.lastGenerateBody()).toMatchObject({ expiryTime: 3_600_000 });
  });

  it("settings.expiryPresetsMs: [] 关闭吸附、原样透传（兼容接受任意值的实例）", async () => {
    const mock = createMoeMailMock(["exp.test"]);
    const adapter = new MoeMailAdapter({ fetchFn: mock.fetch });
    const cfg = { ...moeCfg("cfg-exp-5", mock), settings: { expiryPresetsMs: [] } };

    // 模拟上游按真实白名单拒绝非档位值 —— 但请求体必须原样到达线路
    await expect(adapter.createMailbox(cfg, { domain: "exp.test", expiresInSeconds: 7200 }))
      .rejects.toThrow();
    expect(mock.lastGenerateBody()).toMatchObject({ expiryTime: 7_200_000 });
  });

  it("上游响应若携带 expiresAt（新版本）则优先于本地推算", async () => {
    const mock = createMoeMailMock(["exp.test"]);
    const upstreamTime = Date.now() + 60_000; // 响应声称 1 分钟后过期
    const adapter = new MoeMailAdapter({
      fetchFn: async (input, init) => {
        const res = await mock.fetch(input, init);
        const url = String(input);
        if (url.endsWith("/api/emails/generate") && res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          return new Response(JSON.stringify({ ...data, expiresAt: upstreamTime }), {
            status: res.status,
            headers: res.headers,
          });
        }
        return res;
      },
    });

    const ref = await adapter.createMailbox(moeCfg("cfg-exp-6", mock), { domain: "exp.test", expiresInSeconds: 3600 });
    // 上游字段优先：不是推算的 +1h，而是响应给的 +60s
    expect(Math.abs(ref.expiresAt!.getTime() - upstreamTime)).toBeLessThanOrEqual(5000);
  });

  it("snapToPresets：平局取更长的档位", () => {
    expect(snapToPresets(7_200_000)).toBe(3_600_000);
    // 构造精确平局：2h 在 [1h, 3h] 中点 → 取更长的 3h
    expect(snapToPresets(7_200_000, [3_600_000, 10_800_000])).toBe(10_800_000);
    expect(snapToPresets(86_400_000)).toBe(86_400_000);
    // 档位表以上游源码 EXPIRY_OPTIONS 为准并经真实实例逐档实测：无 7 天
    expect([...MOEMAIL_DEFAULT_EXPIRY_PRESETS_MS]).toEqual([3_600_000, 86_400_000, 259_200_000]);
  });
});
