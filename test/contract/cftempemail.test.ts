import { describe, expect, it } from "vitest";
import { CfTempEmailAdapter } from "../../src/adapters/upstreams/cftempemail";
import { runAdapterContractTests } from "./adapter-contract";
import { createCfTempEmailMock, cfCfg } from "./mocks/cftempemail-mock";

describe("cf-temp-email adapter", () => {
  const mock = createCfTempEmailMock(["cf.test", "alt.cf.test"]);
  const adapter = new CfTempEmailAdapter({ fetchFn: mock.fetch });

  runAdapterContractTests("cf-temp-email", () => ({
    adapter,
    cfg: cfCfg("cfg-cf", mock),
    supports: { deleteMessage: true, getSource: true },
    deliver: async (mailboxAddress, subject) =>
      mock.deliverMail(mailboxAddress, {
        source: "sender@example.org",
        subject,
        message: `body of ${subject}`,
      }),
  }));
});

describe("cf-temp-email 消息读取（上游只给 raw）", () => {
  it("subject / 正文 / 附件由解析 raw 得到——上游行里根本没有这些字段", async () => {
    const mock = createCfTempEmailMock(["cf.test"]);
    const adapter = new CfTempEmailAdapter({ fetchFn: mock.fetch });
    const cfg = cfCfg("cfg-cf-parse", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "cf.test", localPart: "parseme" });

    const id = mock.deliverMail(ref.address, {
      source: "sender@example.org",
      subject: "Your code is 4321",
      message: "code 4321 inside",
    });

    const listed = await adapter.listMessages(cfg, ref);
    expect(listed).toHaveLength(1);
    // 回归：早先读 row.subject（不存在）→ 恒为空字符串
    expect(listed[0]!.subject).toBe("Your code is 4321");
    expect(listed[0]!.intro).toContain("4321");

    const detail = await adapter.getMessage(cfg, ref, id);
    expect(detail.subject).toBe("Your code is 4321");
    expect(detail.text).toContain("4321");
  });

  it("收件箱超过一页（上游 limit 上限 100）时按 offset 翻页，不丢更早的信", async () => {
    const mock = createCfTempEmailMock(["cf.test"]);
    const adapter = new CfTempEmailAdapter({ fetchFn: mock.fetch });
    const cfg = cfCfg("cfg-cf-paging", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "cf.test", localPart: "many" });

    // 120 封 > 单页 100：早先固定 limit=50 单次请求，第 51 封起永久不可见
    const ids: string[] = [];
    for (let i = 1; i <= 120; i += 1) {
      ids.push(mock.deliverMail(ref.address, { source: `s${i}@x.test`, subject: `m${i}`, message: `b${i}` }));
    }

    const listed = await adapter.listMessages(cfg, ref);
    expect(listed).toHaveLength(120);
    expect(listed.map((m) => m.subject)).toContain("m1");
    // 最早那封也要能读到详情（单封改为在列表里按 id 找）
    const detail = await adapter.getMessage(cfg, ref, ids[0]!);
    expect(detail.subject).toBe("m1");
  });

  it("单封不再依赖 /admin/mails/{id}（真实 v1.9.0 没有该路由，mock 已对齐返回 404）", async () => {
    const mock = createCfTempEmailMock(["cf.test"]);
    const adapter = new CfTempEmailAdapter({ fetchFn: mock.fetch });
    const cfg = cfCfg("cfg-cf-noroute", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "cf.test", localPart: "noroute" });
    const id = mock.deliverMail(ref.address, { source: "a@x.test", subject: "ok", message: "body" });

    // 直接确认该路由确实 404，证明适配器没在用它
    const res = await mock.fetch(`${mock.baseUrl}/admin/mails/${id}`, {
      headers: { "x-admin-auth": mock.token },
    });
    expect(res.status).toBe(404);
    // 而适配器仍能读到
    expect((await adapter.getMessage(cfg, ref, id)).subject).toBe("ok");
  });

  it("跨邮箱读/删被拒：id 属于别的邮箱时报 NOT_FOUND", async () => {
    const mock = createCfTempEmailMock(["cf.test"]);
    const adapter = new CfTempEmailAdapter({ fetchFn: mock.fetch });
    const cfg = cfCfg("cfg-cf-scope", mock);
    const mine = await adapter.createMailbox(cfg, { domain: "cf.test", localPart: "mine" });
    const other = await adapter.createMailbox(cfg, { domain: "cf.test", localPart: "other" });
    const otherId = mock.deliverMail(other.address, { source: "a@x.test", subject: "secret", message: "s" });

    // 上游 id 是全局自增且接口不按 address 过滤 → 必须由适配器兜住归属
    await expect(adapter.getMessage(cfg, mine, otherId)).rejects.toThrow(/不存在/);
    await expect(adapter.deleteMessage!(cfg, mine, otherId)).rejects.toThrow(/不存在/);
    // 别人的信没被删掉
    expect(await adapter.listMessages(cfg, other)).toHaveLength(1);
  });
});

describe("cf-temp-email 删除邮箱：地址簿查找（G3）", () => {
  it("上游地址簿查不到该地址时抛 NOT_FOUND，而不是静默当成删除成功", async () => {
    const mock = createCfTempEmailMock(["cf.test"]);
    const adapter = new CfTempEmailAdapter({ fetchFn: mock.fetch });
    const cfg = cfCfg("cfg-cf-missing", mock);

    // 上游从未有过这个地址：早期实现在这里 return，等于回报删除成功、静默制造孤儿
    await expect(
      adapter.deleteMailbox(cfg, { upstreamMailboxId: "ghost@cf.test", address: "ghost@cf.test" }),
    ).rejects.toThrow(/未找到/);
  });

  it("目标落在地址簿第二页时仍能删除（不能只看第一页）", async () => {
    const mock = createCfTempEmailMock(["cf.test"]);
    const adapter = new CfTempEmailAdapter({ fetchFn: mock.fetch });
    const cfg = cfCfg("cfg-cf-paged", mock);

    // 共同前缀让 query 模糊匹配全部命中，目标排在 60 条之后（页长 50 → 第二页）
    const refs = [];
    for (let i = 0; i < 60; i += 1) {
      refs.push(await adapter.createMailbox(cfg, { domain: "cf.test", localPart: `bulk${i}` }));
    }
    const target = await adapter.createMailbox(cfg, { domain: "cf.test", localPart: "bulk-target" });

    // 本用例专门测地址簿翻页：剥掉建箱时存下的 addressId，强制走 query 扫描
    const withoutStoredId = { ...target, credentials: undefined };
    await adapter.deleteMailbox(cfg, withoutStoredId);

    // 删掉之后再删一次必须报未找到（证明上一次是真的删除了，而非碰巧没查到）
    await expect(adapter.deleteMailbox(cfg, withoutStoredId)).rejects.toThrow(/未找到/);
    // 其余邮箱不受影响：地址簿里仍剩 60 条
    const res = await mock.fetch(`${mock.baseUrl}/admin/address?query=bulk&limit=200&offset=0`, {
      headers: { "x-admin-auth": mock.token },
    });
    const book = (await res.json()) as { results: unknown[] };
    expect(book.results).toHaveLength(refs.length);
  });
});

describe("cf-temp-email 透传列表过滤 /open_api/settings（G3 域名隔离）", () => {
  const adapter = new CfTempEmailAdapter();

  it("mock 的 settings 对齐真实上游：带 randomSubdomainDomains，domainLabels 与 domains 同长对应", async () => {
    const mock = createCfTempEmailMock(["cf.test", "alt.cf.test"]);
    const res = await mock.fetch(`${mock.baseUrl}/open_api/settings`);
    const body = (await res.json()) as {
      domains: string[];
      randomSubdomainDomains: string[];
      domainLabels: string[];
    };
    expect(body.randomSubdomainDomains).toEqual(["sub.cf.test", "sub.alt.cf.test"]);
    // 官方前端按 index 把 labels zip 到 domains 上，长度必须一致
    expect(body.domainLabels).toHaveLength(body.domains.length);
    expect(body.domainLabels).toEqual(["label-0", "label-1"]);
  });

  it("randomSubdomainDomains 与 domains/defaultDomains 一样按可用域名过滤", () => {
    const filtered = adapter.filterPassthroughList!({
      path: "/open_api/settings",
      responseBodyText: JSON.stringify({
        domains: ["a.cf.test", "b.cf.test"],
        defaultDomains: ["a.cf.test", "b.cf.test"],
        randomSubdomainDomains: ["a.cf.test", "b.cf.test", "hidden.cf.test"],
        needAuth: false,
      }),
      isDomainAllowed: (d) => d === "b.cf.test",
    });
    const body = JSON.parse(filtered!) as {
      domains: string[];
      defaultDomains: string[];
      randomSubdomainDomains: string[];
      needAuth: boolean;
    };
    expect(body.randomSubdomainDomains).toEqual(["b.cf.test"]);
    expect(body.domains).toEqual(["b.cf.test"]);
    expect(body.defaultDomains).toEqual(["b.cf.test"]);
    // 其余字段原样透传
    expect(body.needAuth).toBe(false);
  });

  it("domainLabels 随 domains 按同一下标裁剪，删除项之后的标签不错位", () => {
    // domains=[a,b,c] 只留 b：若不动 labels，前端会把 c 的标签 LC 顶到 b 的位置
    const onlyB = adapter.filterPassthroughList!({
      path: "/open_api/settings",
      responseBodyText: JSON.stringify({
        domains: ["a.cf.test", "b.cf.test", "c.cf.test"],
        domainLabels: ["LA", "LB", "LC"],
      }),
      isDomainAllowed: (d) => d === "b.cf.test",
    });
    const bodyB = JSON.parse(onlyB!) as { domains: string[]; domainLabels: string[] };
    expect(bodyB.domains).toEqual(["b.cf.test"]);
    expect(bodyB.domainLabels).toEqual(["LB"]);

    // 留下被删项之后的 b/c：label 也要跟着保留原位的 LB/LC，而不是整体左移成 LA/LB
    const keepBC = adapter.filterPassthroughList!({
      path: "/open_api/settings",
      responseBodyText: JSON.stringify({
        domains: ["a.cf.test", "b.cf.test", "c.cf.test"],
        domainLabels: ["LA", "LB", "LC"],
      }),
      isDomainAllowed: (d) => d === "b.cf.test" || d === "c.cf.test",
    });
    const bodyBC = JSON.parse(keepBC!) as { domains: string[]; domainLabels: string[] };
    expect(bodyBC.domains).toEqual(["b.cf.test", "c.cf.test"]);
    expect(bodyBC.domainLabels).toEqual(["LB", "LC"]);
  });

  it("domainLabels 长度与原始 domains 不一致时原样保留，不去猜对应关系", () => {
    // 实例没配齐 DOMAIN_LABELS（labels 比 domains 短）→ 保持原样
    const short = adapter.filterPassthroughList!({
      path: "/open_api/settings",
      responseBodyText: JSON.stringify({
        domains: ["a.cf.test", "b.cf.test", "c.cf.test"],
        domainLabels: ["LA", "LB"],
      }),
      isDomainAllowed: (d) => d === "b.cf.test",
    });
    const bodyShort = JSON.parse(short!) as { domains: string[]; domainLabels: string[] };
    expect(bodyShort.domains).toEqual(["b.cf.test"]);
    expect(bodyShort.domainLabels).toEqual(["LA", "LB"]);

    // labels 比 domains 长（对不上）→ 同样不碰
    const long = adapter.filterPassthroughList!({
      path: "/open_api/settings",
      responseBodyText: JSON.stringify({
        domains: ["a.cf.test", "b.cf.test"],
        domainLabels: ["LA", "LB", "LC"],
      }),
      isDomainAllowed: (d) => d === "b.cf.test",
    });
    const bodyLong = JSON.parse(long!) as { domainLabels: string[] };
    expect(bodyLong.domainLabels).toEqual(["LA", "LB", "LC"]);
  });

  it("响应体不是合法 JSON 或路径不对时返回 null，不抛异常", () => {
    expect(adapter.filterPassthroughList!({
      path: "/open_api/settings",
      responseBodyText: "{not valid json",
      isDomainAllowed: () => true,
    })).toBeNull();
    expect(adapter.filterPassthroughList!({
      path: "/admin/address",
      responseBodyText: JSON.stringify({ results: [] }),
      isDomainAllowed: () => true,
    })).toBeNull();
  });
});

describe("cf-temp-email 建箱响应与凭证形状", () => {
  it("localPart 含非法字符时地址取响应值（禁止自己拼 localPart@domain）", async () => {
    const mock = createCfTempEmailMock(["cf.test"]);
    const adapter = new CfTempEmailAdapter({ fetchFn: mock.fetch });
    const cfg = cfCfg("cfg-cf-sanitize", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "cf.test", localPart: "cf-fix-01" });
    // 上游默认 ADDRESS_REGEX = [^a-z0-9] → cf-fix-01 变成 cffix01
    expect(ref.address).toBe("cffix01@cf.test");
    expect(ref.address).not.toBe("cf-fix-01@cf.test");
  });

  it("createMailbox 把 jwt + address_id 打成 JSON 凭证，删除走内部 id 不必扫地址簿", async () => {
    const mock = createCfTempEmailMock(["cf.test"]);
    const adapter = new CfTempEmailAdapter({ fetchFn: mock.fetch });
    const cfg = cfCfg("cfg-cf-cred", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "cf.test", localPart: "keepid" });
    const creds = JSON.parse(ref.credentials ?? "{}") as { jwt?: string; addressId?: number };
    expect(creds.jwt).toMatch(/^cf-jwt-/);
    expect(typeof creds.addressId).toBe("number");

    // 即便地址簿 query 永远对不上（模拟模糊匹配漏命中），有 addressId 也能删
    const wrapped: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/admin/address") {
        return new Response(JSON.stringify({ results: [], total: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return mock.fetch(input, init);
    };
    const isolated = new CfTempEmailAdapter({ fetchFn: wrapped });
    await expect(isolated.deleteMailbox(cfg, ref)).resolves.toBeUndefined();
  });

  it("inspectPassthrough 与 createMailbox 同一凭证形状（含 addressId）", () => {
    const adapter = new CfTempEmailAdapter();
    const observed = adapter.inspectPassthrough!({
      method: "POST",
      path: "/admin/new_address",
      status: 200,
      responseBodyText: JSON.stringify({
        address: "a@cf.test",
        jwt: "jwt-x",
        address_id: 42,
      }),
    });
    expect(observed).toMatchObject({ action: "created", ref: { address: "a@cf.test" } });
    expect(JSON.parse((observed as { ref: { credentials: string } }).ref.credentials)).toEqual({
      jwt: "jwt-x",
      addressId: 42,
    });
  });

  it("旧数据裸 jwt 字符串仍能删除：回退扫地址簿，不因 JSON.parse 失败而整段崩", async () => {
    const mock = createCfTempEmailMock(["cf.test"]);
    const adapter = new CfTempEmailAdapter({ fetchFn: mock.fetch });
    const cfg = cfCfg("cfg-cf-legacy", mock);
    const ref = await adapter.createMailbox(cfg, { domain: "cf.test", localPart: "legacy" });
    await expect(
      adapter.deleteMailbox(cfg, { ...ref, credentials: "bare-jwt-not-json" }),
    ).resolves.toBeUndefined();
  });

  it("resolveByAddress 把内部 id 写进凭证，纳管后的删除不必再扫地址簿", async () => {
    const mock = createCfTempEmailMock(["cf.test"]);
    const adapter = new CfTempEmailAdapter({ fetchFn: mock.fetch });
    const cfg = cfCfg("cfg-cf-adopt", mock);
    const created = await adapter.createMailbox(cfg, { domain: "cf.test", localPart: "adoptme" });
    const adopted = await adapter.resolveByAddress!(cfg, created.address);
    expect(JSON.parse(adopted.credentials ?? "{}")).toMatchObject({ addressId: expect.anything() });
    await expect(adapter.deleteMailbox(cfg, adopted)).resolves.toBeUndefined();
  });
});
