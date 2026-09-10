import { and, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as s from "../../../db/schema";
import type {
  UpstreamStore,
  MailboxStore,
  ApiKeyStore,
  HealthStore,
  UpstreamRow,
  UpstreamWithDomain,
  NewUpstream,
  NewMailbox,
  MailboxRow,
  ApiKeyRow,
  DomainRow,
  HealthCheckRow,
  NewHealthCheck,
  MailboxListFilter,
  OrphanStore,
  NewOrphanMailbox,
  SettingsStore,
} from "../../../ports/stores";
import { StoreError } from "../../../ports/stores";

/**
 * D1 与 better-sqlite3 共用的 Drizzle Store 实现。
 * 两个驱动的查询构建器在运行时行为一致（await 兼容同步返回），
 * 因此内部统一按 BetterSQLite3Database 的类型使用。
 */

/** D1 单条语句的绑定参数上限（100）；批量写入/IN 列表按此分批 */
const D1_PARAM_BATCH = 90;

/** lastUsedAt 写库节流窗口：该窗口内的重复鉴权不再产生写操作 */
const LAST_USED_THROTTLE_MS = 60_000;

function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 邮箱列表/计数的共用过滤条件（list 与 count 必须同口径，否则分页总数对不上）。
 * apiKeyId 是严格相等：透传自动登记的记录 apiKeyId 为 null，只有显式
 * includeShared 才并入——列表口径比读取口径严，见 ports/stores.ts 的说明。
 */
function mailboxFilter(opts?: MailboxListFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (opts?.upstreamId) conds.push(eq(s.mailboxes.upstreamId, opts.upstreamId));
  if (opts?.apiKeyId) {
    conds.push(
      opts.includeShared
        ? or(eq(s.mailboxes.apiKeyId, opts.apiKeyId), isNull(s.mailboxes.apiKeyId))!
        : eq(s.mailboxes.apiKeyId, opts.apiKeyId),
    );
  }
  if (opts?.includeExpired === false) {
    const now = opts.now ?? new Date();
    conds.push(or(isNull(s.mailboxes.expiresAt), gt(s.mailboxes.expiresAt, now))!);
  }
  if (conds.length === 0) return undefined;
  return conds.length === 1 ? conds[0] : and(...conds);
}

export function createDrizzleStores(
  rawDb: DrizzleD1Database<Record<string, never>> | BetterSQLite3Database<Record<string, never>>,
): {
  upstreams: UpstreamStore;
  mailboxes: MailboxStore;
  apiKeys: ApiKeyStore;
  health: HealthStore;
  orphans: OrphanStore;
  settings: SettingsStore;
} {
  const db = rawDb as BetterSQLite3Database;

  const settingsStore: SettingsStore = {
    async get() {
      const rows = await db.select().from(s.globalSettings).where(eq(s.globalSettings.id, 1));
      return rows[0] ?? null;
    },
    async update(patch) {
      await db.insert(s.globalSettings).values({ id: 1, ...patch })
        .onConflictDoUpdate({ target: s.globalSettings.id, set: patch });
    },
  };

  const upstreamStore: UpstreamStore = {
    async create(input: NewUpstream): Promise<UpstreamRow> {
      const rows = await db
        .insert(s.upstreams)
        .values({ ...input, enabled: input.enabled ?? true, createdAt: new Date() })
        .returning();
      return toUpstream(rows[0]!);
    },

    async update(id, patch) {
      await db.update(s.upstreams).set(patch).where(eq(s.upstreams.id, id));
    },

    async delete(id) {
      const count = await countMailboxes(db, id);
      if (count > 0) {
        throw new StoreError("UPSTREAM_IN_USE", `该上游名下仍有 ${count} 个邮箱，请先删除`);
      }
      await db.delete(s.domains).where(eq(s.domains.upstreamId, id));
      await db.delete(s.healthChecks).where(eq(s.healthChecks.upstreamId, id));
      await db.delete(s.upstreams).where(eq(s.upstreams.id, id));
    },

    async get(id) {
      const rows = await db.select().from(s.upstreams).where(eq(s.upstreams.id, id)).limit(1);
      return rows[0] ? toUpstream(rows[0]) : null;
    },

    async list() {
      const rows = await db.select().from(s.upstreams).orderBy(sql`${s.upstreams.createdAt} asc`);
      return rows.map(toUpstream);
    },

    async listEnabled() {
      const rows = await db
        .select()
        .from(s.upstreams)
        .where(eq(s.upstreams.enabled, true))
        .orderBy(sql`${s.upstreams.createdAt} asc`);
      return rows.map(toUpstream);
    },

    async replaceDomains(upstreamId, domainRows: DomainRow[]) {
      // 差异化同步（不整表重插）：已存在的域名保留管理端设置的 enabled 开关，
      // 新域名默认启用。复合主键 (domain, upstream_id) 下，其他渠道登记同一域名
      // 不再构成冲突；同渠道重复同步由 onConflictDoUpdate 幂等消化。
      // 语句按行分批（D1 单语句上限 100 个绑定参数），同步失败时已提交的部分
      // 仍是"旧集合 ∩ 已更新子集"，不会出现全删后清空渠道域名的状态。
      const existing = await db
        .select({ domain: s.domains.domain })
        .from(s.domains)
        .where(eq(s.domains.upstreamId, upstreamId));
      const wanted = new Set(domainRows.map((r) => r.domain));

      for (const rows of chunk(domainRows, D1_PARAM_BATCH / 5)) {
        await db
          .insert(s.domains)
          .values(rows.map((row) => ({ ...row, enabled: true })))
          .onConflictDoUpdate({
            target: [s.domains.domain, s.domains.upstreamId],
            set: {
              isPrivate: sql`excluded.is_private`,
              syncedAt: sql`excluded.synced_at`,
              // 不更新 enabled，避免覆盖与同步并发发生的管理员开关操作。
            },
          });
      }
      // 只删除"确认已消失"的域名行；其他渠道的行不属于本渠道，天然不受影响
      const stale = existing.map((r) => r.domain).filter((d) => !wanted.has(d));
      for (const domains of chunk(stale, D1_PARAM_BATCH)) {
        await db
          .delete(s.domains)
          .where(and(eq(s.domains.upstreamId, upstreamId), inArray(s.domains.domain, domains)));
      }
    },

    async listDomainsByUpstream(upstreamId) {
      const rows = await db.select().from(s.domains).where(eq(s.domains.upstreamId, upstreamId));
      return rows.map(toDomain);
    },

    async countDomains(upstreamId) {
      const rows = await db
        .select({ n: sql<number>`count(*)` })
        .from(s.domains)
        .where(eq(s.domains.upstreamId, upstreamId));
      return Number(rows[0]?.n ?? 0);
    },

    async listUpstreamsByDomain(domain): Promise<UpstreamWithDomain[]> {
      // 全部登记行（含停用上游/停用域名），升序：最早创建的上游在前，
      // 多候选时由 routing 层按 key 白名单与启用状态选主。
      const rows = await db
        .select({ u: s.upstreams, d: s.domains })
        .from(s.domains)
        .innerJoin(s.upstreams, eq(s.domains.upstreamId, s.upstreams.id))
        .where(eq(s.domains.domain, domain))
        .orderBy(sql`${s.upstreams.createdAt} asc`, sql`${s.upstreams.id} asc`);
      return rows.map((row) => toUpstreamWithDomain(row.u, row.d));
    },

    async getDomain(upstreamId, domain) {
      const rows = await db
        .select()
        .from(s.domains)
        .where(and(eq(s.domains.upstreamId, upstreamId), eq(s.domains.domain, domain)))
        .limit(1);
      return rows[0] ? toDomain(rows[0]) : null;
    },

    async listActiveDomains(): Promise<UpstreamWithDomain[]> {
      const rows = await db
        .select({ u: s.upstreams, d: s.domains })
        .from(s.domains)
        .innerJoin(s.upstreams, eq(s.domains.upstreamId, s.upstreams.id))
        .where(and(eq(s.upstreams.enabled, true), eq(s.domains.enabled, true)));
      return rows.map((row) => toUpstreamWithDomain(row.u, row.d));
    },

    async listAllDomains(): Promise<UpstreamWithDomain[]> {
      const rows = await db
        .select({ u: s.upstreams, d: s.domains })
        .from(s.domains)
        .innerJoin(s.upstreams, eq(s.domains.upstreamId, s.upstreams.id));
      return rows.map((row) => toUpstreamWithDomain(row.u, row.d));
    },

    async setDomainEnabled(upstreamId, domain, enabled) {
      const updated = await db
        .update(s.domains)
        .set({ enabled })
        .where(and(eq(s.domains.upstreamId, upstreamId), eq(s.domains.domain, domain)))
        .returning({ domain: s.domains.domain });
      return updated.length > 0;
    },

    async setAllDomainsEnabled(upstreamId, enabled) {
      const updated = await db
        .update(s.domains)
        .set({ enabled })
        .where(eq(s.domains.upstreamId, upstreamId))
        .returning({ domain: s.domains.domain });
      return updated.length;
    },

    async countMailboxes(upstreamId) {
      return countMailboxes(db, upstreamId);
    },
  };

  const mailboxStore: MailboxStore = {
    async create(input: NewMailbox): Promise<MailboxRow> {
      const rows = await db
        .insert(s.mailboxes)
        .values({ ...input, webhookUrl: null, createdAt: new Date() })
        .returning();
      return toMailbox(rows[0]!);
    },

    async get(id) {
      const rows = await db.select().from(s.mailboxes).where(eq(s.mailboxes.id, id)).limit(1);
      return rows[0] ? toMailbox(rows[0]) : null;
    },

    async findByAddress(address) {
      const rows = await db.select().from(s.mailboxes).where(eq(s.mailboxes.address, address)).limit(1);
      return rows[0] ? toMailbox(rows[0]) : null;
    },

    async findByUpstreamMailboxId(upstreamId, upstreamMailboxId) {
      const rows = await db
        .select()
        .from(s.mailboxes)
        .where(and(eq(s.mailboxes.upstreamId, upstreamId), eq(s.mailboxes.upstreamMailboxId, upstreamMailboxId)))
        .limit(1);
      return rows[0] ? toMailbox(rows[0]) : null;
    },

    async delete(id) {
      await db.delete(s.mailboxes).where(eq(s.mailboxes.id, id));
    },

    async deleteExpired(before) {
      const rows = await db
        .delete(s.mailboxes)
        .where(lt(s.mailboxes.expiresAt, before))
        .returning({ id: s.mailboxes.id });
      return rows.length;
    },

    async list(opts) {
      const rows = await db
        .select()
        .from(s.mailboxes)
        .where(mailboxFilter(opts))
        .orderBy(sql`${s.mailboxes.createdAt} desc`)
        .limit(opts?.limit ?? 100)
        .offset(opts?.offset ?? 0);
      return rows.map(toMailbox);
    },

    async count(opts) {
      const rows = await db
        .select({ n: sql<number>`count(*)` })
        .from(s.mailboxes)
        .where(mailboxFilter(opts));
      return Number(rows[0]?.n ?? 0);
    },
  };

  const apiKeyStore: ApiKeyStore = {
    async create(input): Promise<ApiKeyRow> {
      const rows = await db
        .insert(s.apiKeys)
        .values({
          id: input.id,
          name: input.name,
          keyHash: input.keyHash,
          prefix: input.prefix,
          keyEnc: input.keyEnc,
          domainsJson: input.domains ? JSON.stringify(input.domains) : null,
          channelsJson: input.channels ? JSON.stringify(input.channels) : null,
          mailboxesPerHour: input.mailboxesPerHour ?? null,
          maxConcurrentRequests: input.maxConcurrentRequests ?? null,
          enabled: true,
          createdAt: new Date(),
        })
        .returning();
      return toApiKey(rows[0]!);
    },

    async verify(keyHash) {
      const rows = await db
        .select()
        .from(s.apiKeys)
        .where(and(eq(s.apiKeys.keyHash, keyHash), eq(s.apiKeys.enabled, true)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      // lastUsedAt 只服务管理端展示，秒级精度无价值；节流到 60s 以上才写一次，
      // 避免每个 /v1、/upstream 请求都产生一次写（D1 写既慢又计费，还争抢同一行）
      const lastUsed = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
      if (Date.now() - lastUsed > LAST_USED_THROTTLE_MS) {
        try {
          await db.update(s.apiKeys).set({ lastUsedAt: new Date() }).where(eq(s.apiKeys.id, row.id));
        } catch {
          // lastUsedAt 更新失败不影响鉴权
        }
      }
      return toApiKey(row);
    },

    async get(id) {
      const rows = await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, id)).limit(1);
      return rows[0] ? toApiKey(rows[0]) : null;
    },

    async delete(id) {
      await db.delete(s.apiKeys).where(eq(s.apiKeys.id, id));
    },

    async update(id, patch) {
      const { domains, channels, ...rest } = patch;
      const rows = await db
        .update(s.apiKeys)
        .set({
          ...rest,
          ...(domains !== undefined && { domainsJson: domains ? JSON.stringify(domains) : null }),
          ...(channels !== undefined && { channelsJson: channels ? JSON.stringify(channels) : null }),
        })
        .where(eq(s.apiKeys.id, id))
        .returning();
      return rows[0] ? toApiKey(rows[0]) : null;
    },

    async list() {
      const rows = await db.select().from(s.apiKeys).orderBy(sql`${s.apiKeys.createdAt} desc`);
      return rows.map(toApiKey);
    },
  };

  const healthStore: HealthStore = {
    async insert(check: NewHealthCheck): Promise<void> {
      await db.insert(s.healthChecks).values({
        id: check.id,
        upstreamId: check.upstreamId,
        checkedAt: new Date(),
        status: check.status,
        latencyMs: check.latencyMs ?? null,
        domainsTotal: check.domainsTotal ?? null,
        domainsAddedJson: check.domainsAdded ?? null,
        domainsRemovedJson: check.domainsRemoved ?? null,
        error: check.error ?? null,
        syncAction: check.syncAction ?? null,
      });
    },

    async listByUpstream(upstreamId, limit) {
      // checkedAt 为秒级精度；同一秒的检查与手动同步按实际插入顺序排列。
      const rows = await db
        .select()
        .from(s.healthChecks)
        .where(eq(s.healthChecks.upstreamId, upstreamId))
        .orderBy(sql`${s.healthChecks.checkedAt} desc`, sql`rowid desc`)
        .limit(limit);
      return rows.map(toHealthCheck);
    },

    async prune(upstreamId, keep) {
      await db
        .delete(s.healthChecks)
        .where(
          and(
            eq(s.healthChecks.upstreamId, upstreamId),
            sql`${s.healthChecks.id} NOT IN (SELECT id FROM ${s.healthChecks} WHERE upstream_id = ${upstreamId} ORDER BY checked_at DESC, rowid DESC LIMIT ${keep})`,
          ),
        );
    },

    async deleteByUpstream(upstreamId) {
      await db.delete(s.healthChecks).where(eq(s.healthChecks.upstreamId, upstreamId));
    },
  };

  const orphanStore: OrphanStore = {
    async insert(row: NewOrphanMailbox): Promise<void> {
      await db.insert(s.orphanMailboxes).values({
        id: row.id,
        upstreamId: row.upstreamId,
        upstreamName: row.upstreamName,
        address: row.address,
        upstreamMailboxId: row.upstreamMailboxId,
        errorCode: row.errorCode ?? null,
        error: row.error ?? null,
        detectedAt: new Date(),
      });
    },

    async list(limit) {
      const rows = await db
        .select()
        .from(s.orphanMailboxes)
        .orderBy(sql`${s.orphanMailboxes.detectedAt} desc`)
        .limit(limit);
      return rows.map((r) => ({ ...r, detectedAt: new Date(r.detectedAt) }));
    },

    async delete(id) {
      await db.delete(s.orphanMailboxes).where(eq(s.orphanMailboxes.id, id));
    },

    async clear() {
      const rows = await db.delete(s.orphanMailboxes).returning({ id: s.orphanMailboxes.id });
      return rows.length;
    },
  };

  return {
    upstreams: upstreamStore,
    mailboxes: mailboxStore,
    apiKeys: apiKeyStore,
    settings: settingsStore,
    health: healthStore,
    orphans: orphanStore,
  };
}

type RawHealthCheck = typeof s.healthChecks.$inferSelect;

function toHealthCheck(r: RawHealthCheck): HealthCheckRow {
  return {
    id: r.id,
    upstreamId: r.upstreamId,
    checkedAt: new Date(r.checkedAt),
    status: r.status as "up" | "down",
    latencyMs: r.latencyMs,
    domainsTotal: r.domainsTotal,
    domainsAdded: r.domainsAddedJson ?? null,
    domainsRemoved: r.domainsRemovedJson ?? null,
    error: r.error,
    syncAction: r.syncAction ?? null,
  };
}

async function countMailboxes(db: BetterSQLite3Database, upstreamId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(s.mailboxes)
    .where(eq(s.mailboxes.upstreamId, upstreamId));
  return Number(rows[0]?.n ?? 0);
}

type RawUpstream = typeof s.upstreams.$inferSelect;
type RawDomain = typeof s.domains.$inferSelect;
type RawMailbox = typeof s.mailboxes.$inferSelect;
type RawApiKey = typeof s.apiKeys.$inferSelect;

// drizzle 的 timestamp 列读取时已是 Date；这里再包一层防御性归一
function toUpstream(r: RawUpstream): UpstreamRow {
  return { ...r, createdAt: new Date(r.createdAt) };
}

function toDomain(r: RawDomain): DomainRow {
  return { ...r, syncedAt: new Date(r.syncedAt) };
}

function toUpstreamWithDomain(u: RawUpstream, d: RawDomain): UpstreamWithDomain {
  return { ...toUpstream(u), domain: d.domain, isPrivate: d.isPrivate, domainEnabled: d.enabled };
}

function toMailbox(r: RawMailbox): MailboxRow {
  return {
    ...r,
    expiresAt: r.expiresAt ? new Date(r.expiresAt) : null,
    createdAt: new Date(r.createdAt),
  };
}

function toApiKey(r: RawApiKey): ApiKeyRow {
  const parse = (raw: string | null): string[] | null => {
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
      return null; // 脏数据按不限制处理
    }
  };
  return {
    ...r,
    domains: parse(r.domainsJson),
    channels: parse(r.channelsJson),
    lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt) : null,
    createdAt: new Date(r.createdAt),
  };
}
