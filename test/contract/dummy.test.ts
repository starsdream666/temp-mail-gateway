import { describe } from "vitest";
import { DummyUpstreamAdapter } from "../../src/adapters/upstreams/dummy";
import { runAdapterContractTests } from "./adapter-contract";

describe("dummy adapter", () => {
  const adapter = new DummyUpstreamAdapter();
  const cfg = { id: "cfg-dummy", type: "dummy", baseUrl: "memory://dummy", settings: {} };

  runAdapterContractTests("dummy", () => ({
    adapter,
    cfg,
    supports: { deleteMessage: true, getSource: true },
    deliver: async (mailboxId, subject) =>
      adapter.deliver(cfg, mailboxId, { from: "sender@test.dev", subject, text: `body of ${subject}` }),
  }));
});
