import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { Context } from "hono";
import type { Env } from "./env";
import type { GatewayStores } from "./v1";
import type { AdminAuthConfig } from "./middleware/auth";
import { requireAdmin, issueAdminSession, clearAdminSession } from "./middleware/auth";
import type { AdapterRegistry } from "../adapters/registry";
import type { CryptoPort } from "../ports/crypto";
import { AppError } from "../core/errors";
import { newId } from "../core/ids";
import { generateApiKey } from "../core/keys";
import { RateLimiter } from "../core/ratelimit";
import type { GatewayConfig } from "../core/app";
import { registerSettingsRoutes } from "./settings";
import { runHealthChecks, effectiveMonitorIntervalMs, autoSyncDomainsEnabled, HEALTH_HISTORY_KEEP } from "../core/monitor";
import { resolveUpstreamByDomain } from "../core/routing";
import { UpstreamError } from "../ports/upstream";
import { upstreamConfigOf } from "./v1";
import {
  ErrorEnvelope,
  Mailbox,
  CreateUpstreamBody,
  UpdateUpstreamBody,
  UpstreamSummary,
  UpstreamDetail,
  SyncDomainsResult,
  CreateKeyBody,
  UpdateKeyBody,
  ApiKeyInfo,
  CreatedApiKey,
  AdapterTypeInfo,
  SessionBody,
  AdminDomainEntry,
  DomainToggleBody,
  MonitorConfigBody,
  UpstreamDomainEntry,
  ImportMailboxesBody,
  ImportMailboxesResult,
  OrphanEntry,
  presentUpstreamSummary,
  presentApiKey,
  presentAdapterMeta,
  presentMailbox,
  presentOrphan,
} from "./schemas";

export interface AdminDeps {
  stores: GatewayStores;
  registry: AdapterRegistry;
  crypto: CryptoPort;
  admin: AdminAuthConfig;
  /** 登录限流器注入点；缺省在注册路由时新建（限流器生命周期须长于单次请求，见 GatewayDeps.limiters） */
  loginLimiter?: RateLimiter;
  config: GatewayConfig;
}

/** 登录尝试限速：每来源每 10 分钟 10 次，防止管理密码被在线爆破 */
export const LOGIN_ATTEMPT_LIMIT = 10;
export const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const errResp = (description: string) => ({
  content: { "application/json": { schema: ErrorEnvelope } },
  description,
});

const IdParams = z.object({ id: z.string().min(1) });

export function registerAdminRoutes(app: OpenAPIHono<Env>, deps: AdminDeps): void {
  const { stores, registry, crypto } = deps;
  const loginLimiter = deps.loginLimiter ?? new RateLimiter(LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS);

  // ---------- 会话（无需鉴权） ----------
  app.openapi(
    createRoute({
      method: "post",
      path: "/admin/session",
      tags: ["admin"],
      summary: "登录（校验密码并种下会话 cookie）",
      request: { body: { content: { "application/json": { schema: SessionBody } }, required: true } },
      responses: {
        204: { description: "已登录" },
        401: errResp("密码错误"),
        429: errResp("尝试过于频繁"),
      },
    }),
    async (c) => {
      const { password } = c.req.valid("json");
      if (!loginLimiter.consume(clientKeyOf(c))) {
        throw new AppError("RATE_LIMITED", "登录尝试过于频繁，请稍后再试");
      }
      const ok = await issueAdminSession(c, password, deps.admin);
      if (!ok) throw new AppError("UNAUTHORIZED", "密码错误");
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/admin/session",
      tags: ["admin"],
      summary: "退出登录",
      responses: { 204: { description: "已退出" } },
    }),
    (c) => {
      clearAdminSession(c);
      return c.body(null, 204);
    },
  );

  // ---------- 以下路由需要管理员会话 ----------
  app.use("/admin/*", requireAdmin(deps.admin));
  registerSettingsRoutes(app, deps);

  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/me",
      tags: ["admin"],
      summary: "会话检查",
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ authenticated: z.boolean() }) } },
          description: "OK",
        },
        401: errResp("未登录"),
      },
    }),
    (c) => c.json({ authenticated: true }, 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/adapter-types",
      tags: ["admin"],
      summary: "列出已注册的适配器类型（供上游表单下拉）",
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ types: z.array(AdapterTypeInfo) }) } },
          description: "OK",
        },
        401: errResp("未登录"),
      },
    }),
    (c) => c.json({ types: registry.listMetas().map(presentAdapterMeta) }, 200),
  );

  // ---------- 上游 CRUD ----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/upstreams",
      tags: ["admin"],
      summary: "上游列表",
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ upstreams: z.array(UpstreamSummary) }) } },
          description: "OK",
        },
        401: errResp("未登录"),
      },
    }),
    async (c) => {
      const rows = await stores.upstreams.list();
      const items = await Promise.all(
        rows.map(async (r) => presentUpstreamSummary(r, await stores.upstreams.countDomains(r.id))),
      );
      return c.json({ upstreams: items }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/admin/upstreams",
      tags: ["admin"],
      summary: "新建上游（成功后自动同步一次域名）",
      request: { body: { content: { "application/json": { schema: CreateUpstreamBody } }, required: true } },
      responses: {
        201: {
          content: {
            "application/json": { schema: z.object({ upstream: UpstreamDetail, sync: SyncDomainsResult.optional() }) },
          },
          description: "已创建",
        },
        400: errResp("参数不合法或适配器类型未注册"),
        401: errResp("未登录"),
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      if (!registry.has(body.type)) {
        throw new AppError("VALIDATION_ERROR", `适配器类型未注册: ${body.type}`);
      }
      const id = newId();
      const row = await stores.upstreams.create({
        id,
        name: body.name,
        type: body.type,
        baseUrl: body.baseUrl.replace(/\/+$/, ""),
        apiKeyEnc: body.apiKey ? await crypto.encrypt(body.apiKey) : null,
        settingsJson: body.settings ?? {},
        enabled: body.enabled,
      });

      // 创建后尽力同步一次域名；失败不阻断创建
      let sync: { added: string[]; removed: string[]; total: number; warning?: string } | undefined;
      try {
        sync = await syncDomains(registry, stores, crypto, row.id);
      } catch (err) {
        sync = { added: [], removed: [], total: 0, warning: `域名同步失败：${(err as Error).message}` };
      }

      const detail = await upstreamDetail(stores, row.id);
      return c.json({ upstream: detail, sync }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/upstreams/{id}",
      tags: ["admin"],
      summary: "上游详情（含域名列表）",
      request: { params: IdParams },
      responses: {
        200: { content: { "application/json": { schema: z.object({ upstream: UpstreamDetail }) } }, description: "OK" },
        401: errResp("未登录"),
        404: errResp("不存在"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const detail = await upstreamDetail(stores, id);
      return c.json({ upstream: detail }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/admin/upstreams/{id}",
      tags: ["admin"],
      summary: "更新上游（apiKey 未传则保持不变；显式传 null 清除）",
      request: {
        params: IdParams,
        body: { content: { "application/json": { schema: UpdateUpstreamBody } }, required: true },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ upstream: UpstreamDetail }) } }, description: "OK" },
        400: errResp("参数不合法"),
        401: errResp("未登录"),
        404: errResp("不存在"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const existing = await stores.upstreams.get(id);
      if (!existing) throw new AppError("NOT_FOUND", `上游不存在: ${id}`);

      await stores.upstreams.update(id, {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.baseUrl !== undefined && { baseUrl: body.baseUrl.replace(/\/+$/, "") }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        ...(body.settings !== undefined && { settingsJson: body.settings }),
        ...(body.apiKey === null && { apiKeyEnc: null }),
        ...(body.apiKey ? { apiKeyEnc: await crypto.encrypt(body.apiKey) } : {}),
      });

      const detail = await upstreamDetail(stores, id);
      return c.json({ upstream: detail }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/admin/upstreams/{id}",
      tags: ["admin"],
      summary: "删除上游（名下有邮箱时拒绝）",
      request: { params: IdParams },
      responses: {
        204: { description: "已删除" },
        401: errResp("未登录"),
        404: errResp("不存在"),
        409: errResp("名下仍有邮箱"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      await stores.upstreams.delete(id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/admin/upstreams/{id}/sync-domains",
      tags: ["admin"],
      summary: "从上游同步域名，返回增删差异（已停用的域名保留停用状态）",
      request: { params: IdParams },
      responses: {
        200: { content: { "application/json": { schema: z.object({ sync: SyncDomainsResult }) } }, description: "OK" },
        401: errResp("未登录"),
        404: errResp("不存在"),
        502: errResp("上游错误"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const started = Date.now();
      const sync = await syncDomains(registry, stores, crypto, id);
      // 手动同步同样完成了存活探测，记录成功结果以立即解除此前的同步告警。
      await stores.health.insert({
        id: newId(),
        upstreamId: id,
        status: "up",
        latencyMs: Date.now() - started,
        domainsTotal: sync.total,
        domainsAdded: sync.added,
        domainsRemoved: sync.removed,
        syncAction: "applied",
      });
      await stores.health.prune(id, HEALTH_HISTORY_KEEP);
      return c.json({ sync }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/admin/upstreams/{id}/domains/{domain}",
      tags: ["admin"],
      summary: "开启/关闭某域名的调用（停用后统一 API 不再路由/列出该域名）",
      request: {
        params: z.object({ id: z.string().min(1), domain: z.string().min(1) }),
        body: { content: { "application/json": { schema: DomainToggleBody } }, required: true },
      },
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ domain: UpstreamDomainEntry }) } },
          description: "OK",
        },
        401: errResp("未登录"),
        404: errResp("该上游下不存在此域名"),
      },
    }),
    async (c) => {
      const { id, domain } = c.req.valid("param");
      const { enabled } = c.req.valid("json");
      const normalized = domain.trim().toLowerCase();
      const ok = await stores.upstreams.setDomainEnabled(id, normalized, enabled);
      if (!ok) throw new AppError("NOT_FOUND", `该上游下不存在域名 ${normalized}`);
      const detail = await upstreamDetail(stores, id);
      const updated = detail.domains.find((d) => d.domain === normalized)!;
      return c.json({ domain: updated }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/admin/upstreams/{id}/domains",
      tags: ["admin"],
      summary: "批量开启/关闭某渠道（上游实例）的全部域名调用（不同于停用上游实例：读信与透传 GET 不受影响）",
      request: {
        params: IdParams,
        body: { content: { "application/json": { schema: DomainToggleBody } }, required: true },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: z.object({ upstreamId: z.string(), enabled: z.boolean(), affected: z.number().int() }) },
          },
          description: "OK",
        },
        401: errResp("未登录"),
        404: errResp("上游不存在"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { enabled } = c.req.valid("json");
      const row = await stores.upstreams.get(id);
      if (!row) throw new AppError("NOT_FOUND", `上游不存在: ${id}`);
      const affected = await stores.upstreams.setAllDomainsEnabled(id, enabled);
      return c.json({ upstreamId: id, enabled, affected }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/admin/upstreams/{id}/monitor",
      tags: ["admin"],
      summary: "配置渠道测活频率（intervalMs 传 null 跟随全局默认；disabled 关闭该渠道自动监控）",
      request: {
        params: IdParams,
        body: { content: { "application/json": { schema: MonitorConfigBody } }, required: true },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                upstreamId: z.string(),
                monitorIntervalMs: z.number().nullable(),
                monitorDisabled: z.boolean(),
                effectiveIntervalMs: z.number().nullable(),
                autoSyncDomains: z.boolean(),
              }),
            },
          },
          description: "OK",
        },
        400: errResp("参数不合法"),
        401: errResp("未登录"),
        404: errResp("上游不存在"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const row = await stores.upstreams.get(id);
      if (!row) throw new AppError("NOT_FOUND", `上游不存在: ${id}`);

      const settings: Record<string, unknown> = { ...row.settingsJson };
      if (body.intervalMs !== undefined) {
        if (body.intervalMs === null) {
          delete settings.monitorIntervalMs; // 跟随全局默认
        } else {
          // 下限保护：过于频繁会消耗上游（尤其 CF 托管）的请求配额
          settings.monitorIntervalMs = Math.max(60_000, body.intervalMs);
        }
      }
      if (body.disabled !== undefined) {
        if (body.disabled) settings.monitorDisabled = true;
        else delete settings.monitorDisabled;
      }
      if (body.autoSyncDomains !== undefined) {
        // 只在关闭时落键：缺省即开启，不给已有渠道塞冗余配置
        if (body.autoSyncDomains) delete settings.autoSyncDomains;
        else settings.autoSyncDomains = false;
      }
      await stores.upstreams.update(id, { settingsJson: settings });

      const updated = await stores.upstreams.get(id);
      return c.json(
        {
          upstreamId: id,
          monitorIntervalMs:
            Number(updated?.settingsJson.monitorIntervalMs) > 0
              ? Number(updated?.settingsJson.monitorIntervalMs)
              : null,
          monitorDisabled: updated?.settingsJson.monitorDisabled === true,
          effectiveIntervalMs: c.get("settings").healthCheckEnabled ? effectiveMonitorIntervalMs(updated?.settingsJson ?? {}, c.get("settings").healthCheckIntervalMs) : null,
          autoSyncDomains: autoSyncDomainsEnabled(updated?.settingsJson ?? {}),
        },
        200,
      );
    },
  );

  // ---------- 网关 API key ----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/keys",
      tags: ["admin"],
      summary: "API key 列表",
      responses: {
        200: { content: { "application/json": { schema: z.object({ keys: z.array(ApiKeyInfo) }) } }, description: "OK" },
        401: errResp("未登录"),
      },
    }),
    async (c) => {
      const settings = c.get("settings");
      return c.json({ keys: (await stores.apiKeys.list()).map((row) => presentApiKey(row, settings.mailboxesPerKeyPerHour, settings.maxConcurrentRequestsPerKey)) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/admin/keys",
      tags: ["admin"],
      summary: "签发 API key（可配置域名、渠道白名单与每小时邮箱创建上限）",
      request: { body: { content: { "application/json": { schema: CreateKeyBody } }, required: true } },
      responses: {
        201: { content: { "application/json": { schema: z.object({ key: CreatedApiKey }) } }, description: "已创建" },
        400: errResp("参数不合法"),
        401: errResp("未登录"),
      },
    }),
    async (c) => {
      const { name, domains, channels, mailboxesPerHour, maxConcurrentRequests } = c.req.valid("json");
      const generated = await generateApiKey();
      const row = await stores.apiKeys.create({
        id: newId(),
        name,
        keyHash: generated.keyHash,
        prefix: generated.prefix,
        // 完整明文加密落库：管理端可随时取回复制（与上游 apiKey 的存储方式一致）
        keyEnc: await crypto.encrypt(generated.key),
        domains: normalizeDomainList(domains) ?? null,
        channels: (await normalizeChannelList(stores, channels)) ?? null,
        mailboxesPerHour: mailboxesPerHour ?? null,
        maxConcurrentRequests: maxConcurrentRequests ?? null,
      });
      const settings = c.get("settings");
      return c.json({ key: { ...presentApiKey(row, settings.mailboxesPerKeyPerHour, settings.maxConcurrentRequestsPerKey), key: generated.key } }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/admin/keys/{id}/reveal",
      tags: ["admin"],
      summary: "取回 key 的完整明文（加密存储；旧版本创建的 key 无明文可取）",
      request: { params: IdParams },
      responses: {
        200: { content: { "application/json": { schema: z.object({ key: z.string() }) } }, description: "OK" },
        401: errResp("未登录"),
        404: errResp("不存在"),
        409: errResp("该 key 创建于旧版本，明文未保存，无法取回"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const row = await stores.apiKeys.get(id);
      if (!row) throw new AppError("NOT_FOUND", `key 不存在: ${id}`);
      if (!row.keyEnc) {
        throw new AppError("KEY_PLAINTEXT_UNAVAILABLE", "该 key 创建于旧版本（仅存哈希），明文无法取回，请重新签发");
      }
      return c.json({ key: await crypto.decrypt(row.keyEnc) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/admin/keys/{id}",
      tags: ["admin"],
      summary: "更新 API key（名称 / 白名单 / 启停 / 每小时邮箱创建上限；mailboxesPerHour 传 null 恢复默认，0 不限）",
      request: {
        params: IdParams,
        body: { content: { "application/json": { schema: UpdateKeyBody } }, required: true },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ key: ApiKeyInfo }) } }, description: "OK" },
        400: errResp("参数不合法"),
        401: errResp("未登录"),
        404: errResp("不存在"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const updated = await stores.apiKeys.update(id, {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        ...(body.domains !== undefined && { domains: normalizeDomainList(body.domains) }),
        ...(body.channels !== undefined && { channels: await normalizeChannelList(stores, body.channels) }),
        ...(body.mailboxesPerHour !== undefined && { mailboxesPerHour: body.mailboxesPerHour }),
        ...(body.maxConcurrentRequests !== undefined && { maxConcurrentRequests: body.maxConcurrentRequests }),
      });
      if (!updated) throw new AppError("NOT_FOUND", `key 不存在: ${id}`);
      const settings = c.get("settings");
      return c.json({ key: presentApiKey(updated, settings.mailboxesPerKeyPerHour, settings.maxConcurrentRequestsPerKey) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/admin/keys/{id}/revoke",
      tags: ["admin"],
      summary: "吊销并删除 API key（立即失效，从列表移除）",
      request: { params: IdParams },
      responses: {
        204: { description: "已删除" },
        401: errResp("未登录"),
        404: errResp("不存在"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const row = await stores.apiKeys.get(id);
      if (!row) throw new AppError("NOT_FOUND", `key 不存在: ${id}`);
      await stores.apiKeys.delete(id);
      return c.body(null, 204);
    },
  );

  // ---------- 域名总览（key 域名编辑器的候选列表） ----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/domains",
      tags: ["admin"],
      summary: "全部域名（含停用状态与归属上游，供 key 域名白名单编辑）",
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ domains: z.array(AdminDomainEntry) }) } },
          description: "OK",
        },
        401: errResp("未登录"),
      },
    }),
    async (c) => {
      const rows = await stores.upstreams.listAllDomains();
      return c.json(
        {
          domains: rows
            .sort((a, b) => a.domain.localeCompare(b.domain))
            .map((r) => ({
              domain: r.domain,
              upstreamId: r.id,
              upstreamName: r.name,
              upstreamType: r.type,
              upstreamEnabled: r.enabled,
              isPrivate: r.isPrivate,
              enabled: r.domainEnabled,
            })),
        },
        200,
      );
    },
  );

  // ---------- 状态监控 ----------

  /** 状态监控时间线上展示的检查点数量 */
  const HEALTH_TIMELINE_POINTS = 50;

  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/health",
      tags: ["admin"],
      summary: "上游健康状态（存活时间线 + 域名变化），渠道自动纳入",
      responses: {
        200: { content: { "application/json": { schema: z.object({ channels: z.array(z.unknown()) }) } }, description: "OK" },
        401: errResp("未登录"),
      },
    }),
    async (c) => {
      const rows = await stores.upstreams.list();
      const channels = await Promise.all(
        rows.map(async (row) => {
          // 只查一次：时间线投影与域名变化/最近异常都从同一份数据派生
          const rawChecks = await stores.health.listByUpstream(row.id, HEALTH_TIMELINE_POINTS);
          const checks = rawChecks.map((chk) => ({
            checkedAt: chk.checkedAt.toISOString(),
            status: chk.status,
            latencyMs: chk.latencyMs,
          }));
          const latest = checks[0] ?? null;
          // 时间线按时间升序渲染（旧 → 新），不足处由前端补空槽
          const timeline = [...checks].reverse();
          const upCount = checks.filter((chk) => chk.status === "up").length;
          // 域名变化：从检查历史里找最近一条带增删差异的记录
          const change = rawChecks.find((chk) => (chk.domainsAdded?.length ?? 0) > 0 || (chk.domainsRemoved?.length ?? 0) > 0);
          // 最近一次成功探测决定同步状态；后续网络失败不改变已经确认的结果。
          const lastSuccessful = rawChecks.find((chk) => chk.status === "up");
          const blocked = lastSuccessful?.syncAction?.startsWith("blocked:") ? lastSuccessful : null;
          const lastDown = rawChecks.find((chk) => chk.status === "down");
          const monitorSettings = row.settingsJson as { monitorIntervalMs?: unknown; monitorDisabled?: unknown };
          return {
            id: row.id,
            name: row.name,
            type: row.type,
            enabled: row.enabled,
            status: latest?.status ?? ("unknown" as const),
            lastCheckedAt: latest?.checkedAt ?? null,
            latencyMs: latest?.latencyMs ?? null,
            domainCount: await stores.upstreams.countDomains(row.id),
            // 存活率：时间窗口内 up 的比例（不统计请求数，只看存活）
            uptimePct: checks.length > 0 ? Math.round((upCount / checks.length) * 1000) / 10 : null,
            monitorIntervalMs: Number(monitorSettings.monitorIntervalMs) > 0 ? Number(monitorSettings.monitorIntervalMs) : null,
            monitorDisabled: monitorSettings.monitorDisabled === true,
            effectiveIntervalMs: c.get("settings").healthCheckEnabled ? effectiveMonitorIntervalMs(row.settingsJson, c.get("settings").healthCheckIntervalMs) : null,
            autoSyncDomains: autoSyncDomainsEnabled(row.settingsJson),
            domainChange:
              change
                ? {
                    checkedAt: change.checkedAt.toISOString(),
                    added: change.domainsAdded ?? [],
                    removed: change.domainsRemoved ?? [],
                    syncAction: change.syncAction,
                  }
                : null,
            pendingSync:
              blocked
                ? {
                    checkedAt: blocked.checkedAt.toISOString(),
                    reason: blocked.syncAction!.slice("blocked:".length),
                    added: blocked.domainsAdded ?? [],
                    removed: blocked.domainsRemoved ?? [],
                  }
                : null,
            lastError: lastDown?.error ?? null,
            timeline,
          };
        }),
      );
      return c.json({ channels }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/admin/health/check",
      tags: ["admin"],
      summary: "立即执行一轮上游健康检查（存活探测 + 域名变化）",
      responses: {
        200: { content: { "application/json": { schema: z.object({ results: z.array(z.unknown()) }) } }, description: "OK" },
        401: errResp("未登录"),
      },
    }),
    async (c) => {
      const results = await runHealthChecks({ upstreams: stores.upstreams, health: stores.health, registry, crypto });
      return c.json({ results }, 200);
    },
  );

  // ---------- 邮箱概览（只读） ----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/mailboxes",
      tags: ["admin"],
      summary: "邮箱概览（只读列表）",
      request: {
        query: z.object({
          upstreamId: z.string().optional(),
          limit: z.coerce.number().int().positive().max(200).optional(),
          offset: z.coerce.number().int().nonnegative().optional(),
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
        401: errResp("未登录"),
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const rows = await stores.mailboxes.list({
        limit: q.limit ?? 50,
        offset: q.offset ?? 0,
        upstreamId: q.upstreamId,
      });
      // 总数与列表用同一套过滤条件，否则按渠道筛选时 total 是全库数、页码算错
      return c.json({ total: await stores.mailboxes.count({ upstreamId: q.upstreamId }), mailboxes: rows.map(presentMailbox) }, 200);
    },
  );

  // ---------- 清理已过期邮箱记录 ----------
  app.openapi(
    createRoute({
      method: "post",
      path: "/admin/mailboxes/prune-expired",
      tags: ["admin"],
      summary: "清理已过期的邮箱记录（只删网关侧，不触碰上游）",
      description:
        "上游到期后自行回收邮箱，但网关侧记录不会自动消失（expiresAt 此前只是存着没人用）。" +
        "本操作删除 expiresAt 已早于当前时间的记录，不向上游发任何请求——为一批早已不存在的" +
        "邮箱逐个调用上游删除只会白等超时。无到期时间的记录不受影响。",
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ deleted: z.number().int() }) } },
          description: "OK",
        },
        401: errResp("未登录"),
      },
    }),
    async (c) => {
      const deleted = await stores.mailboxes.deleteExpired(new Date());
      return c.json({ deleted }, 200);
    },
  );

  // ---------- 纳管上游已存在的地址 ----------
  app.openapi(
    createRoute({
      method: "post",
      path: "/admin/mailboxes/import",
      tags: ["admin"],
      summary: "把上游已存在的邮箱地址补登记进网关注册表",
      description:
        "用于客户端从「直连上游」切到「走网关」时找回存量邮箱：这些邮箱上游有、网关注册表没有，" +
        "统一 API 因此读不到它们。逐个地址按域名解析归属渠道，再调适配器反查上游确认存在后登记。\n\n" +
        "刻意只放在管理端而非 /v1：cf-temp-email 用的是实例级 admin token，网关拿它能读该实例上" +
        "任意地址；若开成 key 自助纳管，等于把「读任意已存在地址」的权限发给每把 key。\n\n" +
        "依赖每邮箱独立凭证的上游（DuckMail）无法纳管——密码是建箱时随机生成的，事后换不回 token。",
      request: {
        body: { content: { "application/json": { schema: ImportMailboxesBody } }, required: true },
      },
      responses: {
        200: {
          content: { "application/json": { schema: ImportMailboxesResult } },
          description: "逐地址结果（部分失败不影响其余地址）",
        },
        400: errResp("参数不合法"),
        401: errResp("未登录"),
        404: errResp("指定的归属 key 不存在"),
      },
    }),
    async (c) => {
      const body = c.req.valid("json");

      // 归属 key：缺省登记为共享邮箱（apiKeyId=null，任何 key 可读、但不出现在列表里）
      let apiKeyId: string | null = null;
      if (body.apiKeyId) {
        const key = await stores.apiKeys.get(body.apiKeyId);
        if (!key) throw new AppError("NOT_FOUND", `API key 不存在: ${body.apiKeyId}`);
        apiKeyId = key.id;
      }

      const imported: { address: string; id: string; upstreamId: string }[] = [];
      const failed: { address: string; code: string; message: string }[] = [];

      for (const raw of body.addresses) {
        const address = raw.trim().toLowerCase();
        const domain = address.split("@")[1];
        try {
          if (!domain) throw new AppError("VALIDATION_ERROR", `地址格式不正确: ${raw}`);

          const existing = await stores.mailboxes.findByAddress(address);
          if (existing) throw new AppError("CONFLICT", "该地址已在网关注册表中");

          // 不带 key 白名单过滤：管理员纳管不受某把 key 的可用范围限制
          const upstream = await resolveUpstreamByDomain(stores.upstreams, domain, {});
          const adapter = registry.has(upstream.type) ? registry.get(upstream.type) : null;
          if (!adapter) throw new AppError("ADAPTER_MISSING", `上游类型 ${upstream.type} 未接入网关`);
          if (typeof adapter.resolveByAddress !== "function") {
            throw new AppError(
              "CAPABILITY_MISSING",
              `上游类型 ${upstream.type} 不支持地址纳管（该上游的邮箱操作依赖每邮箱独立凭证，事后无法重建）`,
            );
          }

          const cfg = await upstreamConfigOf(upstream, crypto);
          const ref = await adapter.resolveByAddress(cfg, address);
          const row = await stores.mailboxes.create({
            id: newId(),
            upstreamId: upstream.id,
            address: ref.address.toLowerCase(),
            localPart: ref.address.split("@")[0]!.toLowerCase(),
            domain,
            upstreamMailboxId: ref.upstreamMailboxId,
            credentialsEnc: ref.credentials ? await crypto.encrypt(ref.credentials) : null,
            passwordEnc: ref.password ? await crypto.encrypt(ref.password) : null,
            apiKeyId,
            expiresAt: ref.expiresAt ?? null,
          });
          imported.push({ address: row.address, id: row.id, upstreamId: row.upstreamId });
        } catch (err) {
          failed.push({ address, ...describeImportFailure(err) });
        }
      }

      return c.json({ imported, failed }, 200);
    },
  );

  // ---------- 尽力删除的残留（孤儿）----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/orphan-mailboxes",
      tags: ["admin"],
      summary: "尽力删除留下的残留（网关记录已删、上游可能仍保留）",
      description:
        "`DELETE /v1/mailboxes/{id}?force=1` 在上游删除失败时仍会移除网关记录，" +
        "这类残留会记在此处供人工清理——否则该事实只出现在一次性的 HTTP 响应里，" +
        "管理员事后无从得知上游还欠一次清理。清理完成后可逐条或全部消账。",
      request: { query: z.object({ limit: z.coerce.number().int().positive().max(200).optional() }) },
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ orphans: z.array(OrphanEntry) }) } },
          description: "OK",
        },
        401: errResp("未登录"),
      },
    }),
    async (c) => {
      const { limit } = c.req.valid("query");
      const rows = await stores.orphans.list(limit ?? 50);
      return c.json({ orphans: rows.map(presentOrphan) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/admin/orphan-mailboxes/{id}",
      tags: ["admin"],
      summary: "消账单条残留记录（不触碰上游）",
      request: { params: IdParams },
      responses: {
        204: { description: "已消账" },
        401: errResp("未登录"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      await stores.orphans.delete(id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/admin/orphan-mailboxes",
      tags: ["admin"],
      summary: "清空全部残留记录（不触碰上游）",
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ deleted: z.number().int() }) } },
          description: "OK",
        },
        401: errResp("未登录"),
      },
    }),
    async (c) => {
      const deleted = await stores.orphans.clear();
      return c.json({ deleted }, 200);
    },
  );

  // ---------- helpers ----------

  /**
   * 把纳管过程中的异常压成 {code, message}。
   * 逐地址收集而不是整批抛出：一个地址写错不该让其余 199 个白跑一遍上游查询。
   */
  function describeImportFailure(err: unknown): { code: string; message: string } {
    if (err instanceof AppError) return { code: err.code, message: err.message };
    if (err instanceof UpstreamError) return { code: `UPSTREAM_${err.code}`, message: err.message };
    return { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err) };
  }

  async function upstreamDetail(stores: AdminDeps["stores"], id: string) {
    const row = await stores.upstreams.get(id);
    if (!row) throw new AppError("NOT_FOUND", `上游不存在: ${id}`);
    const domainRows = await stores.upstreams.listDomainsByUpstream(id);
    const summary = presentUpstreamSummary(row, domainRows.length);
    return {
      ...summary,
      settings: row.settingsJson,
      domains: domainRows.map((d) => ({
        domain: d.domain,
        isPrivate: d.isPrivate,
        enabled: d.enabled,
        syncedAt: d.syncedAt.toISOString(),
      })),
    };
  }

  async function syncDomains(
    registry: AdminDeps["registry"],
    stores: AdminDeps["stores"],
    crypto: AdminDeps["crypto"],
    upstreamId: string,
  ) {
    const row = await stores.upstreams.get(upstreamId);
    if (!row) throw new AppError("NOT_FOUND", `上游不存在: ${upstreamId}`);
    if (!registry.has(row.type)) {
      throw new AppError("ADAPTER_MISSING", `适配器类型未注册: ${row.type}`);
    }
    const adapter = registry.get(row.type);
    const cfg = await upstreamConfigOf(row, crypto);
    const fetched = await adapter.listDomains(cfg);
    const newDomains = [...new Set(fetched.map((d) => d.domain.toLowerCase()))];
    // 旧集合用"全量域名"（含停用的），否则停用域名会被误判为新增/漏报移除
    const old = await stores.upstreams.listDomainsByUpstream(row.id);

    const added = newDomains.filter((d) => !old.some((o) => o.domain === d));
    const removed = old.map((o) => o.domain).filter((d) => !newDomains.includes(d));

    await stores.upstreams.replaceDomains(
      row.id,
      newDomains.map((domain) => ({
        domain,
        upstreamId: row.id,
        isPrivate: fetched.find((f) => f.domain === domain)?.isPrivate ?? false,
        // 新域名默认启用；replaceDomains 内部会对已存在域名保留此前的开关状态
        enabled: true,
        syncedAt: new Date(),
      })),
    );
    return { added, removed, total: newDomains.length };
  }
}

/**
 * 登录限流的来源标识。注意：不设代理头（CF-Connecting-IP / X-Real-IP /
 * X-Forwarded-For）的裸部署只能共用 "local" 一个桶——挡得住爆破，但会误伤并发登录，
 * 生产环境应置于会注入真实客户端 IP 的反代之后。
 */
function clientKeyOf(c: Context<Env>): string {
  const cf = c.req.header("CF-Connecting-IP")?.trim();
  if (cf) return `cfip:${cf}`;
  const real = c.req.header("X-Real-IP")?.trim();
  if (real) return `rip:${real}`;
  const xff = c.req.header("X-Forwarded-For")?.trim();
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return `xff:${first}`;
  }
  return "local";
}

/**
 * key 域名白名单归一：trim/小写/去重；
 * undefined = 保持不变（PATCH）；null/空数组 = 不限制（空名单视为不限制，避免误配出不可用的 key）。
 */
function normalizeDomainList(input: string[] | null | undefined): string[] | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const cleaned = [...new Set(input.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0))];
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * key 渠道白名单归一：undefined = 保持不变（PATCH）；null/空数组 = 不限渠道。
 * 渠道必须是已存在的上游实例 id，未知 id 直接拒绝，避免配置静默失效。
 */
async function normalizeChannelList(
  stores: AdminDeps["stores"],
  input: string[] | null | undefined,
): Promise<string[] | null | undefined> {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const cleaned = [...new Set(input.map((c) => c.trim()).filter((c) => c.length > 0))];
  if (cleaned.length === 0) return null;
  const known = new Set((await stores.upstreams.list()).map((u) => u.id));
  const unknown = cleaned.filter((c) => !known.has(c));
  if (unknown.length > 0) {
    throw new AppError("VALIDATION_ERROR", `未知的渠道（上游实例）id: ${unknown.join(", ")}`);
  }
  return cleaned;
}
