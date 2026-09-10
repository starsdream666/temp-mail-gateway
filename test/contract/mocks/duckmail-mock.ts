import type { UpstreamConfig } from "../../../src/ports/upstream";

/**
 * DuckMail API 的进程内模拟，端点与字段对齐官方 llm-api-docs.txt：
 * hydra 信封、30 条/页分页、建箱（地址+密码）→ /token 换 Bearer、
 * 消息面按每邮箱 token 鉴权、原始报文在 data 字段。
 */

export interface DuckMock {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  /** 向指定邮箱投递一封测试邮件（可传账号 id 或完整地址），返回消息 id */
  deliverMessage(accountRef: string, message: { from: string; subject: string; text: string }): string;
  /** 让该邮箱当前 Bearer 失效并换成新 token（模拟过期；密码仍可换回） */
  rotateToken(accountRef: string): string;
  /** 让下一次 /token 失败（测建箱后 /token 失败仍登记） */
  failNextToken(once?: boolean): void;
  reset(): void;
}

interface DuckAccount {
  id: string;
  address: string;
  password: string;
  token: string;
}

interface DuckStoredMessage {
  id: string;
  from: { name: string; address: string };
  to: { name: string; address: string }[];
  subject: string;
  text: string;
  html: string[];
  seen: boolean;
  size: number;
  createdAt: string;
  raw: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const hydra = <T,>(rows: T[], total?: number) => ({
  "hydra:member": rows,
  "hydra:totalItems": total ?? rows.length,
  "hydra:view": { "@id": "/?page=1", "@type": "PartialCollectionView" },
});

export function createDuckMailMock(domains: string[], privateDomains: string[] = []): DuckMock {
  const baseUrl = "https://duckmail.test";
  const apiKey = "dk_test_key";
  const accounts = new Map<string, DuckAccount>(); // id → account
  const messagesByAddress = new Map<string, DuckStoredMessage[]>();
  let messageSeq = 0;
  let accountSeq = 0;
  let tokenFailRemaining = 0;

  const findAccount = (accountRef: string): DuckAccount | undefined =>
    accounts.get(accountRef) ??
    [...accounts.values()].find((a) => a.address === accountRef.toLowerCase());

  const bearerOf = (init?: RequestInit) =>
    (init?.headers as Record<string, string> | undefined)?.Authorization?.replace(/^Bearer\s+/i, "") ?? "";

  const accountByToken = (token: string): DuckAccount | null => {
    for (const a of accounts.values()) if (a.token === token) return a;
    return null;
  };

  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const bearer = bearerOf(init);
    const isApiKey = bearer === apiKey;

    if (path === "/domains" && method === "GET") {
      // 带有效 API Key 时额外返回私有域名
      const all = isApiKey ? [...domains, ...privateDomains] : domains;
      const page = Number(url.searchParams.get("page") ?? 1);
      const rows = all.slice((page - 1) * 30, page * 30).map((d, i) => ({
        id: `dom_${page}_${i}`,
        domain: d,
        ownerId: privateDomains.includes(d) ? "owner-1" : null,
        isVerified: true,
      }));
      return json(hydra(rows, all.length));
    }

    if (path === "/accounts" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { address?: string; password?: string; expiresIn?: number };
      const address = String(body.address ?? "").toLowerCase();
      const [localPart, domain] = address.split("@");
      if (!address.includes("@") || !localPart || localPart.length < 3) {
        return json({ error: "validation", message: "username must be at least 3 characters" }, 422);
      }
      if (!domains.includes(domain!) && !privateDomains.includes(domain!)) {
        return json({ error: "validation", message: "domain not verified" }, 422);
      }
      if (privateDomains.includes(domain!) && !isApiKey) {
        return json({ error: "forbidden", message: "API key required for private domain" }, 403);
      }
      if (String(body.password ?? "").length < 6) {
        return json({ error: "validation", message: "password must be at least 6 characters" }, 422);
      }
      for (const a of accounts.values()) {
        if (a.address === address) return json({ error: "conflict", message: "address already exists" }, 409);
      }
      const id = crypto.randomUUID();
      const account: DuckAccount = {
        id,
        address,
        password: String(body.password),
        token: `duck-token-${++accountSeq}`,
      };
      accounts.set(id, account);
      messagesByAddress.set(address, []);
      return json({ id, address, authType: "email", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 201);
    }

    if (path === "/token" && method === "POST") {
      if (tokenFailRemaining > 0) {
        tokenFailRemaining -= 1;
        return json({ error: "unavailable", message: "token service down" }, 503);
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { address?: string; password?: string };
      for (const a of accounts.values()) {
        if (a.address === String(body.address ?? "").toLowerCase() && a.password === body.password) {
          return json({ id: a.id, token: a.token });
        }
      }
      return json({ error: "unauthorized", message: "invalid credentials" }, 401);
    }

    if (path === "/messages" && method === "GET") {
      const account = accountByToken(bearer);
      if (!account) return json({ error: "unauthorized", message: "invalid token" }, 401);
      const messages = messagesByAddress.get(account.address) ?? [];
      const page = Number(url.searchParams.get("page") ?? 1);
      // 真实上游新到旧
      const sorted = [...messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const rows = sorted.slice((page - 1) * 30, page * 30).map((m) => ({
        id: m.id,
        from: m.from,
        to: m.to,
        subject: m.subject,
        seen: m.seen,
        isDeleted: false,
        hasAttachments: false,
        size: m.size,
        createdAt: m.createdAt,
      }));
      return json(hydra(rows, sorted.length));
    }

    const msgMatch = path.match(/^\/messages\/([^/]+)$/);
    if (msgMatch) {
      const id = decodeURIComponent(msgMatch[1]!);
      const account = accountByToken(bearer);
      if (!account) return json({ error: "unauthorized", message: "invalid token" }, 401);
      const messages = messagesByAddress.get(account.address) ?? [];
      const index = messages.findIndex((m) => m.id === id);
      if (index < 0) return json({ error: "not found", message: "message not found" }, 404);
      const m = messages[index]!;

      if (method === "GET") {
        return json({
          id: m.id,
          from: m.from,
          to: m.to,
          subject: m.subject,
          text: m.text,
          html: m.html,
          seen: m.seen,
          hasAttachments: false,
          size: m.size,
          createdAt: m.createdAt,
          attachments: [],
        });
      }
      if (method === "DELETE") {
        messages.splice(index, 1);
        return new Response(null, { status: 204 });
      }
    }

    const srcMatch = path.match(/^\/sources\/([^/]+)$/);
    if (srcMatch && method === "GET") {
      const id = decodeURIComponent(srcMatch[1]!);
      const account = accountByToken(bearer);
      if (!account) return json({ error: "unauthorized", message: "invalid token" }, 401);
      const m = (messagesByAddress.get(account.address) ?? []).find((x) => x.id === id);
      if (!m) return json({ error: "not found", message: "message not found" }, 404);
      return json({ id: m.id, downloadUrl: `/serve/mailbox/${m.id}/source`, data: m.raw });
    }

    const delAccount = path.match(/^\/accounts\/([^/]+)$/);
    if (delAccount && method === "DELETE") {
      const account = accountByToken(bearer);
      if (!account) return json({ error: "unauthorized", message: "invalid token" }, 401);
      if (account.id !== decodeURIComponent(delAccount[1]!)) {
        return json({ error: "forbidden", message: "can only delete own account" }, 403);
      }
      accounts.delete(account.id);
      messagesByAddress.delete(account.address);
      return new Response(null, { status: 204 });
    }

    return json({ error: "not found", message: `unknown endpoint ${method} ${path}` }, 404);
  };

  return {
    baseUrl,
    apiKey,
    fetch: fetchMock,
    deliverMessage(accountRef, message) {
      const target =
        accounts.get(accountRef)?.address ??
        [...accounts.values()].find((a) => a.address === accountRef.toLowerCase())?.address;
      if (!target) throw new Error(`mock: 邮箱不存在 ${accountRef}`);
      const id = `msg_${++messageSeq}`;
      const createdAt = new Date(Date.now() + messageSeq).toISOString();
      const raw = [
        `From: ${message.from}`,
        `To: ${target}`,
        `Subject: ${message.subject}`,
        `Date: ${createdAt}`,
        "Content-Type: text/plain",
        "",
        message.text,
        "",
      ].join("\r\n");
      (messagesByAddress.get(target) ?? []).push({
        id,
        from: { name: "", address: message.from },
        to: [{ name: "", address: target }],
        subject: message.subject,
        text: message.text,
        html: [`<p>${message.text}</p>`],
        seen: false,
        size: raw.length,
        createdAt,
        raw,
      });
      return id;
    },
    rotateToken(accountRef) {
      const account = findAccount(accountRef);
      if (!account) throw new Error(`mock: 邮箱不存在 ${accountRef}`);
      account.token = `duck-token-${++accountSeq}`;
      return account.token;
    },
    failNextToken(once = true) {
      tokenFailRemaining = once ? 1 : Number.POSITIVE_INFINITY;
    },
    reset() {
      accounts.clear();
      tokenFailRemaining = 0;
      messagesByAddress.clear();
      messageSeq = 0;
      accountSeq = 0;
    },
  };
}

export function duckCfg(id: string, mock: DuckMock, withApiKey = false): UpstreamConfig {
  return {
    id,
    type: "duckmail",
    baseUrl: mock.baseUrl,
    apiKey: withApiKey ? mock.apiKey : undefined,
    settings: {},
  };
}
