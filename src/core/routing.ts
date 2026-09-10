import type { UpstreamStore, UpstreamWithDomain } from "../ports/stores";
import { AppError } from "./errors";

export interface ResolveOptions {
  /** key 渠道白名单；null/undefined = 不限渠道 */
  allowedChannels?: string[] | null;
  /** key 域名白名单；null/undefined = 不限域名 */
  allowedDomains?: string[] | null;
}

/**
 * 域名 → 上游 路由。复合主键 (domain, upstream_id) 允许多个渠道登记同一域名，
 * 因此这里在「该域名的全部登记行」里选主，而不是全局取最早创建者：
 *
 *   1. 候选 = 启用上游 × 该域名启用 的行；
 *   2. 有渠道白名单时，只保留白名单内的行——否则受限 key 会在 /v1/domains 看到
 *      域名、建箱却 403「无权使用渠道 X」（X 是调用方根本没请求过的渠道）；
 *   3. 有域名白名单时，名单外的行排除；
 *   4. 多个候选按登记顺序取最早（与 store 返回序一致）。
 *
 * 错误归因（S-02）：「没有启用上游」→ DOMAIN_NOT_ROUTED（400，指向上游实例状态）；
 * 「有启用上游但域名行全停用」→ DOMAIN_DISABLED（403，指向域名开关）；
 * 「启用但被白名单排除」→ CHANNEL_NOT_ALLOWED / DOMAIN_NOT_ALLOWED。
 * DOMAIN_DISABLED 优先于白名单（与 §2 不变量 5 的判定顺序一致）。
 */
export async function resolveUpstreamByDomain(
  store: UpstreamStore,
  domain: string,
  opts?: ResolveOptions,
): Promise<UpstreamWithDomain> {
  const normalized = domain.trim().toLowerCase();
  const candidates = await store.listUpstreamsByDomain(normalized);

  if (candidates.length === 0) {
    throw new AppError("DOMAIN_NOT_ROUTED", `没有启用的上游拥有域名 ${normalized}`);
  }

  const channelSet = opts?.allowedChannels && opts.allowedChannels.length > 0
    ? new Set(opts.allowedChannels)
    : null;
  const domainSet = opts?.allowedDomains && opts.allowedDomains.length > 0
    ? new Set(opts.allowedDomains)
    : null;

  const enabledRows = candidates.filter((c) => c.enabled);
  if (enabledRows.length === 0) {
    // S-02：上游实例停用 ≠ 域名停用——管理员要找的是上游开关，不是域名开关
    throw new AppError("DOMAIN_NOT_ROUTED", `没有启用的上游拥有域名 ${normalized}`);
  }

  const usable = enabledRows.filter(
    (c) =>
      c.domainEnabled && // 该渠道的域名启用（逐渠道独立判定）
      (!channelSet || channelSet.has(c.id)) &&
      (!domainSet || domainSet.has(c.domain)),
  );

  if (usable.length === 0) {
    const domainEnabledRows = enabledRows.filter((c) => c.domainEnabled);
    if (domainEnabledRows.length === 0) {
      throw new AppError("DOMAIN_DISABLED", `域名 ${normalized} 已在管理端停用`);
    }
    const byChannel = channelSet
      ? domainEnabledRows.filter((c) => channelSet.has(c.id))
      : domainEnabledRows;
    if (channelSet && byChannel.length === 0) {
      throw new AppError(
        "CHANNEL_NOT_ALLOWED",
        `当前 key 无权使用该域名所在的渠道（请联系管理员调整该 key 的渠道白名单）`,
      );
    }
    throw new AppError(
      "DOMAIN_NOT_ALLOWED",
      `当前 key 无权使用域名 ${normalized}（请联系管理员调整该 key 的域名白名单）`,
    );
  }

  return usable[0]!;
}

/**
 * 从所有活跃域名中随机挑选一个（调用方未指定域名时）。
 * allowedDomains / allowedChannels 非 null 时只在对应白名单内挑选（key 域名/渠道限制）。
 *
 * S-03：先按域名归组、等概率挑**域名**，组内再取选主行（最早创建的启用候选）。
 * 若直接在 (domain, upstream) 行数组上等概率取，登记在 N 个渠道的共享域名会有
 * N 倍选中概率——被放大的是域名而非渠道，属于没人声明过的隐式权重。
 */
export async function pickDomain(
  store: UpstreamStore,
  opts?: { allowedDomains?: string[] | null; allowedChannels?: string[] | null },
): Promise<UpstreamWithDomain> {
  const rows = await store.listActiveDomains();
  let allowed = rows;
  if (opts?.allowedChannels) {
    const channels = new Set(opts.allowedChannels);
    allowed = allowed.filter((d) => channels.has(d.id));
  }
  if (opts?.allowedDomains) {
    const domainSet = new Set(opts.allowedDomains);
    allowed = allowed.filter((d) => domainSet.has(d.domain));
  }
  if (allowed.length === 0) {
    throw new AppError("DOMAIN_NOT_ROUTED", "网关当前没有可用域名，请先在管理端接入上游并同步域名");
  }

  // 按域名归组：同一域名多渠道只算一个候选；组内保留登记序（listActiveDomains 升序），
  // 取组首（最早创建渠道）作为该域名的代表行——与 resolveUpstreamByDomain 选主一致。
  const byDomain = new Map<string, UpstreamWithDomain>();
  for (const row of allowed) {
    if (!byDomain.has(row.domain)) byDomain.set(row.domain, row);
  }
  const unique = [...byDomain.values()];
  const idx = Math.floor(Math.random() * unique.length);
  return unique[idx]!;
}
