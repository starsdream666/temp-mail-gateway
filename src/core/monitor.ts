import { newId } from "./ids";
import type { AdapterRegistry } from "../adapters/registry";
import type { CryptoPort } from "../ports/crypto";
import type { HealthStore, UpstreamRow, UpstreamStore } from "../ports/stores";
import type { GlobalSettings } from "./settings";

/**
 * 上游健康监控核心：周期性探测各渠道存活状态与域名变化。
 * - 存活探测：调用适配器的 listDomains（各适配器均为轻量公开/配置端点，同时验证凭证与响应形状）；
 * - 域名变化：对比上游返回的域名与网关注册表，**默认直接同步进注册表**——上游已下掉的
 *   域名留在表里也建不出邮箱，只会污染域名下拉与 key 白名单选择器；渠道可用
 *   settings.autoSyncDomains=false 退回"只检测不改"；
 * - 安全闸（不可关闭，见 planDomainSync）：上游偶发返回空/残缺列表时不能把注册表清空，
 *   因此空列表与超阈值的批量移除一律拒绝自动应用，只记录待人工确认；新增永不受限；
 * - 新渠道自动纳入：每轮遍历 listEnabled()，无需单独注册。
 * Node 入口用 setInterval 驱动；Workers 部署可改用 Cron Triggers 调用本函数。
 */

export interface MonitorDeps {
  upstreams: UpstreamStore;
  health: HealthStore;
  registry: AdapterRegistry;
  crypto: CryptoPort;
  getSettings?: () => Promise<GlobalSettings>;
}

export interface HealthCheckOutcome {
  upstreamId: string;
  upstreamName: string;
  status: "up" | "down";
  latencyMs: number | null;
  domainsTotal: number | null;
  /** 检测到的差异（不代表已写入注册表，看 syncAction） */
  domainsAdded: string[];
  domainsRemoved: string[];
  /** 差异处置：applied / detected / blocked:<原因>；无差异时 null */
  syncAction: string | null;
  error?: string;
}

/** 域名自动同步的处置计划 */
export interface DomainSyncPlan {
  /** 本次实际要写入注册表的域名集合；null = 不动注册表 */
  keep: string[] | null;
  syncAction: string;
}

/**
 * 批量移除的安全阈值：超过 max(5, 30%) 的移除不自动应用。
 * 目的不是阻止真实的域名下架，而是拦住"上游返回了残缺列表"这类故障——
 * 它通常表现为空列表或一次性掉一大片。真实下架经人工确认（管理端一键同步）即可。
 */
export const DOMAIN_REMOVAL_ABSOLUTE_FLOOR = 5;
export const DOMAIN_REMOVAL_RATIO = 0.3;

/** 该渠道是否自动把域名差异同步进注册表（缺省开启） */
export function autoSyncDomainsEnabled(settings: Record<string, unknown>): boolean {
  return settings.autoSyncDomains !== false;
}

/**
 * 决定这次差异怎么处置。纯函数，便于单测覆盖各类边界。
 * 新增始终可以应用；移除受安全闸约束——被拦下时仍应用新增，
 * 保留待移除域名（keep = 上游返回 ∪ 待移除），使注册表只增不减。
 */
export function planDomainSync(input: {
  fetched: string[];
  registered: string[];
  added: string[];
  removed: string[];
  autoSync: boolean;
}): DomainSyncPlan {
  const { fetched, registered, added, removed, autoSync } = input;
  if (added.length === 0 && removed.length === 0) return { keep: null, syncAction: "" };
  if (!autoSync) return { keep: null, syncAction: "detected" };

  if (removed.length === 0) return { keep: fetched, syncAction: "applied" };

  // 空列表永不可信：上游故障、鉴权失效、WAF 拦截页都可能让 listDomains 返回空数组
  if (fetched.length === 0 && registered.length > 0) {
    return {
      keep: added.length > 0 ? [...new Set([...fetched, ...removed])] : null,
      syncAction: "blocked:上游返回空域名列表",
    };
  }

  const threshold = Math.max(DOMAIN_REMOVAL_ABSOLUTE_FLOOR, Math.ceil(registered.length * DOMAIN_REMOVAL_RATIO));
  if (removed.length > threshold) {
    return {
      // 只应用新增，待移除域名原样保留
      keep: added.length > 0 ? [...new Set([...fetched, ...removed])] : null,
      syncAction: `blocked:一次性移除 ${removed.length} 个域名超出安全阈值 ${threshold}`,
    };
  }

  return { keep: fetched, syncAction: "applied" };
}

/** 每渠道保留的健康检查记录条数（默认 5 分钟一轮 ≈ 最近 40 小时） */
export const HEALTH_HISTORY_KEEP = 500;

/** 到期扫描的执行间隔（每轮扫描所有渠道，仅探测"已到期"的渠道） */
export const HEALTH_SWEEP_INTERVAL_MS = 60_000;

/** 单渠道测活频率下限：保护上游与请求配额，不低于 1 分钟 */
export const HEALTH_MIN_INTERVAL_MS = 60_000;

/** 计算某渠道的有效测活间隔；返回 null 表示该渠道已关闭监控 */
export function effectiveMonitorIntervalMs(
  settings: Record<string, unknown>,
  globalIntervalMs: number | undefined,
): number | null {
  if (settings.monitorDisabled === true) return null;
  const configured = Number(settings.monitorIntervalMs);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(HEALTH_MIN_INTERVAL_MS, configured);
  }
  return Math.max(HEALTH_MIN_INTERVAL_MS, globalIntervalMs ?? 300_000);
}

/**
 * 到期扫描（自动轮询入口）：每 60 秒由调用方驱动一次，
 * 只探测"距上次检查已超过自身有效间隔"的渠道——不同渠道可以用不同频率，
 * 按需调低自托管渠道的探测频率以节省请求配额。
 */
export async function runHealthSweep(
  deps: MonitorDeps,
  opts?: { globalIntervalMs?: number; now?: number },
): Promise<HealthCheckOutcome[]> {
  const settings = await deps.getSettings?.();
  if (settings?.healthCheckEnabled === false) return [];
  const globalIntervalMs = settings?.healthCheckIntervalMs ?? opts?.globalIntervalMs;
  const now = opts?.now ?? Date.now();
  const instances = await deps.upstreams.listEnabled();
  const outcomes: HealthCheckOutcome[] = [];
  for (const row of instances) {
    const effective = effectiveMonitorIntervalMs(row.settingsJson, globalIntervalMs);
    if (effective === null) continue; // 该渠道关闭监控
    const last = await deps.health.listByUpstream(row.id, 1);
    const lastAt = last[0]?.checkedAt.getTime() ?? 0;
    if (now - lastAt < effective) continue; // 未到期
    outcomes.push(await checkOne(deps, row));
  }
  return outcomes;
}

/** 执行一轮全渠道健康检查，结果落库并返回（供状态页与日志使用） */
export async function runHealthChecks(deps: MonitorDeps): Promise<HealthCheckOutcome[]> {
  const instances = await deps.upstreams.listEnabled();
  const outcomes: HealthCheckOutcome[] = [];
  // 顺序执行：渠道数量有限，避免并发探测对上游造成瞬时压力
  for (const row of instances) {
    outcomes.push(await checkOne(deps, row));
  }
  return outcomes;
}

async function checkOne(deps: MonitorDeps, row: UpstreamRow): Promise<HealthCheckOutcome> {
  const base = { upstreamId: row.id, upstreamName: row.name };

  if (!deps.registry.has(row.type)) {
    const error = `适配器类型未注册: ${row.type}`;
    await record(deps, row.id, "down", null, null, [], [], error, null);
    return {
      ...base, status: "down", latencyMs: null, domainsTotal: null,
      domainsAdded: [], domainsRemoved: [], syncAction: null, error,
    };
  }

  const adapter = deps.registry.get(row.type);
  const started = Date.now();
  try {
    const cfg = {
      id: row.id,
      type: row.type,
      baseUrl: row.baseUrl,
      apiKey: row.apiKeyEnc ? await deps.crypto.decrypt(row.apiKeyEnc) : undefined,
      settings: row.settingsJson,
    };
    const domains = await adapter.listDomains(cfg);
    const latencyMs = Date.now() - started;

    const fetched = [...new Set(domains.map((d) => d.domain.toLowerCase()))].sort();
    const fetchedSet = new Set(fetched);
    const registered = (await deps.upstreams.listDomainsByUpstream(row.id)).map((d) => d.domain);
    const registeredSet = new Set(registered);
    const domainsAdded = fetched.filter((d) => !registeredSet.has(d));
    const domainsRemoved = registered.filter((d) => !fetchedSet.has(d));

    const plan = planDomainSync({
      fetched,
      registered,
      added: domainsAdded,
      removed: domainsRemoved,
      autoSync: autoSyncDomainsEnabled(row.settingsJson),
    });
    let syncAction = plan.syncAction || null;
    if (plan.keep) {
      try {
        // isPrivate 取上游本次返回值；被安全闸保留下来的待移除域名不在返回里，按 false
        // （replaceDomains 只对存活域名保留 enabled 开关，不回写 isPrivate 语义）
        await deps.upstreams.replaceDomains(
          row.id,
          plan.keep.map((domain) => ({
            domain,
            upstreamId: row.id,
            isPrivate: domains.find((d) => d.domain.toLowerCase() === domain)?.isPrivate ?? false,
            enabled: true, // 新域名默认启用；已存在域名由 replaceDomains 保留原开关
            syncedAt: new Date(),
          })),
        );
      } catch (writeErr) {
        // 探测本身是成功的（status 仍为 up），只是同步失败——如实记录，下一轮会重试
        const msg = ((writeErr as Error)?.message ?? String(writeErr)).slice(0, 200);
        syncAction = `blocked:写入注册表失败 ${msg}`;
      }
    }

    await record(deps, row.id, "up", latencyMs, fetched.length, domainsAdded, domainsRemoved, null, syncAction);
    return {
      ...base,
      status: "up",
      latencyMs,
      domainsTotal: fetched.length,
      domainsAdded,
      domainsRemoved,
      syncAction,
    };
  } catch (cause) {
    const latencyMs = Date.now() - started;
    const message = ((cause as Error)?.message ?? String(cause)).slice(0, 500);
    // 探测失败时绝不改注册表：拿不到上游域名列表 ≠ 上游没有域名
    await record(deps, row.id, "down", latencyMs, null, [], [], message, null);
    return {
      ...base,
      status: "down",
      latencyMs,
      domainsTotal: null,
      domainsAdded: [],
      domainsRemoved: [],
      syncAction: null,
      error: message,
    };
  }
}

async function record(
  deps: MonitorDeps,
  upstreamId: string,
  status: "up" | "down",
  latencyMs: number | null,
  domainsTotal: number | null,
  domainsAdded: string[],
  domainsRemoved: string[],
  error: string | null,
  syncAction: string | null,
): Promise<void> {
  await deps.health.insert({
    id: newId(),
    upstreamId,
    status,
    latencyMs,
    domainsTotal,
    domainsAdded: domainsAdded.length > 0 ? domainsAdded : null,
    domainsRemoved: domainsRemoved.length > 0 ? domainsRemoved : null,
    error,
    syncAction,
  });
  await deps.health.prune(upstreamId, HEALTH_HISTORY_KEEP);
}
