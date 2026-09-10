import type { UpstreamConfig } from "../../../src/ports/upstream";

/**
 * YYDS Mail API 的进程内模拟，端点与字段对齐官方 OpenAPI 规范
 * （/v1 前缀、{success, data, error, errorCode} 统一信封、
 *   X-API-Key 鉴权、消息读写必须显式带 ?address= 查询参数）。
 */

export interface YydsMock {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  /** 向指定邮箱（create 返回的账户 id）投递一封测试邮件，返回消息 id */
  deliverMessage(
    accountId: string,
    message: { from: { name?: string; address: string }; subject: string; text: string; html?: string[] },
  ): string;
  /**
   * 测试钩子：让 DELETE 端点（删邮箱 / 删消息）以「200 + 信封 success=false」响应，
   * 模拟真实上游 2xx 报业务失败（如资源已不存在）的形态；传 null 恢复正常。
   */
  failDelete(errorCode: string | null): void;
  reset(): void;
}

interface YydsAccount {
  id: string;
  address: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}

interface YydsStoredMessage {
  id: string;
  from: { name?: string; address: string };
  to: { address: string }[];
  subject: string;
  text: string;
  html: string[];
  seen: boolean;
  size: number;
  createdAt: string;
  raw: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const ok = <T,>(data: T) => json({ success: true, data });
const fail = (error: string, status: number, errorCode = "REQUEST_FAILED") =>
  json({ success: false, error, errorCode }, status);

export function createYydsMailMock(domains: string[]): YydsMock {
  const baseUrl = "https://yydsmail.test";
  const apiKey = "AC-yyds-test-key";
  const accounts = new Map<string, YydsAccount>();
  const messagesByAddress = new Map<string, YydsStoredMessage[]>();
  let messageSeq = 0;
  let accountSeq = 0;
  /** 测试钩子状态：非 null 时 DELETE 一律回 200 + success=false（errorCode 取该值） */
  let deleteFailureCode: string | null = null;

  const addressOf = (localPart: string, domain: string) => `${localPart}@${domain}`;

  const findAccount = (address: string | null): YydsAccount | null => {
    if (!address) return null;
    for (const a of accounts.values()) {
      if (a.address.toLowerCase() === address.toLowerCase()) return a;
    }
    return null;
  };

  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if ((init?.headers as Record<string, string> | undefined)?.["X-API-Key"] !== apiKey) {
      return fail("unauthorized", 401, "UNAUTHORIZED");
    }

    if (path === "/v1/domains" && method === "GET") {
      return ok(domains.map((d, i) => ({ id: `dom_${i}`, domain: d, isPublic: true, isVerified: true })));
    }

    if ((path === "/v1/accounts" || path === "/v1/accounts/wildcard") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        domain?: string;
        localPart?: string;
        subdomain?: string;
      };
      const domain = String(body.domain ?? "");
      if (!domains.includes(domain)) return fail("domain not allowed", 400, "DOMAIN_NOT_ALLOWED");
      const localPart = String(body.localPart ?? `yyds${Date.now()}${++accountSeq}`).toLowerCase();
      const address = body.subdomain
        ? `${localPart}@${body.subdomain}.${domain}`
        : addressOf(localPart, domain);
      if (findAccount(address)) return fail("address already exists", 409, "ADDRESS_EXISTS");
      const now = new Date();
      const account: YydsAccount = {
        id: crypto.randomUUID(),
        address,
        token: `temp_${crypto.randomUUID()}`,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      };
      accounts.set(account.id, account);
      messagesByAddress.set(account.address, []);
      return ok({
        id: account.id,
        address: account.address,
        token: account.token,
        createdAt: account.createdAt,
        expiresAt: account.expiresAt,
        inboxType: "temp",
        isActive: true,
        mode: body.subdomain ? "wildcard" : "fixed",
      });
    }

    const accountDelete = path.match(/^\/v1\/accounts\/([^/]+)$/);
    if (accountDelete && method === "DELETE") {
      // 钩子优先：真实上游可能用 200 + success=false 报「已不存在」而非 HTTP 404
      if (deleteFailureCode !== null) return fail("delete rejected by upstream", 200, deleteFailureCode);
      const account = accounts.get(decodeURIComponent(accountDelete[1]!));
      if (!account) return fail("not found", 404, "NOT_FOUND");
      accounts.delete(account.id);
      messagesByAddress.delete(account.address);
      return ok({ id: account.id, isActive: false });
    }

    // 消息面：API Key 必须显式带 address
    const address = url.searchParams.get("address");
    if (path === "/v1/messages" && method === "GET") {
      const account = findAccount(address);
      if (!account) return fail("address required or unknown inbox", 400, "ADDRESS_REQUIRED");
      const messages = messagesByAddress.get(account.address) ?? [];
      // 对齐真实上游：按时间倒序；limit 最大 200，offset 翻页
      const sorted = [...messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const limitRaw = Number(url.searchParams.get("limit") ?? "50");
      const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
      const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
      const page = sorted.slice(offset, offset + limit);
      return ok({
        messages: page.map((m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          subject: m.subject,
          seen: m.seen,
          size: m.size,
          hasAttachments: false,
          createdAt: m.createdAt,
          inboxId: account.id,
        })),
        total: sorted.length,
        unreadCount: sorted.filter((m) => !m.seen).length,
      });
    }

    const messageMatch = path.match(/^\/v1\/messages\/([^/]+)$/);
    if (messageMatch) {
      const id = decodeURIComponent(messageMatch[1]!);
      const account = findAccount(address);
      if (!account) return fail("address required or unknown inbox", 400, "ADDRESS_REQUIRED");
      const messages = messagesByAddress.get(account.address) ?? [];
      const index = messages.findIndex((m) => m.id === id);
      if (index < 0) return fail("message not found", 404, "NOT_FOUND");

      if (method === "GET") {
        const m = messages[index]!;
        return ok({
          id: m.id,
          from: m.from,
          to: m.to,
          subject: m.subject,
          text: m.text,
          html: m.html,
          seen: m.seen,
          size: m.size,
          hasAttachments: false,
          createdAt: m.createdAt,
          inboxId: account.id,
          attachments: [],
        });
      }
      if (method === "DELETE") {
        // 与删邮箱同理：钩子开启时以 200 + success=false 响应
        if (deleteFailureCode !== null) return fail("delete rejected by upstream", 200, deleteFailureCode);
        messages.splice(index, 1);
        return ok({ id });
      }
    }

    const sourceMatch = path.match(/^\/v1\/sources\/([^/]+)$/);
    if (sourceMatch && method === "GET") {
      const id = decodeURIComponent(sourceMatch[1]!);
      const account = findAccount(address);
      if (!account) return fail("address required or unknown inbox", 400, "ADDRESS_REQUIRED");
      const m = (messagesByAddress.get(account.address) ?? []).find((x) => x.id === id);
      if (!m) return fail("message not found", 404, "NOT_FOUND");
      return ok({ id: m.id, data: m.raw });
    }

    return fail(`unknown endpoint ${method} ${path}`, 404, "NOT_FOUND");
  };

  return {
    baseUrl,
    apiKey,
    fetch: fetchMock,
    deliverMessage(accountId, message) {
      const account = accounts.get(accountId);
      if (!account) throw new Error(`mock: 邮箱不存在 ${accountId}`);
      const id = `msg_${++messageSeq}`;
      const createdAt = new Date(Date.now() + messageSeq).toISOString();
      const html = message.html ?? [`<p>${message.text}</p>`];
      const raw = [
        `From: ${message.from.name ? `${message.from.name} <${message.from.address}>` : message.from.address}`,
        `To: ${account.address}`,
        `Subject: ${message.subject}`,
        `Date: ${createdAt}`,
        `Content-Type: text/plain`,
        "",
        message.text,
        "",
      ].join("\r\n");
      (messagesByAddress.get(account.address) ?? []).push({
        id,
        from: message.from,
        to: [{ address: account.address }],
        subject: message.subject,
        text: message.text,
        html,
        seen: false,
        size: raw.length,
        createdAt,
        raw,
      });
      return id;
    },
    failDelete(errorCode: string | null): void {
      deleteFailureCode = errorCode;
    },
    reset() {
      accounts.clear();
      messagesByAddress.clear();
      messageSeq = 0;
      accountSeq = 0;
      deleteFailureCode = null;
    },
  };
}

export function yydsCfg(id: string, mock: YydsMock): UpstreamConfig {
  return { id, type: "yydsmail", baseUrl: mock.baseUrl, apiKey: mock.apiKey, settings: {} };
}
