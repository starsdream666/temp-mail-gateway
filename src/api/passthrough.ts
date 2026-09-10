import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Env } from "./env";
import type { GatewayStores } from "./v1";
import { requirePassthroughKey } from "./middleware/auth";
import type { AdminAuthConfig } from "./middleware/auth";
import { upstreamConfigOf } from "./v1";
import type { AdapterRegistry } from "../adapters/registry";
import type { CryptoPort } from "../ports/crypto";
import type { UpstreamRow, UpstreamWithDomain } from "../ports/stores";
import { AppError } from "../core/errors";
import { newId } from "../core/ids";
import { limitKeyConcurrency, type ConcurrencyLimiter } from "../core/concurrency";

export interface PassthroughDeps {
  stores: GatewayStores;
  registry: AdapterRegistry;
  crypto: CryptoPort;
  /** 管理员会话配置：透传额外接受有效的管理会话 cookie 作为身份 */
  admin: AdminAuthConfig;
  concurrencyLimiter: ConcurrencyLimiter;
  /** 出网 fetch；生产用全局 fetch，测试注入模拟实现 */
  fetchFn?: typeof fetch;
}

/** 逐跳头与不应透传给上游的头 */
const BLOCKED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-authorization",
  "content-length",
  // 网关侧凭证不外泄；上游鉴权头一律由网关注入，客户端伪造无效
  "authorization",
  "cookie",
  "x-api-key",
  "x-admin-auth",
  "x-gateway-key",
]);

const BLOCKED_RESPONSE_HEADERS = new Set([
  "content-length", // fetch 已自动解压，长度可能失配
  "content-encoding",
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

const EMAIL_IN_PARAM = /^[A-Za-z0-9._-]+@([A-Za-z0-9-]+\.[A-Za-z0-9.-]+)$/;

/**
 * 原生格式透传（DESIGN 7.3）。两种寻址方式：
 *
 * 1. /upstream/{上游ID}/**  —— 精确转发到单个上游实例（原有行为）。
 * 2. /upstream/{适配器类型}/** —— 按类型寻址：
 *    - 该类型只有一个启用实例 → 整段直接转发；
 *    - 多实例并存时按"域名"路由：body 的 domain/address 字段，或 query 里形如邮箱的
 *      address/query 参数（如 cloudflare_temp_email 的 ?address=/?query=），
 *      只有登记在该类型某实例名下的域名才会被路由；
 *    - 无域名可解析时：GET 合并所有实例的响应（数组字段拼接）；DELETE 通过
 *      邮箱注册表确定唯一归属，归属不明返回 400 UPSTREAM_REQUIRED，禁止扇出；
 *    - POST/PUT/PATCH 无域名 → 400 DOMAIN_REQUIRED（避免一次请求在多个上游
 *      重复建邮箱这类破坏性副作用）。
 *
 * 通用规则：鉴权沿用网关 API key；上游凭证由适配器 authHeaders 声明并由网关
 * 注入（客户端伪造无效）；方法/query/body/响应状态原样转发，不做错误信封改写；
 * 类型级响应带 X-Gateway-Upstream-Id(s) 头标明实际服务的实例。
 * 域名管控：写请求（POST/PUT/PATCH）携带可解析域名时同样受「域名调用开关 +
 * key 域名白名单」约束（与统一 API 一致）；GET/DELETE 读信清理不受限。
 * 列表过滤：GET 命中"枚举型"端点（列出邮箱/域名，适配器通过 filterPassthroughList
 * 声明）时，按调用方可用域名过滤响应条目——原生客户端"看到的邮箱"与"能创建的
 * 域名"保持一致。
 * 经透传创建/删除的邮箱由 inspectPassthrough 自动登记/注销到网关注册表。
 */
export function registerPassthroughRoutes(app: OpenAPIHono<Env>, deps: PassthroughDeps): void {
  const fetchFn = deps.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  app.use("/upstream/*", requirePassthroughKey(deps.stores.apiKeys, deps.admin));
  app.use("/upstream/*", limitKeyConcurrency(deps.concurrencyLimiter));

  async function handler(c: Context<Env>): Promise<Response> {
    const typeOrId = c.req.param("typeOrId");
    if (!typeOrId) throw new AppError("NOT_FOUND", "缺少上游 ID 或适配器类型");
    const subPath = (c.req.path.startsWith(`/upstream/${typeOrId}`)
      ? c.req.path.slice(`/upstream/${typeOrId}`.length) || "/"
      : "/"
    ).replace(/^\/{2,}/, "/"); // 兼容 baseURL 配置带尾斜杠导致的 // 前缀

    // 请求体只读一次，供域名提取与转发共用
    const method = c.req.method.toUpperCase();
    const bodyBuf = method !== "GET" && method !== "HEAD" ? await c.req.raw.arrayBuffer() : undefined;

    // 域名管控：写请求（POST/PUT/PATCH）携带可解析域名时，与统一 API 同一套规则——
    // 域名停用 → 403 DOMAIN_DISABLED；key 白名单外 → 403 DOMAIN_NOT_ALLOWED。
    // 渠道白名单在解析出目标实例后校验（CHANNEL_NOT_ALLOWED）。
    // GET/DELETE（读信/清理）不受限；管理员会话身份 domains/channels 为 null 视为不受限。
    const domain = extractDomain(c, bodyBuf); // 类型路由的读信/清理也按域名定向
    // S-04：写请求的候选行只查一次，预检与类型路由共用；GET/DELETE 惰性——只有
    // 多实例类型路由需要候选时才查（extractDomain 对它们只是取个可能用不上的值）。
    let candidates: UpstreamWithDomain[] | null = null;
    if (isWriteMethod(method) && domain) {
      candidates = await deps.stores.upstreams.listUpstreamsByDomain(domain);
    }
    if (isWriteMethod(method)) {
      await assertDomainAllowed(c, deps, domain, candidates);
    }

    // 1) 精确上游 ID（ULID 大小写不敏感）
    const byId = (await deps.stores.upstreams.get(typeOrId)) ?? (await deps.stores.upstreams.get(typeOrId.toUpperCase()));
    if (byId) {
      assertForwardable(byId, deps.registry);
      if (isWriteMethod(method)) {
        assertChannelAllowed(c, byId.id);
        await assertTargetDomainEnabled(deps, byId.id, domain);
      }
      return forwardSingle(c, deps, fetchFn, byId, subPath, bodyBuf, {});
    }

    // 2) 适配器类型
    const type = typeOrId.toLowerCase();
    if (deps.registry.has(type)) {
      const enabledOfType = (await deps.stores.upstreams.list()).filter((u) => u.type === type && u.enabled);
      if (enabledOfType.length === 0) {
        throw new AppError("NOT_FOUND", `适配器类型 ${type} 下没有启用的上游`);
      }
      // 类型寻址 = 让网关替调用方选实例 → 候选先按 key 渠道白名单收窄（读写都收）
      const instances = narrowToAllowedChannels(c, enabledOfType);
      if (instances.length === 0) {
        throw new AppError(
          "CHANNEL_NOT_ALLOWED",
          `当前 key 无权使用 ${type} 类型下的任何渠道，请联系管理员调整该 key 的渠道白名单（或改用 /upstream/{上游ID} 指定具体实例）`,
        );
      }
      if (instances.length === 1) {
        const only = instances[0]!;
        assertForwardable(only, deps.registry);
        if (isWriteMethod(method)) {
          assertChannelAllowed(c, only.id);
          await assertTargetDomainEnabled(deps, only.id, domain);
        }
        return forwardSingle(c, deps, fetchFn, only, subPath, bodyBuf, {
          "X-Gateway-Upstream-Id": only.id,
        });
      }
      // 多实例类型路由：需要候选行（写请求已查过直接传；读请求到此才查）
      if (!candidates && domain) {
        candidates = await deps.stores.upstreams.listUpstreamsByDomain(domain);
      }
      return handleTypeRouting(c, deps, fetchFn, type, instances, subPath, bodyBuf, candidates ?? []);
    }

    throw new AppError("NOT_FOUND", `未知上游 ID 或适配器类型: ${typeOrId}`);
  }

  app.all("/upstream/:typeOrId/*", (c) => handler(c));
  // 无尾斜杠的裸前缀 /upstream/{id|type} 视为访问上游根路径
  app.all("/upstream/:typeOrId", (c) => handler(c));
}

// ---------- 转发实现 ----------

function assertForwardable(row: UpstreamRow, registry: AdapterRegistry): void {
  if (!row.enabled) throw new AppError("FORBIDDEN", "该上游已停用");
  if (row.settingsJson.passthroughEnabled === false) {
    throw new AppError("FORBIDDEN", "该上游未启用原生格式透传（settings.passthroughEnabled）");
  }
  if (!registry.has(row.type)) {
    throw new AppError("ADAPTER_MISSING", `上游类型 ${row.type} 未接入网关`);
  }
  if (typeof registry.get(row.type).authHeaders !== "function") {
    throw new AppError("CAPABILITY_MISSING", `上游类型 ${row.type} 不支持原生格式透传`);
  }
}

/**
 * 透传写请求的域名管控（与统一 API POST /v1/mailboxes 语义一致）：
 *   1. 域名登记过但所有登记渠道的上游实例都停用 → DOMAIN_NOT_ROUTED（S-02：
 *      上游停用与域名停用分开归因，别让管理员去域名页找一个并不存在的开关）；
 *   2. 有启用上游但域名行全部停用 → 403 DOMAIN_DISABLED（先于白名单）；
 *      只要任一启用渠道仍启用该域名就放行——逐渠道停用状态由目标解析后的
 *      assertTargetDomainEnabled / assertChannelAllowed 兜底（复合主键下
 *      各渠道开关独立，主归属行的状态不能代表其他渠道）；
 *   3. key 配置了域名白名单且域名不在名单内 → 403 DOMAIN_NOT_ALLOWED。
 * 域名无法解析（body/query 均未携带）或不在注册表（上游新域名未同步）时不拦，
 * 保持透传"原样代理"的语义；GET/DELETE 不调用本函数。
 * candidates 由调用方查好传入（S-04），null 表示调用方未查（本函数按需查）。
 */
async function assertDomainAllowed(
  c: Context<Env>,
  deps: PassthroughDeps,
  domain: string | null,
  candidatesArg?: UpstreamWithDomain[] | null,
): Promise<void> {
  if (!domain) return;

  const candidates =
    candidatesArg ?? (await deps.stores.upstreams.listUpstreamsByDomain(domain));
  if (candidates.length === 0) return; // 未登记：不拦（保持原样代理）
  if (!candidates.some((r) => r.enabled)) {
    throw new AppError("DOMAIN_NOT_ROUTED", `没有启用的上游拥有域名 ${domain}`);
  }
  if (!candidates.some((r) => r.enabled && r.domainEnabled)) {
    throw new AppError("DOMAIN_DISABLED", `域名 ${domain} 已在管理端停用`);
  }

  const allowed = c.get("apiKey").domains;
  if (allowed && allowed.length > 0 && !allowed.includes(domain)) {
    throw new AppError(
      "DOMAIN_NOT_ALLOWED",
      `当前 key 无权使用域名 ${domain}（请联系管理员调整该 key 的域名白名单）`,
    );
  }
}

/**
 * 目标实例自身的域名停用状态。复合主键下同一域名可登记在多个渠道、停用开关逐渠道独立：
 * 按 ID / 单实例类型透传到「非主归属」渠道时，主实例的 enabled 不能代表本实例，
 * 必须查该实例自己的域名行（域名未在该实例登记时不拦，保持原样代理语义）。
 */
async function assertTargetDomainEnabled(
  deps: PassthroughDeps,
  upstreamId: string,
  domain: string | null,
): Promise<void> {
  if (!domain) return;
  const row = await deps.stores.upstreams.getDomain(upstreamId, domain);
  if (row && !row.enabled) {
    throw new AppError("DOMAIN_DISABLED", `域名 ${domain} 已在管理端停用`);
  }
}

/** key 渠道白名单：配置了名单时，写请求只能命中名单内的上游实例（目标已解析后调用） */
function assertChannelAllowed(c: Context<Env>, targetUpstreamId: string): void {
  const channels = c.get("apiKey").channels;
  if (channels && channels.length > 0 && !channels.includes(targetUpstreamId)) {
    throw new AppError(
      "CHANNEL_NOT_ALLOWED",
      `当前 key 无权使用该渠道（上游实例 ${targetUpstreamId}），请联系管理员调整该 key 的渠道白名单`,
    );
  }
}

/**
 * 类型寻址的候选收窄：配置了渠道白名单的 key，只允许网关在名单内的实例里选目标。
 * 为什么读请求也要收窄（与 assertChannelAllowed 只管写请求不同）：不带域名的 GET 会
 * 扇出到该类型全部实例并合并响应体，同一上游软件的两个账户（例如"日常"与"批量注册"
 * 两把上游 key）注册成两个渠道时，合并结果会把另一个账户的邮箱列表泄漏给调用方；
 * filterPassthroughList 按域名过滤救不了这种情况——两个账户共享同一套域名。
 * 带域名的 GET 同理会选中"最早创建"而非名单内的实例，读到错误账户。
 * 按 ID 显式寻址不走这里：那是调用方明确指定目标，读信/清理存量邮箱不该被名单变化打断。
 */
function narrowToAllowedChannels<T extends { id: string }>(c: Context<Env>, rows: T[]): T[] {
  const channels = c.get("apiKey").channels;
  if (!channels || channels.length === 0) return rows;
  return rows.filter((r) => channels.includes(r.id));
}

function isWriteMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH";
}

/**
 * 多实例类型路由：域名 → 定向；DELETE 必须确定唯一归属；无域名 GET 合并。
 * S-01：按方法分档——写请求的域名定向要求「域名启用」（域名开关只约束建箱）；
 * GET/DELETE 的读信/清理只要求「上游实例启用」，域名停用不参与路由，
 * 否则管理员停用某域名后存量邮箱立即收不到信（且仅多实例类型寻址发作）。
 * candidates 由 handler 查好传入（写请求）；读请求到此才按需查（S-04）。
 */
async function handleTypeRouting(
  c: Context<Env>,
  deps: PassthroughDeps,
  fetchFn: typeof fetch,
  type: string,
  instances: UpstreamRow[],
  subPath: string,
  bodyBuf: ArrayBuffer | undefined,
  candidatesArg?: UpstreamWithDomain[] | null,
): Promise<Response> {
  const method = c.req.method.toUpperCase();
  const domain = extractDomain(c, bodyBuf);
  const forwardable = instances.filter((r) => r.settingsJson.passthroughEnabled !== false);
  if (forwardable.length === 0) {
    throw new AppError("FORBIDDEN", `该类型下可用渠道均未启用原生格式透传`);
  }

  if (method === "DELETE") {
    const owner = await registeredDeleteOwner(c, deps, type, instances, subPath);
    if (owner) {
      return forwardSingle(c, deps, fetchFn, owner, subPath, bodyBuf, { "X-Gateway-Upstream-Id": owner.id });
    }
  }

  if (domain) {
    // R-03：类型寻址的域名路由要在「该类型自己的登记行」里选主——全局主归属可能
    // 是更早创建的其他类型渠道，拿它比 type 会误拒本类型合法拥有的共享域名。
    const allCandidates =
      candidatesArg ?? (await deps.stores.upstreams.listUpstreamsByDomain(domain));
    const typeRowsAll = allCandidates.filter((r) => r.type === type);
    if (typeRowsAll.length === 0) {
      throw new AppError("DOMAIN_NOT_ROUTED", `域名 ${domain} 不归属于任何启用的 ${type} 上游`);
    }
    // G5：域名定向也只在 key 渠道白名单内选主，否则会选中「最早创建」的名单外实例
    const typeRows = narrowToAllowedChannels(c, typeRowsAll);
    if (typeRows.length === 0) {
      throw new AppError(
        "CHANNEL_NOT_ALLOWED",
        `域名 ${domain} 在 ${type} 类型下只登记于该 key 渠道白名单外的实例，请联系管理员调整白名单（或改用 /upstream/{上游ID}）`,
      );
    }
    // S-01：读信/清理不要求域名启用；写请求要求「启用实例 × 域名启用」
    const enabledRows = typeRows.filter((r) => r.enabled);
    if (enabledRows.length === 0) {
      throw new AppError("DOMAIN_NOT_ROUTED", `域名 ${domain} 不归属于任何启用的 ${type} 上游`);
    }
    // DELETE 的归属不能因透传开关变化而切换到另一个同域名实例。
    if (method === "DELETE" && enabledRows.length !== 1) throw upstreamRequired(type);
    let usable = enabledRows.filter((r) => r.settingsJson.passthroughEnabled !== false);
    if (usable.length === 0) {
      throw new AppError("FORBIDDEN", `域名 ${domain} 的渠道未启用原生格式透传`);
    }
    if (isWriteMethod(method)) {
      usable = usable.filter((r) => r.domainEnabled);
      if (usable.length === 0) {
        // 有启用的类型实例但域名全停 → 域名开关拦（S-02 语义：与上游停用分开归因）
        throw new AppError("DOMAIN_DISABLED", `域名 ${domain} 已在管理端停用`);
      }
    }
    const owner = usable[0]!;
    if (isWriteMethod(method)) {
      assertChannelAllowed(c, owner.id);
      await assertTargetDomainEnabled(deps, owner.id, domain);
    }
    return forwardSingle(c, deps, fetchFn, owner, subPath, bodyBuf, {
      "X-Gateway-Upstream-Id": owner.id,
    });
  }

  if (method === "GET" || method === "HEAD") {
    return fanOutGet(c, deps, fetchFn, forwardable, subPath);
  }
  if (method === "DELETE") {
    throw upstreamRequired(type);
  }
  throw new AppError(
    "DOMAIN_REQUIRED",
    `多个 ${type} 上游并存时，${method} 请求必须携带可解析的域名（body 的 domain 字段，或 query 中形如邮箱的 address/query 参数），或改用 /upstream/{上游ID}`,
  );
}

function upstreamRequired(type: string): AppError {
  return new AppError("UPSTREAM_REQUIRED", `无法确定 DELETE 请求在 ${type} 下的唯一归属，请改用 /upstream/{上游ID}`);
}

async function registeredDeleteOwner(
  c: Context<Env>,
  deps: PassthroughDeps,
  type: string,
  instances: UpstreamRow[],
  subPath: string,
): Promise<UpstreamRow | null> {
  let mailboxId: string | null;
  try {
    mailboxId = deps.registry.get(type).passthroughMailboxId?.(subPath) ?? null;
  } catch {
    throw new AppError("VALIDATION_ERROR", "邮箱路径编码无效");
  }
  const address = queryAddress(c);
  if (address) {
    const mailbox = await deps.stores.mailboxes.findByAddress(address);
    if (mailbox) {
      const owner = instances.find((r) => r.id === mailbox.upstreamId);
      if (!owner || (mailboxId && mailbox.upstreamMailboxId !== mailboxId)) throw upstreamRequired(type);
      return owner;
    }
  }
  if (!mailboxId) return null;
  const matches = await Promise.all(instances.map(async (row) => ({
    row,
    mailbox: await deps.stores.mailboxes.findByUpstreamMailboxId(row.id, mailboxId),
  })));
  const owners = matches.filter((m) => m.mailbox);
  if (owners.length > 1) throw upstreamRequired(type);
  if (owners.length === 1) {
    const match = owners[0]!;
    if (address && match.mailbox!.address !== address) throw upstreamRequired(type);
    return match.row;
  }
  return null;
}

function queryAddress(c: Context<Env>): string | null {
  const search = new URL(c.req.raw.url).searchParams;
  for (const name of ["address", "query"]) {
    const value = search.get(name)?.trim();
    if (value && EMAIL_IN_PARAM.test(value)) return value.toLowerCase();
  }
  return null;
}

/** 同时携带 domain/address 时必须一致，避免额外字段掩盖上游实际使用的域名。 */
function extractDomain(c: Context<Env>, bodyBuf: ArrayBuffer | undefined): string | null {
  if (bodyBuf && bodyBuf.byteLength > 0 && bodyBuf.byteLength <= 1_000_000) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBuf));
    } catch {
      // 非 JSON body，忽略
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const fields = parsed as Record<string, unknown>;
      const domain = typeof fields.domain === "string" ? fields.domain.trim().toLowerCase() : "";
      const address = typeof fields.address === "string" ? fields.address.trim() : "";
      const at = address.lastIndexOf("@");
      const addressDomain = at > 0 ? address.slice(at + 1).toLowerCase() : "";
      if (domain && addressDomain && domain !== addressDomain) {
        throw new AppError("VALIDATION_ERROR", "domain 与 address 中的域名不一致");
      }
      if (addressDomain || domain) return addressDomain || domain;
    }
  }
  const address = queryAddress(c);
  return address ? address.slice(address.lastIndexOf("@") + 1) : null;
}

/** 单实例整段转发；extraHeaders 附加到响应 */
async function forwardSingle(
  c: Context<Env>,
  deps: PassthroughDeps,
  fetchFn: typeof fetch,
  row: UpstreamRow,
  subPath: string,
  bodyBuf: ArrayBuffer | undefined,
  extraHeaders: Record<string, string>,
): Promise<Response> {
  const res = await forwardRaw(c, deps, fetchFn, row, subPath, bodyBuf);
  const headers = filterResponseHeaders(res);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);

  const method = c.req.method.toUpperCase();
  const isJson2xx =
    res.status >= 200 && res.status < 300 && (res.headers.get("content-type") ?? "").includes("application/json");

  // 透传邮箱列表过滤：GET 命中"列出邮箱"端点时，按调用方可用域名过滤响应条目，
  // 让原生客户端"看到的邮箱"与"能创建的域名"一致（如 floatmail 的 MoeMail 渠道列表）。
  if (method === "GET" && isJson2xx) {
    const bodyText = await maybeFilterListBody(c, deps, row, subPath, res);
    if (bodyText !== null) {
      return new Response(bodyText, { status: res.status, statusText: res.statusText, headers });
    }
  }

  // 透传副作用观察：原生客户端创建/删除邮箱时自动登记/注销到网关注册表（管理端可见可管理）。
  // DELETE 204 没有 JSON 响应体，但仍需要注销；观察失败不影响透传本身。
  const shouldObserve = ((method === "POST" || method === "DELETE") && isJson2xx) ||
    (method === "DELETE" && res.status === 204);
  if (shouldObserve && bodyBufOrEmpty(bodyBuf) <= 1_000_000) {
    let responseBodyText = "";
    try {
      responseBodyText = await res.text();
      await recordPassthroughObservation(deps, row, {
        method,
        path: subPath,
        status: res.status,
        requestBodyText: bodyBuf ? new TextDecoder().decode(bodyBuf) : undefined,
        responseBodyText,
      });
    } catch {
      // 观察失败不阻断透传响应
    }
    return new Response(res.status === 204 ? null : responseBodyText, { status: res.status, statusText: res.statusText, headers });
  }

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * 邮箱列表过滤核心：响应是 2xx JSON 且适配器实现了列表过滤钩子时，
 * 读入响应体并按调用方可用域名过滤，返回最终响应体文本；
 * 不适用（非 JSON / 适配器无钩子）时返回 null，调用方继续流式转发原始 body。
 */
async function maybeFilterListBody(
  c: Context<Env>,
  deps: PassthroughDeps,
  row: UpstreamRow,
  subPath: string,
  res: Response,
): Promise<string | null> {
  const adapter = deps.registry.get(row.type);
  if (typeof adapter.filterPassthroughList !== "function") return null;

  const apiKey = c.get("apiKey");
  const activeRows = await deps.stores.upstreams.listActiveDomains();
  const byChannels =
    apiKey.channels && apiKey.channels.length > 0
      ? activeRows.filter((r) => apiKey.channels!.includes(r.id))
      : activeRows;
  const allowedDomains = new Set(
    (apiKey.domains && apiKey.domains.length > 0
      ? byChannels.filter((r) => apiKey.domains!.includes(r.domain))
      : byChannels
    ).map((r) => r.domain),
  );

  const responseBodyText = await res.text();
  return (
    adapter.filterPassthroughList({
      path: subPath,
      responseBodyText,
      isDomainAllowed: (domain: string) => allowedDomains.has(domain.toLowerCase()),
    }) ?? responseBodyText
  );
}

function bodyBufOrEmpty(buf: ArrayBuffer | undefined): number {
  return buf?.byteLength ?? 0;
}

/** 解析适配器观察结果并落库（登记创建 / 注销删除） */
async function recordPassthroughObservation(
  deps: PassthroughDeps,
  row: UpstreamRow,
  input: {
    method: string;
    path: string;
    status: number;
    requestBodyText?: string;
    responseBodyText?: string;
  },
): Promise<void> {
  const adapter = deps.registry.get(row.type);
  if (typeof adapter.inspectPassthrough !== "function") return;
  const observation = adapter.inspectPassthrough(input);
  if (!observation) return;

  if (observation.action === "created") {
    const address = observation.ref.address.trim().toLowerCase();
    if (!address.includes("@")) return;
    const existing = await deps.stores.mailboxes.findByAddress(address);
    if (existing) return; // 已登记（或经统一 API 创建），跳过
    const [localPart, domain] = address.split("@");
    await deps.stores.mailboxes.create({
      id: newId(),
      upstreamId: row.id,
      address,
      localPart: localPart!,
      domain: domain!,
      upstreamMailboxId: observation.ref.upstreamMailboxId,
      credentialsEnc: observation.ref.credentials ? await deps.crypto.encrypt(observation.ref.credentials) : null,
      passwordEnc: null,
      apiKeyId: null,
      expiresAt: observation.ref.expiresAt ?? null,
    });
    return;
  }

  const existing = await deps.stores.mailboxes.findByUpstreamMailboxId(row.id, observation.upstreamMailboxId);
  if (existing) await deps.stores.mailboxes.delete(existing.id);
}

async function forwardRaw(
  c: Context<Env>,
  deps: PassthroughDeps,
  fetchFn: typeof fetch,
  row: UpstreamRow,
  subPath: string,
  bodyBuf: ArrayBuffer | undefined,
): Promise<Response> {
  assertForwardable(row, deps.registry);
  const base = new URL(row.baseUrl);
  const incoming = new URL(c.req.raw.url);
  const target = new URL(base.toString());
  target.pathname = `${base.pathname.replace(/\/+$/, "")}${subPath || "/"}`;
  target.search = incoming.search;

  const headers = new Headers();
  c.req.raw.headers.forEach((value, key) => {
    if (!BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  const adapter = deps.registry.get(row.type);
  const cfg = await upstreamConfigOf(row, deps.crypto);
  for (const [key, value] of Object.entries(adapter.authHeaders!(cfg))) {
    headers.set(key, value);
  }

  const method = c.req.method.toUpperCase();
  try {
    return await fetchFn(target.toString(), {
      method,
      headers,
      body: method !== "GET" && method !== "HEAD" ? (bodyBuf ?? new ArrayBuffer(0)) : undefined,
      redirect: "manual",
    });
  } catch (cause) {
    throw new AppError("UPSTREAM_ERROR", `透传请求失败（${row.name}）：${(cause as Error)?.message ?? String(cause)}`);
  }
}

/** GET 扇出：并行请求全部实例（响应先按调用方可用域名过滤再合并）；多个成功则尝试 JSON 合并 */
async function fanOutGet(
  c: Context<Env>,
  deps: PassthroughDeps,
  fetchFn: typeof fetch,
  instances: UpstreamRow[],
  subPath: string,
): Promise<Response> {
  const results = await Promise.allSettled(
    instances.map(async (row) => {
      const res = await forwardRaw(c, deps, fetchFn, row, subPath, undefined);
      const isJson2xx =
        res.status >= 200 && res.status < 300 && (res.headers.get("content-type") ?? "").includes("application/json");
      const bodyText = isJson2xx ? await maybeFilterListBody(c, deps, row, subPath, res) : null;
      return {
        row,
        res:
          bodyText !== null
            ? new Response(bodyText, { status: res.status, statusText: res.statusText, headers: filterResponseHeaders(res) })
            : res,
      };
    }),
  );
  return collectFanOut(results);
}

type FanOutEntry = PromiseSettledResult<{ row: UpstreamRow; res: Response }>;

async function collectFanOut(
  results: FanOutEntry[],
): Promise<Response> {
  const successes: { row: UpstreamRow; res: Response }[] = [];
  const errors: string[] = [];
  let firstNon2xx: { row: UpstreamRow; res: Response } | null = null;

  for (const entry of results) {
    if (entry.status === "rejected") {
      errors.push((entry.reason as Error)?.message ?? String(entry.reason));
      continue;
    }
    const { row, res } = entry.value;
    if (res.status >= 200 && res.status < 300) {
      successes.push({ row, res });
    } else {
      if (!firstNon2xx) firstNon2xx = { row, res };
      errors.push(`${row.name} 返回 ${res.status}`);
    }
  }

  const partialHeader = (): Record<string, string> =>
    errors.length > 0 ? { "X-Gateway-Partial-Failure": encodeURIComponent(errors.join(" | ")) } : {};

  // 全部失败：优先原样返回一个非 2xx 上游响应，否则 502 信封
  if (successes.length === 0) {
    if (firstNon2xx) {
      return new Response(firstNon2xx.res.body, {
        status: firstNon2xx.res.status,
        headers: filterResponseHeaders(firstNon2xx.res),
      });
    }
    throw new AppError("UPSTREAM_ERROR", `所有上游请求失败：${errors.join("；") || "未知错误"}`);
  }

  // 单个成功：原样返回（补 X-Gateway-Upstream-Id）
  if (successes.length === 1) {
    const hit = successes[0]!;
    const headers = filterResponseHeaders(hit.res);
    headers.set("X-Gateway-Upstream-Id", hit.row.id);
    for (const [key, value] of Object.entries(partialHeader())) headers.set(key, value);
    return new Response(hit.res.body, {
      status: hit.res.status,
      headers,
    });
  }

  // 多个成功：尝试 JSON 合并（数组字段拼接，标量取第一个）
  const texts = await Promise.all(successes.map((s) => s.res.text()));
  const bodies: unknown[] = texts.map((t) => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  });

  if (bodies.every((b) => b !== null)) {
    const merged = mergeJsonBodies(bodies);
    if (merged !== null) {
      return new Response(JSON.stringify(merged), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Gateway-Merged-Upstreams": String(successes.length),
          "X-Gateway-Upstream-Ids": successes.map((s) => s.row.id).join(","),
          ...partialHeader(),
        },
      });
    }
  }

  // 形状不可合并：返回第一个成功响应
  const first = successes[0]!;
  const headers = filterResponseHeaders(first.res);
  headers.set("X-Gateway-Upstream-Id", first.row.id);
  for (const [key, value] of Object.entries(partialHeader())) headers.set(key, value);
  return new Response(first.res.body === null ? null : texts[0]!, {
    status: first.res.status,
    headers,
  });
}

/** 合并多个 JSON：数组拼接（含对象内的数组字段），不可合并返回 null */
function mergeJsonBodies(bodies: unknown[]): unknown | null {
  if (bodies.every((b) => Array.isArray(b))) return bodies.flat();
  if (
    bodies.every((b) => b !== null && typeof b === "object" && !Array.isArray(b))
  ) {
    const objs = bodies as Record<string, unknown>[];
    const out: Record<string, unknown> = {};
    for (const key of new Set(objs.flatMap((o) => Object.keys(o)))) {
      const values = objs.map((o) => o[key]).filter((v) => v !== undefined);
      out[key] = values.every((v) => Array.isArray(v))
        ? ([] as unknown[]).concat(...values)
        : values[0];
    }
    return out;
  }
  return null;
}

function filterResponseHeaders(res: Response): Headers {
  const headers = new Headers();
  res.headers.forEach((value, key) => {
    if (!BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  return headers;
}
