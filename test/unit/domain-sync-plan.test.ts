import { describe, expect, it } from "vitest";
import {
  planDomainSync,
  autoSyncDomainsEnabled,
  DOMAIN_REMOVAL_ABSOLUTE_FLOOR,
} from "../../src/core/monitor";

/**
 * 域名自动同步的决策逻辑。安全闸的职责不是阻止真实的域名下架，
 * 而是拦住「上游返回了残缺列表」这类故障——它通常表现为空列表或一次性掉一大片。
 */

const plan = (over: Partial<Parameters<typeof planDomainSync>[0]> = {}) =>
  planDomainSync({
    fetched: [],
    registered: [],
    added: [],
    removed: [],
    autoSync: true,
    ...over,
  });

describe("planDomainSync", () => {
  it("无差异时不动注册表", () => {
    const p = plan({ fetched: ["a.test"], registered: ["a.test"] });
    expect(p.keep).toBeNull();
    expect(p.syncAction).toBe("");
  });

  it("只有新增时直接应用（新增永不受安全闸限制）", () => {
    const p = plan({
      fetched: ["a.test", "b.test"],
      registered: ["a.test"],
      added: ["b.test"],
    });
    expect(p.syncAction).toBe("applied");
    expect(p.keep).toEqual(["a.test", "b.test"]);
  });

  it("少量移除直接应用（上游确实下掉了域名）", () => {
    const p = plan({
      fetched: ["a.test"],
      registered: ["a.test", "b.test"],
      removed: ["b.test"],
    });
    expect(p.syncAction).toBe("applied");
    expect(p.keep).toEqual(["a.test"]);
  });

  it("渠道关闭自动同步时只检测不写", () => {
    const p = plan({
      fetched: ["a.test"],
      registered: ["a.test", "b.test"],
      removed: ["b.test"],
      autoSync: false,
    });
    expect(p.syncAction).toBe("detected");
    expect(p.keep).toBeNull();
  });

  it("上游返回空列表时拒绝清空注册表", () => {
    const registered = ["a.test", "b.test", "c.test"];
    const p = plan({ fetched: [], registered, removed: registered });
    expect(p.keep).toBeNull();
    expect(p.syncAction).toBe("blocked:上游返回空域名列表");
  });

  it("超阈值的批量移除被拦下，但同批的新增仍然应用", () => {
    // 20 个已登记 → 阈值 max(5, 6) = 6；移除 10 个触发安全闸
    const registered = Array.from({ length: 20 }, (_, i) => `d${i}.test`);
    const removed = registered.slice(0, 10);
    const fetched = [...registered.slice(10), "fresh.test"];
    const p = plan({ fetched, registered, added: ["fresh.test"], removed });

    expect(p.syncAction).toContain("blocked:");
    expect(p.syncAction).toContain("移除 10 个域名超出安全阈值 6");
    // 新增进表、待移除的原样保留 → 注册表只增不减
    expect(p.keep).toContain("fresh.test");
    for (const d of removed) expect(p.keep).toContain(d);
    expect(p.keep).toHaveLength(21);
  });

  it("小渠道不被过度保护：绝对下限允许少量移除", () => {
    // 2 个已登记，移除 1 个：比例上是 50%，但绝对量在下限内 → 放行
    const p = plan({ fetched: ["a.test"], registered: ["a.test", "b.test"], removed: ["b.test"] });
    expect(p.syncAction).toBe("applied");

    // 恰好等于下限仍放行，超过才拦
    const reg = Array.from({ length: 6 }, (_, i) => `d${i}.test`);
    const atFloor = plan({
      fetched: reg.slice(DOMAIN_REMOVAL_ABSOLUTE_FLOOR),
      registered: reg,
      removed: reg.slice(0, DOMAIN_REMOVAL_ABSOLUTE_FLOOR),
    });
    expect(atFloor.syncAction).toBe("applied");
  });

  it("大渠道按比例保护：YYDS 量级下掉一小半会被拦", () => {
    const registered = Array.from({ length: 379 }, (_, i) => `d${i}.test`);
    const few = plan({
      fetched: registered.slice(20),
      registered,
      removed: registered.slice(0, 20),
    });
    expect(few.syncAction).toBe("applied"); // 20 < ceil(379*0.3)=114

    const many = plan({
      fetched: registered.slice(200),
      registered,
      removed: registered.slice(0, 200),
    });
    expect(many.syncAction).toContain("blocked:");
  });
});

describe("autoSyncDomainsEnabled", () => {
  it("缺省开启，只有显式 false 才关闭", () => {
    expect(autoSyncDomainsEnabled({})).toBe(true);
    expect(autoSyncDomainsEnabled({ autoSyncDomains: true })).toBe(true);
    expect(autoSyncDomainsEnabled({ autoSyncDomains: false })).toBe(false);
    // 脏值不应意外关闭自动同步
    expect(autoSyncDomainsEnabled({ autoSyncDomains: "false" })).toBe(true);
    expect(autoSyncDomainsEnabled({ autoSyncDomains: 0 })).toBe(true);
  });
});
