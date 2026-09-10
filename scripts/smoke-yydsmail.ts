/**
 * YYDS Mail 真实实例冒烟验证。用后即删，不留进程。
 * 用法：
 *   npx tsx scripts/smoke-yydsmail.ts [baseUrl] [apiKey]
 * - 无 apiKey：原始 fetch 验证公开端点（域名列表信封结构 + 匿名建/删邮箱生命周期，官方允许匿名创建）
 * - 有 apiKey：走 YydsMailAdapter 完整生命周期（域名 → 建邮箱 → 列消息 → 删邮箱）
 */
import { YydsMailAdapter } from "../src/adapters/upstreams/yydsmail";

const baseUrl = (process.argv[2] ?? "https://maliapi.215.im").replace(/\/+$/, "");
const apiKey = process.argv[3];
const api = `${baseUrl}/v1`;
const log = (label: string, value: unknown) =>
  console.log(`[${label}]`, typeof value === "string" ? value : JSON.stringify(value));

interface Envelope<T> { success?: boolean; data?: T; error?: string; errorCode?: string }

/** 读响应 JSON；上游被 Cloudflare 拦截时返回 HTML，给出可读提示 */
async function readJson(res: Response): Promise<Envelope<unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Envelope<unknown>;
  } catch {
    const waf = /just a moment|cloudflare/i.test(text);
    throw new Error(
      waf
        ? `上游返回 ${res.status} 且为 Cloudflare 人机验证页——当前出口 IP 被拦截，请改从部署环境（Workers/服务器/代理）运行本脚本`
        : `上游返回 ${res.status} 且非 JSON：${text.slice(0, 120)}`,
    );
  }
}

try {
  if (apiKey) {
    const cfg = { id: "smoke-yyds", type: "yydsmail", baseUrl, apiKey, settings: {} };
    const adapter = new YydsMailAdapter();
    const domains = await adapter.listDomains(cfg);
    log("domains", domains.map((d) => d.domain).slice(0, 10));
    if (domains.length === 0) throw new Error("上游未返回可用域名");

    const ref = await adapter.createMailbox(cfg, {
      domain: domains[0]!.domain,
      localPart: `tmg-smoke${Date.now() % 100000}`,
    });
    log("created", {
      id: ref.upstreamMailboxId,
      address: ref.address,
      hasToken: Boolean(ref.credentials),
      expiresAt: ref.expiresAt?.toISOString(),
    });
    log("messages(empty)", (await adapter.listMessages(cfg, ref)).length);
    await adapter.deleteMailbox(cfg, ref);
    log("deleted", ref.address);
  } else {
    // 无 key：公开端点结构验证 + 匿名生命周期
    const domainsRes = await fetch(`${api}/domains`);
    const domainsEnv = (await readJson(domainsRes)) as Envelope<{ domain?: string }[]>;
    if (!domainsRes.ok || domainsEnv.success !== true) {
      throw new Error(`GET /v1/domains ${domainsRes.status}: ${domainsEnv.error ?? ""}`);
    }
    const domains = (domainsEnv.data ?? []).map((d) => d.domain ?? "").filter(Boolean);
    log("domains", domains.slice(0, 10));
    if (domains.length === 0) throw new Error("上游未返回可用域名");

    const createRes = await fetch(`${api}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: domains[0], localPart: `tmg-smoke${Date.now() % 100000}` }),
    });
    const createEnv = (await readJson(createRes)) as Envelope<{
      id?: string; address?: string; token?: string; expiresAt?: string | null;
    }>;
    if (!createRes.ok) {
      // 匿名创建可能被部署方关闭；域名列表结构已验证通过
      log("anonymous create rejected", `${createRes.status}: ${createEnv.error ?? ""} (${createEnv.errorCode ?? ""})`);
      console.log("SMOKE PARTIAL OK（公开域名列表结构验证通过；完整生命周期需配置 API Key 后再跑）");
      process.exit(0);
    }
    const acc = createEnv.data!;
    log("created", { id: acc.id, address: acc.address, hasToken: Boolean(acc.token), expiresAt: acc.expiresAt });
    if (!acc.address || !acc.id || !acc.token) throw new Error("建邮箱响应缺少 id/address/token 字段");

    const listRes = await fetch(`${api}/messages?address=${encodeURIComponent(acc.address)}`, {
      headers: { Authorization: `Bearer ${acc.token}` },
    });
    const listEnv = (await readJson(listRes)) as Envelope<{ messages?: unknown[]; total?: number }>;
    log("messages(empty)", listRes.ok ? (listEnv.data?.messages?.length ?? -1) : `${listRes.status}`);

    const delRes = await fetch(`${api}/accounts/${encodeURIComponent(acc.id!)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${acc.token}` },
    });
    log("deleted", `${acc.address} → ${delRes.status}`);
    if (!delRes.ok) throw new Error(`DELETE /v1/accounts 返回 ${delRes.status}`);
  }
  console.log("SMOKE OK");
} catch (err) {
  console.error("SMOKE FAILED:", (err as Error).message);
  process.exitCode = 1;
}
