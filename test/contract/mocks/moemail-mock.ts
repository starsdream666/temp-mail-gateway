import type { UpstreamConfig } from "../../../src/ports/upstream";

/**
 * MoeMail API 的进程内模拟，端点行为对齐参考实现 floatmail 中的调用
 * （含 X-API-Key 鉴权头校验、emailDomains 逗号分隔字符串、messages 内嵌正文）。
 */

export interface MoeMock {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  /** 向指定邮箱（generate 返回的 id）投递一封测试邮件，返回消息 id */
  deliverMessage(emailId: string, message: { from_address: string; subject: string; content: string }): string;
  reset(): void;
  /** 最近一次 /api/emails/generate 请求体（供有效期转发断言） */
  lastGenerateBody(): Record<string, unknown> | null;
}

interface MoeEmail {
  id: string;
  email: string;
  messages: MoeMessage[];
  /** 邮箱列表按 createdAt 倒序分页，需要稳定的创建序 */
  createdAt: number;
  /** 上游列表会返回 expiresAt；0（永久）时上游写 9999-01-01 */
  expiresAt: number | null;
}

interface MoeMessage {
  id: number;
  message_id: string;
  subject: string;
  from_address: string;
  to_address: string;
  received_at: string;
  content: string;
  html: string;
}

/**
 * 真实 MoeMail 接受的过期档位，取自上游源码 app/types/email.ts 的 EXPIRY_OPTIONS
 * 并对真实实例逐档实测（2026-09-07）：1h / 24h / 3d / 0（永久）。
 * 注意**没有 7 天**——7d 与任意值一律 400「无效的过期时间」。
 */
const VALID_EXPIRY_MS = [3_600_000, 86_400_000, 259_200_000, 0];

/** 上游分页大小（app/api/emails/[id]/route.ts 与 app/api/emails/route.ts 都是 20） */
const MOCK_PAGE_SIZE = 20;

/** 与上游 lib/cursor.ts 同构：base64({timestamp, id}) */
function encodeCursor(timestamp: number, id: string): string {
  return Buffer.from(JSON.stringify({ timestamp, id })).toString("base64");
}
function decodeCursor(cursor: string): { timestamp: number; id: string } {
  return JSON.parse(Buffer.from(cursor, "base64").toString()) as { timestamp: number; id: string };
}

export function createMoeMailMock(domains: string[]): MoeMock {
  const baseUrl = "https://moemail.test";
  const apiKey = "moe-api-key";
  const emails = new Map<string, MoeEmail>();
  let messageSeq = 0;
  let createdSeq = 0;
  let lastGenerate: Record<string, unknown> | null = null;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const authorized = (init?: RequestInit) =>
    (init?.headers as Record<string, string> | undefined)?.["X-API-Key"] === apiKey;

  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (!authorized(init)) return json({ error: "unauthorized" }, 401);

    if (path === "/api/config" && method === "GET") {
      return json({ emailDomains: domains.join(","), webhookEnable: false });
    }

    // 邮箱列表：游标分页（上游 PAGE_SIZE=20，按 createdAt 倒序，且只列未过期的）
    if (path === "/api/emails" && method === "GET") {
      const sorted = [...emails.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
      const cursorStr = url.searchParams.get("cursor");
      let start = 0;
      if (cursorStr) {
        const { timestamp, id } = decodeCursor(cursorStr);
        start = sorted.findIndex((e) => e.createdAt < timestamp || (e.createdAt === timestamp && e.id < id));
        if (start < 0) start = sorted.length;
      }
      const slice = sorted.slice(start, start + MOCK_PAGE_SIZE);
      const last = slice[slice.length - 1];
      const hasMore = start + MOCK_PAGE_SIZE < sorted.length;
      return json({
        emails: slice.map((e) => ({ id: e.id, address: e.email, expiresAt: e.expiresAt ?? null })),
        nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
        total: sorted.length,
      });
    }

    if (path === "/api/emails/generate" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; domain?: string; expiryTime?: number };
      lastGenerate = body;
      // 对齐真实 MoeMail：expiryTime 必填且必须在档位白名单内，否则 400「无效的过期时间」
      if (!VALID_EXPIRY_MS.includes(Number(body.expiryTime))) {
        return json({ error: "无效的过期时间" }, 400);
      }
      const name = String(body.name ?? "").trim();
      const domain = String(body.domain ?? "").trim();
      if (!name || !domains.includes(domain)) return json({ error: "bad name or domain" }, 400);
      for (const e of emails.values()) {
        if (e.email === `${name}@${domain}`) return json({ error: "邮箱已存在" }, 400);
      }
      const expiryMs = Number(body.expiryTime);
      const email: MoeEmail = {
        id: crypto.randomUUID(),
        email: `${name}@${domain}`,
        messages: [],
        createdAt: Date.now() + ++createdSeq, // 单调递增，保证分页序稳定
        // 对齐上游：expiryTime=0 → expiresAt 9999-01-01（永久）
        expiresAt: expiryMs === 0 ? new Date("9999-01-01T00:00:00.000Z").getTime() : Date.now() + expiryMs,
      };
      emails.set(email.id, email);
      // 对齐真实 MoeMail 实测响应：仅 {id, email}，id 为 UUID 字符串，无 expiresAt 字段
      return json({ id: email.id, email: email.email });
    }

    const emailMatch = path.match(/^\/api\/emails\/([^/]+)$/);
    if (emailMatch) {
      const email = emails.get(emailMatch[1]!);
      if (!email) return json({ error: "not found" }, 404);
      if (method === "GET") {
        // 对齐上游：游标分页、按 received_at 倒序（新→旧）、返回 nextCursor + total
        const sorted = [...email.messages].sort((a, b) => {
          const ta = new Date(a.received_at).getTime();
          const tb = new Date(b.received_at).getTime();
          return tb - ta || (a.id < b.id ? 1 : -1);
        });
        const cursorStr = url.searchParams.get("cursor");
        let start = 0;
        if (cursorStr) {
          const { timestamp, id } = decodeCursor(cursorStr);
          start = sorted.findIndex((m) => {
            const t = new Date(m.received_at).getTime();
            return t < timestamp || (t === timestamp && String(m.id) < id);
          });
          if (start < 0) start = sorted.length;
        }
        const slice = sorted.slice(start, start + MOCK_PAGE_SIZE);
        const last = slice[slice.length - 1];
        const hasMore = start + MOCK_PAGE_SIZE < sorted.length;
        return json({
          messages: slice,
          nextCursor: hasMore && last ? encodeCursor(new Date(last.received_at).getTime(), String(last.id)) : null,
          total: sorted.length,
        });
      }
      if (method === "DELETE") {
        emails.delete(email.id);
        return json({ ok: true });
      }
    }

    // 单封详情：GET /api/emails/{emailId}/{messageId}（上游专用端点）
    const detailMatch = path.match(/^\/api\/emails\/([^/]+)\/([^/]+)$/);
    if (detailMatch && method === "GET") {
      const email = emails.get(detailMatch[1]!);
      if (!email) return json({ error: "无权限查看" }, 403);
      const messageId = decodeURIComponent(detailMatch[2]!);
      const msg = email.messages.find((m) => String(m.id) === messageId || m.message_id === messageId);
      if (!msg) return json({ error: "Message not found" }, 404);
      return json({ message: msg });
    }

    // 单封删除：对齐真实上游 app/api/emails/[id]/[messageId]/route.ts
    // （邮箱不属于调用者 → 403；消息不存在 → 404；成功 → 200 {success:true}）
    const messageMatch = path.match(/^\/api\/emails\/([^/]+)\/([^/]+)$/);
    if (messageMatch && method === "DELETE") {
      const email = emails.get(messageMatch[1]!);
      if (!email) return json({ error: "Email not found or no permission to view" }, 403);
      const messageId = decodeURIComponent(messageMatch[2]!);
      const idx = email.messages.findIndex((m) => String(m.id) === messageId || m.message_id === messageId);
      if (idx < 0) return json({ error: "Message not found or already deleted" }, 404);
      email.messages.splice(idx, 1);
      return json({ success: true });
    }

    return json({ error: `unknown endpoint ${method} ${path}` }, 404);
  };

  return {
    baseUrl,
    apiKey,
    fetch: fetchMock,
  deliverMessage(emailId, message) {
    const email = emails.get(emailId);
    if (!email) throw new Error(`mock: 邮箱不存在 ${emailId}`);
      const id = ++messageSeq;
      email.messages.push({
        id,
        message_id: `mid_${id}`,
        subject: message.subject,
        from_address: message.from_address,
        to_address: email.email,
        received_at: new Date(Date.now() + id).toISOString(),
        content: message.content,
        html: `<p>${message.content}</p>`,
      });
      return String(id);
    },
    reset() {
      emails.clear();
      lastGenerate = null;
    },
    lastGenerateBody() {
      return lastGenerate;
    },
  };
}

export function moeCfg(id: string, mock: MoeMock): UpstreamConfig {
  return { id, type: "moemail", baseUrl: mock.baseUrl, apiKey: mock.apiKey, settings: {} };
}
