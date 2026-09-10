import type { UpstreamConfig } from "../../../src/ports/upstream";

/**
 * cloudflare_temp_email 管理端 API 的进程内模拟，端点行为对齐参考实现 floatmail
 * 中的调用（含 x-admin-auth 鉴权头校验、summary_only 列表、单封详情含 raw）。
 */

export interface CfMock {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: typeof fetch;
  /** 向指定邮箱投递一封测试邮件，返回邮件 id */
  deliverMail(address: string, mail: { source: string; subject: string; message: string }): string;
  reset(): void;
}

interface CfRecord {
  id: number;
  name: string;
  domain: string;
}

/**
 * 对齐真实上游（v1.9.0 实测）：raw_mails 表没有 subject / message 列，
 * `/admin/mails` 只返回 raw，subject 与正文必须由调用方解析原文得到。
 */
interface CfMail {
  id: number;
  address: string;
  source: string;
  raw: string;
  created_at: string;
}

export function createCfTempEmailMock(domains: string[]): CfMock {
  const baseUrl = "https://cf-temp-email.test";
  const token = "cf-admin-token";
  const records = new Map<number, CfRecord>();
  const mails = new Map<string, CfMail[]>();
  let recordSeq = 0;
  let mailSeq = 0;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const authorized = (init?: RequestInit) =>
    (init?.headers as Record<string, string> | undefined)?.["x-admin-auth"] === token;

  function addressOf(r: CfRecord): string {
    return `${r.name}@${r.domain}`;
  }

  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (path === "/open_api/settings") {
      // 对齐真实上游（v1.9.0）：settings 里域名类数组不止 domains，还有
      // randomSubdomainDomains（同语义的额外域名）与 domainLabels——labels 与
      // domains 按下标一一对应（官方前端按 index zip 成下拉项）
      return json({
        version: "test",
        title: "Mock CF Temp Email",
        domains,
        randomSubdomainDomains: domains.map((d) => `sub.${d}`),
        domainLabels: domains.map((_d, i) => `label-${i}`),
      });
    }

    if (!authorized(init)) return json({ error: "unauthorized" }, 401);

    if (path === "/admin/new_address" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; domain?: string };
      const name = String(body.name ?? "").trim();
      const domain = String(body.domain ?? "").trim();
      if (!name || !domains.includes(domain)) return json({ error: "bad name or domain" }, 400);
      // 对齐真实上游：name 先按默认 ADDRESS_REGEX [^a-z0-9] 删字符（用户实例实测
      // cf-fix-01 → cffix01）。适配器必须用响应 address，禁止自己拼 localPart@domain。
      const sanitized = name.replace(/[^a-z0-9]/g, "");
      if (!sanitized) return json({ error: "bad name or domain" }, 400);
      for (const r of records.values()) {
        if (addressOf(r) === `${sanitized}@${domain}`) return json({ error: "地址已存在" }, 400);
      }
      const record: CfRecord = { id: ++recordSeq, name: sanitized, domain };
      records.set(record.id, record);
      mails.set(addressOf(record), []);
      return json({
        address: addressOf(record),
        jwt: `cf-jwt-${record.id}`,
        address_id: record.id,
      });
    }

    const mailsListMatch = path === "/admin/mails" && method === "GET";
    if (mailsListMatch) {
      const address = url.searchParams.get("address") ?? "";
      // 对齐上游 handleMailListQuery：limit 必填且必须在 1..100，否则 400
      const limitRaw = url.searchParams.get("limit");
      const limit = Number(limitRaw);
      if (!limitRaw || !Number.isFinite(limit) || limit <= 0 || limit > 100) {
        return new Response("Invalid limit", { status: 400 });
      }
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (!Number.isFinite(offset) || offset < 0) {
        return new Response("Invalid offset", { status: 400 });
      }
      // 上游默认 id desc（新→旧）；summary_only 被忽略，恒返回含 raw 的整行
      const rows = [...(mails.get(address) ?? [])].sort((a, b) => b.id - a.id);
      return json({
        results: rows.slice(offset, offset + limit),
        // 上游只在 offset=0 时计算总数，之后恒为 0
        count: offset === 0 ? rows.length : 0,
      });
    }

    const mailIdMatch = path.match(/^\/admin\/mails\/([^/]+)$/);
    if (mailIdMatch) {
      const id = mailIdMatch[1]!;
      // 对齐 v1.9.0 实测：**没有** GET /admin/mails/{id}（真实实例返回 404）。
      // 适配器必须在本地址的列表里按 id 找，这样也顺带完成了归属校验。
      if (method === "GET") return new Response("Not Found", { status: 404 });
      for (const [, rows] of mails) {
        const idx = rows.findIndex((m) => String(m.id) === id);
        if (idx < 0) continue;
        if (method === "DELETE") {
          rows.splice(idx, 1);
          return json({ ok: true });
        }
      }
      return json({ error: "not found" }, 404);
    }

    if (path === "/admin/address" && method === "GET") {
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      // 真实实例按 limit/offset 分页（且 query 是模糊匹配），适配器要能跨页找到目标
      const limit = Number(url.searchParams.get("limit") ?? "10");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const matched = [...records.values()]
        .filter((r) => addressOf(r).includes(query))
        .map((r) => ({ id: r.id, name: r.name, domain: r.domain }));
      return json({ results: matched.slice(offset, offset + limit), total: matched.length });
    }

    const deleteAddrMatch = path.match(/^\/admin\/delete_address\/([^/]+)$/);
    if (deleteAddrMatch && method === "DELETE") {
      const id = Number(deleteAddrMatch[1]);
      const record = records.get(id);
      if (!record) return json({ error: "not found" }, 404);
      mails.delete(addressOf(record));
      records.delete(id);
      return json({ ok: true });
    }

    return json({ error: `unknown endpoint ${method} ${path}` }, 404);
  };

  return {
    baseUrl,
    token,
    fetch: fetchMock,
    deliverMail(address, mail) {
      const id = ++mailSeq;
      const createdAt = new Date(Date.now() + mailSeq).toISOString();
      const raw = [
        `From: ${mail.source}`,
        `To: ${address}`,
        `Subject: ${mail.subject}`,
        `Date: ${createdAt}`,
        "",
        mail.message,
      ].join("\r\n");
      const rows = mails.get(address) ?? [];
      rows.push({ id, address, source: mail.source, raw, created_at: createdAt });
      mails.set(address, rows);
      return String(id);
    },
    reset() {
      records.clear();
      mails.clear();
    },
  };
}

export function cfCfg(id: string, mock: CfMock): UpstreamConfig {
  return { id, type: "cf-temp-email", baseUrl: mock.baseUrl, apiKey: mock.token, settings: {} };
}
