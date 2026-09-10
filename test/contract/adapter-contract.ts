import { describe, expect, it } from "vitest";
import type { UpstreamAdapter, UpstreamConfig, MessageSummary } from "../../src/ports/upstream";

/**
 * 适配器契约测试：任何 UpstreamAdapter 实现都必须通过这一套用例，
 * 保证不同上游在统一 API 之下行为一致。
 *
 * 用法：
 *   runAdapterContractTests("dummy", () => ({ adapter, cfg, deliver }))
 * deliver 为可选的测试投递钩子（向 mailboxId 投一封测试邮件）。
 */
export interface AdapterFixture {
  adapter: UpstreamAdapter;
  cfg: UpstreamConfig;
  deliver?: (mailboxId: string, subject: string) => Promise<string>;
  supports?: { deleteMessage?: boolean; getSource?: boolean };
}

export function runAdapterContractTests(name: string, makeFixture: () => AdapterFixture): void {
  const supports = makeFixture().supports ?? {};

  describe(`adapter contract: ${name}`, () => {
    it("listDomains 返回非空域名列表，且全为小写域名格式", async () => {
      const { adapter, cfg } = makeFixture();
      const domains = await adapter.listDomains(cfg);
      expect(domains.length).toBeGreaterThan(0);
      for (const d of domains) {
        expect(d.domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      }
    });

    it("createMailbox → listMessages → getMessage → deleteMailbox 全流程", async () => {
      const { adapter, cfg, deliver } = makeFixture();
      const domains = await adapter.listDomains(cfg);

      const ref = await adapter.createMailbox(cfg, { domain: domains[0]!.domain });
      expect(ref.address).toContain(`@${domains[0]!.domain}`);
      expect(ref.upstreamMailboxId).toBeTruthy();

      try {
        if (deliver) {
          await deliver(ref.upstreamMailboxId, "contract-test");
        }
        const messages = await adapter.listMessages(cfg, ref);
        expect(Array.isArray(messages)).toBe(true);
        if (deliver) {
          expect(messages).toHaveLength(1);
          const detail = await adapter.getMessage(cfg, ref, messages[0]!.id);
          expect(detail.subject).toBe("contract-test");
          expect(detail.attachments).toEqual(expect.any(Array));
        }
      } finally {
        await adapter.deleteMailbox(cfg, ref);
      }
      // 删除后的不变量：列表要么报错，要么为空 —— 绝不能再返回消息。
      // （不同上游行为不同：有的 404，有的返回空 results，均合法。）
      let deletedListMessages: MessageSummary[] | null = null;
      try {
        deletedListMessages = await adapter.listMessages(cfg, ref);
      } catch {
        /* 拒绝亦视为符合 */
      }
      expect(deletedListMessages === null || deletedListMessages.length === 0).toBe(true);
    });

    it("同一 localPart 二次创建必须被拒绝", async () => {
      const { adapter, cfg } = makeFixture();
      const domains = await adapter.listDomains(cfg);
      const localPart = `dup${Date.now()}`;
      const ref = await adapter.createMailbox(cfg, {
        domain: domains[0]!.domain,
        localPart,
      });
      try {
        await expect(
          adapter.createMailbox(cfg, { domain: domains[0]!.domain, localPart }),
        ).rejects.toThrow();
      } finally {
        await adapter.deleteMailbox(cfg, ref);
      }
    });

    it("listMessages 增量游标（since）只返回新消息", async () => {
      if (!makeFixture().deliver) return;
      const { adapter, cfg, deliver } = makeFixture();
      const domains = await adapter.listDomains(cfg);
      const ref = await adapter.createMailbox(cfg, { domain: domains[0]!.domain });
      try {
        const first = await deliver!(ref.upstreamMailboxId, "m1");
        const page1 = await adapter.listMessages(cfg, ref);
        expect(page1).toHaveLength(1);
        await deliver!(ref.upstreamMailboxId, "m2");
        const page2 = await adapter.listMessages(cfg, ref, { since: first });
        expect(page2.map((m) => m.subject)).toEqual(["m2"]);
      } finally {
        await adapter.deleteMailbox(cfg, ref);
      }
    });

    (supports.deleteMessage ? it : it.skip)("deleteMessage 删除后不可再读", async () => {
      const { adapter, cfg, deliver } = makeFixture();
      const domains = await adapter.listDomains(cfg);
      const ref = await adapter.createMailbox(cfg, { domain: domains[0]!.domain });
      try {
        const id = await deliver!(ref.upstreamMailboxId, "to-delete");
        await adapter.deleteMessage!(cfg, ref, id);
        await expect(adapter.getMessage(cfg, ref, id)).rejects.toThrow();
      } finally {
        await adapter.deleteMailbox(cfg, ref);
      }
    });

    (supports.getSource ? it : it.skip)("getSource 返回原始报文字节", async () => {
      const { adapter, cfg, deliver } = makeFixture();
      const domains = await adapter.listDomains(cfg);
      const ref = await adapter.createMailbox(cfg, { domain: domains[0]!.domain });
      try {
        const id = await deliver!(ref.upstreamMailboxId, "raw-source");
        const source = await adapter.getSource!(cfg, ref, id);
        expect(source.byteLength).toBeGreaterThan(0);
      } finally {
        await adapter.deleteMailbox(cfg, ref);
      }
    });
  });
}
