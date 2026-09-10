import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

export const upstreams = sqliteTable("upstreams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKeyEnc: text("api_key_enc"),
  settingsJson: text("settings_json", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const domains = sqliteTable(
  "domains",
  {
    domain: text("domain").notNull(),
    upstreamId: text("upstream_id")
      .notNull()
      .references(() => upstreams.id),
    isPrivate: integer("is_private", { mode: "boolean" }).notNull().default(false),
    /** 管理端可开关：停用后统一 API 不再路由/列出该域名（存量邮箱收发不受影响） */
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    syncedAt: integer("synced_at", { mode: "timestamp" }).notNull(),
  },
  // 复合主键 (domain, upstream_id)：允许多个渠道登记同一域名（临时邮箱场景很常见），
  // 单渠道同步失败/冲突不再波及其他渠道的域名行（全局主键会把碰撞渠道的域名清空）。
  (t) => [primaryKey({ columns: [t.domain, t.upstreamId] }), index("domains_upstream_idx").on(t.upstreamId)],
);

export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: text("id").primaryKey(),
    upstreamId: text("upstream_id")
      .notNull()
      .references(() => upstreams.id),
    address: text("address").notNull().unique(),
    localPart: text("local_part").notNull(),
    domain: text("domain").notNull(),
    upstreamMailboxId: text("upstream_mailbox_id").notNull(),
    credentialsEnc: text("credentials_enc"),
    passwordEnc: text("password_enc"),
    apiKeyId: text("api_key_id"),
    webhookUrl: text("webhook_url"),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("mailboxes_upstream_idx").on(t.upstreamId), index("mailboxes_created_idx").on(t.createdAt)],
);

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  /** 完整密钥明文的 AES-GCM 密文（管理端可随时取回复制）；旧版本创建的 key 为 null */
  keyEnc: text("key_enc"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** 域名白名单（JSON 数组，小写）；null = 不限制，可调用全部启用域名 */
  domainsJson: text("domains_json"),
  /** 渠道（上游实例）白名单（JSON 数组，upstream id）；null = 不限渠道 */
  channelsJson: text("channels_json"),
  /** 每小时邮箱创建请求上限；null = 继承系统默认，0 = 不限 */
  mailboxesPerHour: integer("mailboxes_per_hour"),
  maxConcurrentRequests: integer("max_concurrent_requests"),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const globalSettings = sqliteTable("global_settings", {
  id: integer("id").primaryKey(),
  adminPasswordHash: text("admin_password_hash"),
  healthCheckEnabled: integer("health_check_enabled", { mode: "boolean" }),
  healthCheckIntervalMs: integer("health_check_interval_ms"),
  mailboxesPerKeyPerHour: integer("mailboxes_per_key_per_hour"),
  maxConcurrentRequestsPerKey: integer("max_concurrent_requests_per_key"),
});

/** 上游健康检查历史（存活探测 + 域名变化），状态监控页的数据源 */
export const healthChecks = sqliteTable(
  "health_checks",
  {
    id: text("id").primaryKey(),
    upstreamId: text("upstream_id")
      .notNull()
      .references(() => upstreams.id),
    checkedAt: integer("checked_at", { mode: "timestamp" }).notNull(),
    /** 'up' | 'down' */
    status: text("status").notNull(),
    latencyMs: integer("latency_ms"),
    domainsTotal: integer("domains_total"),
    domainsAddedJson: text("domains_added_json", { mode: "json" }).$type<string[]>(),
    domainsRemovedJson: text("domains_removed_json", { mode: "json" }).$type<string[]>(),
    error: text("error"),
    /**
     * 域名差异的处置结果：'applied'（已自动同步进注册表）/ 'detected'（仅检测，
     * 该渠道关闭了自动同步）/ 'blocked:<原因>'（触发安全闸未自动应用，需人工确认）。
     * 无差异时为 null。
     */
    syncAction: text("sync_action"),
  },
  (t) => [index("health_upstream_idx").on(t.upstreamId, t.checkedAt)],
);

/**
 * 尽力删除留下的残留：网关记录已删、上游可能仍保留那个邮箱。
 * 没有这张表的话，force 删除失败的痕迹只存在于一次性的 HTTP 响应里，
 * 管理员事后完全看不到「上游还欠我一次清理」，孤儿会静默堆积。
 * 刻意不设 upstreamId 外键：上游实例本身被删除后，孤儿线索仍要留着。
 */
export const orphanMailboxes = sqliteTable(
  "orphan_mailboxes",
  {
    id: text("id").primaryKey(),
    upstreamId: text("upstream_id").notNull(),
    upstreamName: text("upstream_name").notNull(),
    address: text("address").notNull(),
    /** 上游侧标识，手工清理时用得上（cf 是地址本身、moe 是 uuid） */
    upstreamMailboxId: text("upstream_mailbox_id").notNull(),
    /** 上游报回来的错误码与原文，判断是否值得重试 */
    errorCode: text("error_code"),
    error: text("error"),
    detectedAt: integer("detected_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("orphan_detected_idx").on(t.detectedAt)],
);
