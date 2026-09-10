import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { UpstreamError, type UpstreamConfig, type MailboxRef } from "../ports/upstream";
import type { UpstreamStore, MailboxStore, ApiKeyStore, HealthStore, OrphanStore, SettingsStore } from "../ports/stores";
import type { AdapterRegistry } from "../adapters/registry";
import type { CryptoPort } from "../ports/crypto";
import type { RateLimiter } from "../core/ratelimit";
import { limitKeyConcurrency, type ConcurrencyLimiter } from "../core/concurrency";
import { AppError } from "../core/errors";
import { newId } from "../core/ids";
import { resolveUpstreamByDomain, pickDomain } from "../core/routing";
import { requireApiKey } from "./middleware/auth";
import type { Env } from "./env";
import {
  ErrorEnvelope,
  DomainEntry,
  CreateMailboxBody,
  Mailbox,
  MessageSummarySchema,
  MessageDetailSchema,
  BoolQuery,
  isTrueQuery,
  DeleteMailboxResult,
  presentMailbox,
  presentMessageSummary,
  presentMessageDetail,
} from "./schemas";

export interface GatewayStores {
  upstreams: UpstreamStore;
  mailboxes: MailboxStore;
  apiKeys: ApiKeyStore;
  health: HealthStore;
  orphans: OrphanStore;
  settings: SettingsStore;
}

export interface V1Deps {
  stores: GatewayStores;
  registry: AdapterRegistry;
  crypto: CryptoPort;
  rateLimiter: RateLimiter;
  concurrencyLimiter: ConcurrencyLimiter;
}

const errResp = (description: string) => ({
  content: { "application/json": { schema: ErrorEnvelope } },
  description,
});

export function registerV1Routes(app: OpenAPIHono<Env>, deps: V1Deps): void {
  const { stores, registry, crypto, rateLimiter } = deps;

  // /v1/* 全部需要网关 API key
  app.use("/v1/*", requireApiKey(stores.apiKeys));
  app.use("/v1/*", limitKeyConcurrency(deps.concurrencyLimiter));

  // ---------- GET /v1/domains ----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/domains",
      tags: ["gateway"],
      summary: "列出所有可用域名（含归属上游元数据）",
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ domains: z.array(DomainEntry) }) } },
          description: "OK",
        },
        401: errResp("未授权"),
      },
    }),
    async (c) => {
      const rows = await stores.upstreams.listActiveDomains();
      const apiKey = c.get("apiKey");
      // 只返回对该调用方真正可用的域名：启用域名 ∩ key 域名白名单 ∩ key 渠道白名单
      const byChannels =
        apiKey.channels && apiKey.channels.length > 0
          ? rows.filter((r) => apiKey.channels!.includes(r.id))
          : rows;
      const filtered =
        apiKey.domains && apiKey.domains.length > 0
          ? byChannels.filter((r) => apiKey.domains!.includes(r.domain))
          : byChannels;
      // S-03：共享域名可能登记在多个渠道 → listActiveDomains 有重复行。API 按域名去重，
      // 每域名只返回一条（取登记序最早的渠道，与 resolveUpstreamByDomain 选主一致），
      // 否则调用方渲染域名下拉会看到重复项。
      const seen = new Set<string>();
      const unique: typeof filtered = [];
      for (const r of filtered) {
        if (seen.has(r.domain)) continue;
        seen.add(r.domain);
        unique.push(r);
      }
      return c.json(
        {
          domains: unique.map((r) => ({
            domain: r.domain,
            upstreamId: r.id,
            upstreamType: r.type,
            isPrivate: r.isPrivate,
          })),
        },
        200,
      );
    },
  );

  // ---------- POST /v1/mailboxes ----------
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/mailboxes",
      tags: ["gateway"],
      summary: "创建邮箱（按域名路由到对应上游）",
      request: {
        body: { content: { "application/json": { schema: CreateMailboxBody } }, required: true },
      },
      responses: {
        201: { content: { "application/json": { schema: z.object({ mailbox: Mailbox }) } }, description: "已创建" },
        400: errResp("域名无法路由 / 参数不合法"),
        401: errResp("未授权"),
        403: errResp("域名/渠道已停用，或不在该 key 的白名单内"),
        409: errResp("地址已被占用"),
        429: errResp("创建速率超限"),
        502: errResp("上游错误"),
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const apiKey = c.get("apiKey");

      const limit = apiKey.mailboxesPerHour ?? c.get("settings").mailboxesPerKeyPerHour;
      if (!rateLimiter.consume(apiKey.id, Date.now(), limit)) {
        throw new AppError("RATE_LIMITED", "该 key 的邮箱创建速率超限，请稍后再试");
      }

      const upstream = body.domain
        ? await resolveUpstreamByDomain(stores.upstreams, body.domain, {
            allowedChannels: apiKey.channels,
            allowedDomains: apiKey.domains,
          })
        : await pickDomain(stores.upstreams, {
            allowedDomains: apiKey.domains,
            allowedChannels: apiKey.channels,
          });

      // key 渠道白名单：配置了名单时，只能创建到名单内渠道（选主已优先选白名单内渠道，
      // 这里兜底防「候选全在白名单外时」的误放行；随机挑选已在 pickDomain 内过滤）
      if (apiKey.channels && apiKey.channels.length > 0 && !apiKey.channels.includes(upstream.id)) {
        throw new AppError(
          "CHANNEL_NOT_ALLOWED",
          `当前 key 无权使用渠道「${upstream.name}」（请联系管理员调整该 key 的渠道白名单）`,
        );
      }

      // key 域名白名单：配置了名单时，只能在其域名内创建（随机挑选已在 pickDomain 内过滤）
      if (apiKey.domains && apiKey.domains.length > 0 && !apiKey.domains.includes(upstream.domain)) {
        throw new AppError(
          "DOMAIN_NOT_ALLOWED",
          `当前 key 无权使用域名 ${upstream.domain}（请联系管理员调整该 key 的域名白名单）`,
        );
      }

      const localPart = body.localPart?.toLowerCase();
      if (localPart) {
        const existing = await stores.mailboxes.findByAddress(`${localPart}@${upstream.domain}`);
        if (existing) throw new AppError("LOCAL_PART_TAKEN", `地址 ${existing.address} 已存在`);
      }

      const adapter = getAdapter(registry, upstream.type);
      const cfg = await upstreamConfigOf(upstream, crypto);
      const ref = await adapter.createMailbox(cfg, {
        localPart,
        domain: upstream.domain,
        expiresInSeconds: body.expiresInSeconds,
      });

      // 过期时间以上游返回的权威值为准（上游可能改写或钳制）；
      // 上游未给出时才用调用方的请求参数推算，两者都无则视为无到期时间。
      const expiresAt =
        ref.expiresAt ??
        (body.expiresInSeconds ? new Date(Date.now() + body.expiresInSeconds * 1000) : null);

      const row = await stores.mailboxes.create({
        id: newId(),
        upstreamId: upstream.id,
        address: ref.address.toLowerCase(),
        localPart: ref.address.split("@")[0]!.toLowerCase(),
        domain: upstream.domain,
        upstreamMailboxId: ref.upstreamMailboxId,
        credentialsEnc: ref.credentials ? await crypto.encrypt(ref.credentials) : null,
        passwordEnc: ref.password ? await crypto.encrypt(ref.password) : null,
        apiKeyId: apiKey.id,
        expiresAt,
      });
      return c.json({ mailbox: presentMailbox(row) }, 201);
    },
  );

  // ---------- GET /v1/mailboxes ----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/mailboxes",
      tags: ["gateway"],
      summary: "列出本 key 创建的邮箱（分页，新→旧）",
      description:
        "只返回调用方 key 名下的邮箱。透传自动登记的共享邮箱（无归属 key）默认不列出，需显式 includeShared=1；已过期记录默认不列出，需 includeExpired=1。",
      request: {
        query: z.object({
          limit: z.coerce.number().int().positive().max(100).optional(),
          offset: z.coerce.number().int().nonnegative().optional(),
          includeExpired: BoolQuery.optional(),
          includeShared: BoolQuery.optional(),
        }),
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({ total: z.number().int(), mailboxes: z.array(Mailbox) }),
            },
          },
          description: "OK",
        },
        401: errResp("未授权"),
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const apiKey = c.get("apiKey");
      // 列表口径严格按归属（apiKeyId 相等）；透传登记的共享记录 apiKeyId 为 null，
      // 只有显式 includeShared 才并入——比 requireMailbox 的读取口径严，
      // 否则批量注册/其他客户端经透传建的邮箱会灌进普通调用方的列表。
      const filter = {
        apiKeyId: apiKey.id,
        includeShared: isTrueQuery(q.includeShared),
        includeExpired: isTrueQuery(q.includeExpired),
        now: new Date(),
      };
      const rows = await stores.mailboxes.list({
        ...filter,
        limit: q.limit ?? 20,
        offset: q.offset ?? 0,
      });
      // 总数与列表同口径，否则分页页码算错
      return c.json(
        { total: await stores.mailboxes.count(filter), mailboxes: rows.map(presentMailbox) },
        200,
      );
    },
  );

  // ---------- GET /v1/mailboxes/:id ----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/mailboxes/{id}",
      tags: ["gateway"],
      summary: "邮箱详情",
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        200: { content: { "application/json": { schema: z.object({ mailbox: Mailbox }) } }, description: "OK" },
        401: errResp("未授权"),
        404: errResp("邮箱不存在"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      // 详情要能查已过期的记录：客户端正是靠它判断"是过期了还是被删了"
      const row = await requireMailbox(stores.mailboxes, id, c.get("apiKey"), { allowExpired: true });
      return c.json({ mailbox: presentMailbox(row) }, 200);
    },
  );

  // ---------- DELETE /v1/mailboxes/:id ----------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/mailboxes/{id}",
      tags: ["gateway"],
      summary: "删除邮箱（同时删除上游侧；?force=1 为尽力删除）",
      description:
        "默认严格语义：上游删除失败 → 502 且保留网关记录。?force=1 为尽力删除——仍尝试删上游，" +
        "但无论上游结果如何都删除网关记录，并在响应里如实回报 upstreamDeleted。" +
        "上游返回「不存在」一律视为删除成功（幂等）。依赖每邮箱独立凭证的上游（如 DuckMail）" +
        "拒绝 force：删掉记录就永久失去清理上游的能力。",
      request: {
        params: z.object({ id: z.string().min(1) }),
        query: z.object({ force: BoolQuery.optional() }),
      },
      responses: {
        200: {
          content: { "application/json": { schema: DeleteMailboxResult } },
          description: "已删除（force=1 的回报形态）",
        },
        204: { description: "已删除" },
        401: errResp("未授权"),
        404: errResp("邮箱不存在"),
        409: errResp("该上游不支持尽力删除（凭证型上游）"),
        502: errResp("上游错误"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const forced = isTrueQuery(c.req.valid("query").force);
      // 过期记录必须可删，否则它会永久留在列表里（上游那边早就没了）
      const row = await requireMailbox(stores.mailboxes, id, c.get("apiKey"), { allowExpired: true });
      const upstream = await requireUpstream(stores.upstreams, row.upstreamId);
      const adapter = getAdapter(registry, upstream.type);
      const cfg = await upstreamConfigOf(upstream, crypto);
      const ref = await mailboxRefOf(row, crypto);

      let upstreamDeleted = true;
      let upstreamError: { code: string; message: string } | undefined;
      try {
        await adapter.deleteMailbox(cfg, ref);
      } catch (err) {
        const code = upstreamErrorCode(err);
        // 上游不支持删邮箱、或上游已经没有这个邮箱 → 网关记录照删（幂等），不需要 force
        const benign = code === "CAPABILITY_MISSING" || code === "NOT_FOUND";
        if (!benign) {
          if (!forced) throw err;
          if (adapter.requiresMailboxCredentials) {
            // 凭证随记录一起消失后上游邮箱永久不可读、也无法重试删除 → 宁可保留记录
            throw new AppError(
              "FORCE_DELETE_UNSAFE",
              `上游「${upstream.name}」的邮箱操作依赖每邮箱独立凭证，删除网关记录会导致上游邮箱无法回收；请稍后重试（上游错误：${errorMessageOf(err)}）`,
            );
          }
        }
        upstreamDeleted = false;
        upstreamError = { code: code ?? "UNKNOWN", message: errorMessageOf(err) };
        // 上游「已经没有这个邮箱」不算残留；其余情况网关记录即将消失而上游可能还在，
        // 留一条线索供管理端提示人工清理，否则这个事实只存在于本次 HTTP 响应里。
        if (code !== "NOT_FOUND") {
          try {
            await stores.orphans.insert({
              id: newId(),
              upstreamId: upstream.id,
              upstreamName: upstream.name,
              address: row.address,
              upstreamMailboxId: row.upstreamMailboxId,
              errorCode: code ?? "UNKNOWN",
              error: errorMessageOf(err).slice(0, 500),
            });
          } catch (logErr) {
            // 记账失败不能反过来把删除请求搞失败
            console.warn("[gateway] 记录孤儿邮箱失败:", logErr);
          }
        }
      }
      await stores.mailboxes.delete(row.id);
      if (!forced) return c.body(null, 204);
      return c.json({ deleted: true as const, upstreamDeleted, ...(upstreamError ? { upstreamError } : {}) }, 200);
    },
  );

  // ---------- GET /v1/mailboxes/:id/messages ----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/mailboxes/{id}/messages",
      tags: ["gateway"],
      summary: "列消息（?since=<上一页最后一条消息 id> 增量拉取）",
      request: {
        params: z.object({ id: z.string().min(1) }),
        query: z.object({ since: z.string().optional() }),
      },
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ messages: z.array(MessageSummarySchema) }) } },
          description: "OK",
        },
        401: errResp("未授权"),
        404: errResp("邮箱不存在"),
        410: errResp("邮箱已过期（上游已回收）"),
        502: errResp("上游错误"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { since } = c.req.valid("query");
      const row = await requireMailbox(stores.mailboxes, id, c.get("apiKey"));
      const upstream = await requireUpstream(stores.upstreams, row.upstreamId);
      const adapter = getAdapter(registry, upstream.type);
      const cfg = await upstreamConfigOf(upstream, crypto);
      const ref = await mailboxRefOf(row, crypto);
      const messages = await adapter.listMessages(cfg, ref, { since });
      return c.json({ messages: messages.map(presentMessageSummary) }, 200);
    },
  );

  // ---------- GET /v1/mailboxes/:id/messages/:mid ----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/mailboxes/{id}/messages/{mid}",
      tags: ["gateway"],
      summary: "消息详情（text / html / 附件元数据）",
      request: { params: z.object({ id: z.string().min(1), mid: z.string().min(1) }) },
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ message: MessageDetailSchema }) } },
          description: "OK",
        },
        401: errResp("未授权"),
        404: errResp("邮箱或消息不存在"),
        410: errResp("邮箱已过期（上游已回收）"),
        502: errResp("上游错误"),
      },
    }),
    async (c) => {
      const { id, mid } = c.req.valid("param");
      const row = await requireMailbox(stores.mailboxes, id, c.get("apiKey"));
      const upstream = await requireUpstream(stores.upstreams, row.upstreamId);
      const adapter = getAdapter(registry, upstream.type);
      const cfg = await upstreamConfigOf(upstream, crypto);
      const ref = await mailboxRefOf(row, crypto);
      const message = await adapter.getMessage(cfg, ref, mid);
      return c.json({ message: presentMessageDetail(message) }, 200);
    },
  );

  // ---------- DELETE /v1/mailboxes/:id/messages/:mid ----------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/mailboxes/{id}/messages/{mid}",
      tags: ["gateway"],
      summary: "删除消息",
      request: { params: z.object({ id: z.string().min(1), mid: z.string().min(1) }) },
      responses: {
        204: { description: "已删除" },
        401: errResp("未授权"),
        404: errResp("邮箱或消息不存在"),
        410: errResp("邮箱已过期（上游已回收）"),
        501: errResp("该上游不支持删除消息"),
      },
    }),
    async (c) => {
      const { id, mid } = c.req.valid("param");
      const row = await requireMailbox(stores.mailboxes, id, c.get("apiKey"));
      const upstream = await requireUpstream(stores.upstreams, row.upstreamId);
      const adapter = getAdapter(registry, upstream.type);
      if (!adapter.deleteMessage) throw new AppError("CAPABILITY_MISSING", "该上游不支持删除消息");
      const cfg = await upstreamConfigOf(upstream, crypto);
      const ref = await mailboxRefOf(row, crypto);
      await adapter.deleteMessage(cfg, ref, mid);
      return c.body(null, 204);
    },
  );

  // ---------- GET /v1/mailboxes/:id/messages/:mid/source ----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/mailboxes/{id}/messages/{mid}/source",
      tags: ["gateway"],
      summary: "原始报文（message/rfc822）",
      request: { params: z.object({ id: z.string().min(1), mid: z.string().min(1) }) },
      responses: {
        200: {
          content: { "message/rfc822": { schema: z.string().openapi({ format: "binary" }) } },
          description: "OK",
        },
        401: errResp("未授权"),
        404: errResp("邮箱或消息不存在"),
        410: errResp("邮箱已过期（上游已回收）"),
        501: errResp("该上游不支持原始报文"),
      },
    }),
    async (c) => {
      const { id, mid } = c.req.valid("param");
      const row = await requireMailbox(stores.mailboxes, id, c.get("apiKey"));
      const upstream = await requireUpstream(stores.upstreams, row.upstreamId);
      const adapter = getAdapter(registry, upstream.type);
      if (!adapter.getSource) throw new AppError("CAPABILITY_MISSING", "该上游不支持原始报文");
      const cfg = await upstreamConfigOf(upstream, crypto);
      const ref = await mailboxRefOf(row, crypto);
      const source = await adapter.getSource(cfg, ref, mid);
      const buf = source.buffer.slice(
        source.byteOffset,
        source.byteOffset + source.byteLength,
      ) as ArrayBuffer;
      return c.body(buf, 200, { "Content-Type": "message/rfc822" });
    },
  );

  // ---------- helpers ----------

  function getAdapter(reg: AdapterRegistry, type: string) {
    if (!reg.has(type)) {
      throw new AppError("ADAPTER_MISSING", `上游类型 ${type} 未接入网关`);
    }
    return reg.get(type);
  }

  /**
   * 定位邮箱并做租户隔离。
   * opts.allowExpired：读信/删信这类"用邮箱做事"的路径拒绝已过期记录（410），
   * 因为上游到期就回收了，再转发只会拿回一个语义模糊的上游 404 → 502；
   * 而查详情与删除自身必须放行过期记录，否则用户既看不到状态也删不掉它。
   */
  async function requireMailbox(
    mailboxes: MailboxStore,
    id: string,
    caller: { id: string },
    opts?: { allowExpired?: boolean },
  ) {
    const row = await mailboxes.get(id);
    if (!row) throw new AppError("MAILBOX_NOT_FOUND", `邮箱不存在: ${id}`);
    // 租户隔离：邮箱归属其他 key 时按「不存在」处理（404 而非 403，不泄露 ID 存在性）。
    // apiKeyId 为 null 的是透传自动登记 / 管理员会话创建的共享邮箱，保持可访问；
    // admin-session 身份（管理员会话调透传）可访问全部。
    if (row.apiKeyId !== null && row.apiKeyId !== caller.id && caller.id !== "admin-session") {
      throw new AppError("MAILBOX_NOT_FOUND", `邮箱不存在: ${id}`);
    }
    if (!opts?.allowExpired && row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      throw new AppError(
        "MAILBOX_EXPIRED",
        `邮箱 ${row.address} 已于 ${row.expiresAt.toISOString()} 过期，上游已回收；可删除该记录或重新创建`,
      );
    }
    return row;
  }

  async function requireUpstream(store: UpstreamStore, id: string) {
    const row = await store.get(id);
    if (!row) throw new AppError("NOT_FOUND", `上游不存在: ${id}`);
    return row;
  }
}

export async function upstreamConfigOf(
  row: { id: string; type: string; baseUrl: string; apiKeyEnc: string | null; settingsJson: Record<string, unknown> },
  crypto: CryptoPort,
): Promise<UpstreamConfig> {
  return {
    id: row.id,
    type: row.type,
    baseUrl: row.baseUrl,
    apiKey: row.apiKeyEnc ? await crypto.decrypt(row.apiKeyEnc) : undefined,
    settings: row.settingsJson,
  };
}

export async function mailboxRefOf(row: {
  upstreamMailboxId: string;
  address: string;
  credentialsEnc: string | null;
  passwordEnc: string | null;
  expiresAt: Date | null;
}, crypto: CryptoPort): Promise<MailboxRef> {
  return {
    upstreamMailboxId: row.upstreamMailboxId,
    address: row.address,
    credentials: row.credentialsEnc ? await crypto.decrypt(row.credentialsEnc) : undefined,
    password: row.passwordEnc ? await crypto.decrypt(row.passwordEnc) : undefined,
    expiresAt: row.expiresAt ?? undefined,
  };
}

export function isCapabilityMissing(err: unknown): boolean {
  return err instanceof UpstreamError && err.code === "CAPABILITY_MISSING";
}

/** 上游错误码（非 UpstreamError 时 undefined，交由调用方按未知处理） */
function upstreamErrorCode(err: unknown): string | undefined {
  return err instanceof UpstreamError ? err.code : undefined;
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
