/**
 * DuckMail 真实实例冒烟验证（公开 API，匿名建箱官方允许）。
 * 用后即删，不留进程。用法：npx tsx scripts/smoke-duckmail.ts [baseUrl]
 */
import { DuckMailAdapter } from "../src/adapters/upstreams/duckmail";

const baseUrl = process.argv[2] ?? "https://api.duckmail.sbs";
const cfg = {
  id: "smoke-duck",
  type: "duckmail",
  baseUrl,
  settings: {},
};

const adapter = new DuckMailAdapter();
const log = (label: string, value: unknown) =>
  console.log(`[${label}]`, typeof value === "string" ? value : JSON.stringify(value));

try {
  const domains = await adapter.listDomains(cfg);
  log("domains", domains.map((d) => d.domain).slice(0, 10));
  if (domains.length === 0) throw new Error("上游未返回可用域名");

  const domain = domains[0]!.domain;
  const localPart = `tmgsmoke${Date.now() % 1000000}`;
  const ref = await adapter.createMailbox(cfg, { domain, localPart });
  log("created", {
    id: ref.upstreamMailboxId,
    address: ref.address,
    hasToken: Boolean(ref.credentials),
    expiresAt: ref.expiresAt?.toISOString(),
  });

  const messages = await adapter.listMessages(cfg, ref);
  log("messages(empty)", messages.length);

  await adapter.deleteMailbox(cfg, ref);
  log("deleted", ref.address);
  console.log("SMOKE OK");
} catch (err) {
  console.error("SMOKE FAILED:", (err as Error).message);
  process.exitCode = 1;
}
