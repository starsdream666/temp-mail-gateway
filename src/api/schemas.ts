import { z } from "@hono/zod-openapi";
import type { MailboxRow, UpstreamRow, ApiKeyRow, OrphanMailboxRow } from "../ports/stores";
import type { MessageSummary, MessageDetail, AdapterMeta } from "../ports/upstream";

/** OpenAPI 请求/响应 schema 与运行时 presenter（统一出口，绝不含密文字段） */

export const ErrorEnvelope = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi("ErrorEnvelope");

// ---------- v1 ----------

export const CreateMailboxBody = z
  .object({
    /** 缺省时由网关在活跃域名中随机挑选 */
    domain: z.string().max(253).optional(),
    localPart: z
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "localPart 只允许字母数字与 . _ -")
      .optional(),
    /** 相对过期的秒数；缺省跟随上游/永久 */
    expiresInSeconds: z.number().int().positive().max(365 * 24 * 3600).optional(),
  })
  .openapi("CreateMailboxBody");

export const Mailbox = z
  .object({
    id: z.string(),
    address: z.string(),
    localPart: z.string(),
    domain: z.string(),
    upstreamId: z.string(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .openapi("Mailbox");

export const DomainEntry = z
  .object({
    domain: z.string(),
    upstreamId: z.string(),
    upstreamType: z.string(),
    isPrivate: z.boolean(),
  })
  .openapi("DomainEntry");

/**
 * 查询串布尔值：只认 "true"/"1" 为真。
 * 不用 z.coerce.boolean()——它对任意非空字符串都返回 true，"false" 会被当成真。
 */
export const BoolQuery = z.enum(["true", "false", "1", "0"]);

export function isTrueQuery(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

/** 尽力删除（?force=1）的结果：网关记录必删，上游是否真删如实回报 */
export const DeleteMailboxResult = z
  .object({
    deleted: z.literal(true),
    /** false = 网关记录已删但上游可能仍保留（上游报错或未找到） */
    upstreamDeleted: z.boolean(),
    upstreamError: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .openapi("DeleteMailboxResult");

export const MessageSummarySchema = z
  .object({
    id: z.string(),
    from: z.string(),
    to: z.array(z.string()),
    subject: z.string(),
    intro: z.string().optional(),
    seen: z.boolean(),
    hasAttachments: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .openapi("MessageSummary");

export const Attachment = z
  .object({
    id: z.string(),
    filename: z.string(),
    contentType: z.string(),
    size: z.number().int(),
  })
  .openapi("Attachment");

export const MessageDetailSchema = MessageSummarySchema.extend({
  text: z.string().optional(),
  html: z.array(z.string()).optional(),
  attachments: z.array(Attachment),
}).openapi("MessageDetail");

// ---------- admin ----------

export const CreateUpstreamBody = z
  .object({
    name: z.string().min(1).max(100),
    type: z.string().min(1),
    baseUrl: z.string().url(),
    apiKey: z.string().optional(),
    /** 适配器私有配置，如 dummy 的 {"domains": ["a.test"]} */
    settings: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("CreateUpstreamBody");

export const UpdateUpstreamBody = z
  .object({
    name: z.string().min(1).max(100).optional(),
    baseUrl: z.string().url().optional(),
    /** 传 null 表示清除上游 key；缺省保持不变。type 不可修改。 */
    apiKey: z.string().nullable().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("UpdateUpstreamBody");

export const UpstreamSummary = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    baseUrl: z.string(),
    enabled: z.boolean(),
    hasApiKey: z.boolean(),
    domainCount: z.number().int(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .openapi("UpstreamSummary");

export const UpstreamDomainEntry = z
  .object({
    domain: z.string(),
    isPrivate: z.boolean(),
    enabled: z.boolean(),
    syncedAt: z.string().datetime({ offset: true }),
  })
  .openapi("UpstreamDomainEntry");

export const UpstreamDetail = UpstreamSummary.extend({
  settings: z.record(z.string(), z.unknown()),
  domains: z.array(UpstreamDomainEntry),
}).openapi("UpstreamDetail");

export const SyncDomainsResult = z
  .object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    total: z.number().int(),
    warning: z.string().optional(),
  })
  .openapi("SyncDomainsResult");

const MailboxesPerHour = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().openapi({
  description: "每小时邮箱创建请求上限；null = 继承系统默认，0 = 不限，正整数 = 自定义上限",
  example: 120,
});

const MaxConcurrentRequests = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().openapi({
  description: "同时处理的请求上限（统一 API 与透传合计）；null = 系统默认，0 = 不限",
});

export const CreateKeyBody = z
  .object({
    name: z.string().min(1).max(100),
    /** 域名白名单（可选）：限定该 key 可创建邮箱的域名；缺省/空数组 = 不限制 */
    domains: z.array(z.string().min(1).max(253)).max(500).optional(),
    /** 渠道白名单（可选，upstream id）：限定该 key 可使用的上游实例；缺省/空数组 = 不限制 */
    channels: z.array(z.string().min(1)).max(100).optional(),
    mailboxesPerHour: MailboxesPerHour.optional(),
    maxConcurrentRequests: MaxConcurrentRequests.optional(),
  })
  .openapi("CreateKeyBody");

export const UpdateKeyBody = z
  .object({
    name: z.string().min(1).max(100).optional(),
    /** 域名白名单：传数组更新名单，传 null 清除限制；缺省保持不变 */
    domains: z.array(z.string().min(1).max(253)).max(500).nullable().optional(),
    /** 渠道白名单：传数组更新，传 null 清除限制；缺省保持不变 */
    channels: z.array(z.string().min(1)).max(100).nullable().optional(),
    /** 缺省保持不变；null 恢复系统默认；0 不限 */
    mailboxesPerHour: MailboxesPerHour.optional(),
    maxConcurrentRequests: MaxConcurrentRequests.optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("UpdateKeyBody");

/** 管理端 key 域名编辑器的候选列表项 */
export const AdminDomainEntry = z
  .object({
    domain: z.string(),
    upstreamId: z.string(),
    upstreamName: z.string(),
    upstreamType: z.string(),
    upstreamEnabled: z.boolean(),
    isPrivate: z.boolean(),
    enabled: z.boolean(),
  })
  .openapi("AdminDomainEntry");

export const DomainToggleBody = z.object({ enabled: z.boolean() }).openapi("DomainToggleBody");

/** 纳管上游已存在的地址；apiKeyId 缺省 = 登记为共享邮箱（任何 key 可读、不进列表） */
export const ImportMailboxesBody = z
  .object({
    addresses: z.array(z.string().min(3).max(320)).min(1).max(200),
    apiKeyId: z.string().min(1).nullable().optional(),
  })
  .openapi("ImportMailboxesBody");

/** 逐地址结果：部分失败不影响其余地址 */
export const ImportMailboxesResult = z
  .object({
    imported: z.array(z.object({ address: z.string(), id: z.string(), upstreamId: z.string() })),
    failed: z.array(z.object({ address: z.string(), code: z.string(), message: z.string() })),
  })
  .openapi("ImportMailboxesResult");

/** 尽力删除留下的残留：网关记录已删、上游可能仍保留该邮箱 */
export const OrphanEntry = z
  .object({
    id: z.string(),
    upstreamId: z.string(),
    upstreamName: z.string(),
    address: z.string(),
    /** 上游侧标识，手工清理时用（cf 是地址本身、moe 是 uuid） */
    upstreamMailboxId: z.string(),
    errorCode: z.string().nullable(),
    error: z.string().nullable(),
    detectedAt: z.string().datetime({ offset: true }),
  })
  .openapi("OrphanEntry");

/**
 * 渠道测活配置：intervalMs 传 null 跟随全局默认；disabled 关闭该渠道的自动监控
 * （低于 60s 的值会被钳制到 60s）；autoSyncDomains 传 false 时测活只检测域名增删、
 * 不写入注册表（缺省开启自动同步）。
 */
export const MonitorConfigBody = z
  .object({
    intervalMs: z.number().int().min(1000).max(86_400_000).nullable().optional(),
    disabled: z.boolean().optional(),
    autoSyncDomains: z.boolean().optional(),
  })
  .openapi("MonitorConfigBody");

export const ApiKeyInfo = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    enabled: z.boolean(),
    /** 域名白名单；null = 不限制（可调用全部启用域名） */
    domains: z.array(z.string()).nullable(),
    /** 渠道白名单；null = 不限渠道 */
    channels: z.array(z.string()).nullable(),
    mailboxesPerHour: MailboxesPerHour,
    maxConcurrentRequests: MaxConcurrentRequests,
    effectiveMaxConcurrentRequests: z.number(),
    effectiveMailboxesPerHour: z.number().openapi({ description: "实际生效的每小时邮箱创建请求上限；0 = 不限" }),
    lastUsedAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .openapi("ApiKeyInfo");

export const CreatedApiKey = ApiKeyInfo.extend({ key: z.string() }).openapi("CreatedApiKey");

export const AdapterTypeInfo = z
  .object({
    type: z.string(),
    displayName: z.string(),
    description: z.string(),
    capabilities: z.object({ deleteMessage: z.boolean(), getSource: z.boolean() }),
  })
  .openapi("AdapterTypeInfo");

export const SessionBody = z.object({ password: z.string().min(1).max(1024) }).openapi("SessionBody");

// ---------- presenters ----------

export function presentMailbox(r: MailboxRow) {
  return {
    id: r.id,
    address: r.address,
    localPart: r.localPart,
    domain: r.domain,
    upstreamId: r.upstreamId,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

export function presentMessageSummary(m: MessageSummary) {
  return {
    id: m.id,
    from: m.from,
    to: m.to,
    subject: m.subject,
    intro: m.intro,
    seen: m.seen,
    hasAttachments: m.hasAttachments,
    createdAt: m.createdAt.toISOString(),
  };
}

export function presentMessageDetail(m: MessageDetail) {
  return {
    ...presentMessageSummary(m),
    text: m.text,
    html: m.html,
    attachments: m.attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size })),
  };
}

export function presentUpstreamSummary(r: UpstreamRow, domainCount: number) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    baseUrl: r.baseUrl,
    enabled: r.enabled,
    hasApiKey: r.apiKeyEnc !== null,
    domainCount,
    createdAt: r.createdAt.toISOString(),
  };
}

export function presentApiKey(r: ApiKeyRow, defaultMailboxesPerHour: number, defaultMaxConcurrentRequests = 0) {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    enabled: r.enabled,
    domains: r.domains,
    channels: r.channels,
    mailboxesPerHour: r.mailboxesPerHour,
    effectiveMailboxesPerHour: r.mailboxesPerHour ?? defaultMailboxesPerHour,
    maxConcurrentRequests: r.maxConcurrentRequests,
    effectiveMaxConcurrentRequests: r.maxConcurrentRequests ?? defaultMaxConcurrentRequests,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

export function presentAdapterMeta(m: AdapterMeta) {
  return { type: m.type, displayName: m.displayName, description: m.description, capabilities: m.capabilities };
}

export function presentOrphan(r: OrphanMailboxRow) {
  return {
    id: r.id,
    upstreamId: r.upstreamId,
    upstreamName: r.upstreamName,
    address: r.address,
    upstreamMailboxId: r.upstreamMailboxId,
    errorCode: r.errorCode,
    error: r.error,
    detectedAt: r.detectedAt.toISOString(),
  };
}
