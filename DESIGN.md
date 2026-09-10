# 临时邮箱聚合网关 设计文档

> 状态：v0.1（2026-09-05）**已实现：M0/M1 壳子 + 管理后台 SPA + 4 个真实上游适配器（cloudflare_temp_email / MoeMail / YYDS Mail / DuckMail）+ 统一 API + 原生格式透传 + 域名调用管控 / key 域名与渠道白名单 + 健康监控**。
> 本文档部分章节滞后于实现；**遇到文档与源码冲突，一律以源码为准**。当前功能与边界见 README。

## 1. 背景与目标

在多个临时邮箱上游服务（mail.tm、cloudflare_temp_email 等）前面架一层 API 网关，对外提供**一套统一的邮箱 API**，同时保留各上游**原生 API 透传**能力。

核心目标：

1. **统一 API**：调用方只学一套接口，创建邮箱、收件、取验证码，不关心背后是哪家上游。
2. **按域名路由**：请求中的邮箱域名决定由哪个上游处理；查域名时只返回对应上游的域名。
3. **多部署形态**：Cloudflare Workers / Vercel / Docker 均可部署。
4. **可管理**：Admin 后台配置每个上游的 endpoint + API key，可拉取其域名列表，可签发网关 API key。
5. **真实适配器先行**：骨架完成并稳定后逐个接入真实上游；Dummy 假上游只用于测试（`test/helpers.ts` 显式挂载），不在生产 bootstrap 内。

## 2. 总体架构

```
                    ┌────────────────────────────────────────────┐
   调用方 ──────────▶│              Gateway (Hono App)            │
 (带网关 API key)   │                                            │
                    │  /v1/*        统一邮箱 API                  │
                    │  /admin/*     管理 API + Admin UI           │
                    │  /upstream/*  上游原生透传（已实现）           │
                    │                                            │
                    │  ┌──────────┐  ┌────────────────────────┐  │
                    │  │ 域名路由  │  │  网关 API key 鉴权      │  │
                    │  └────┬─────┘  └────────────────────────┘  │
                    │       │ domain → upstream                  │
                    │  ┌────▼─────────────────────────────────┐  │
                    │  │  UpstreamAdapter 接口（适配器契约）    │  │
                    │  └────┬──────────┬──────────┬───────────┘  │
                    └───────┼──────────┼──────────┼──────────────┘
                            │          │          │
                     ┌──────▼───┐ ┌────▼─────┐ ┌──▼──────────┐
                     │ mail.tm  │ │ cf_temp  │ │  Dummy      │
                     │ adapter  │ │ adapter  │ │  (壳子期)    │
                     └──────────┘ └──────────┘ └─────────────┘

   存储抽象（ports）：UpstreamStore / MailboxStore / ApiKeyStore
   实现：D1（Workers）、better-sqlite3（Docker/本地），共用同一套 Drizzle schema
```

## 3. 已定案的关键决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 技术栈 | Hono + Drizzle ORM + zod | 运行时无关（Workers/Node 都能跑），类型安全 |
| 存储方言 | 统一走 SQLite 系：D1 + better-sqlite3 共用一份 Drizzle schema | 覆盖 Cloudflare 和 Docker 两种形态；Postgres 支持留到以后，避免一开始维护双方言 schema |
| 核心无 Node API | 只用 Web 标准：`fetch`、`crypto.subtle`、`URL` | 保证同一份核心代码跑在 Workers 和 Node |
| 应用组装 | `createApp(deps)` 工厂 + 两个薄入口（worker.ts / node.ts） | 依赖注入是运行时无关的关键 |
| 透传方式 | `/upstream/{寻址}/*` 路径前缀（**已实现**） | 上游格式请求（如 mail.tm 的 `/token`）不带邮箱地址，路径前缀显式无歧义；基于虚拟主机名的路由作为进阶模式后续再议 |
| 凭证存储 | 数据库存敏感字段（上游 key、邮箱 JWT）用 AES-GCM 信封加密，主密钥来自环境变量 | Workers 和 Node 都有 WebCrypto，成本低，一期就做 |
| Admin UI | **React 18 + Vite SPA**（`frontend/`，由后端同源托管），早期"Hono JSX 服务端渲染"的设想已废弃 | 实际采用独立 SPA，页面：上游/域名总览/Keys/邮箱概览/状态监控 |
| API 规范 | `@hono/zod-openapi`：路由即文档，自动产出 OpenAPI JSON + Swagger UI | 统一 API 是对外契约，值得一开始就规范 |
| ID 策略 | 网关自生成邮箱 ID（ULID），与上游内部 ID 解耦，映射存在 mailbox 记录里 | 调用方永远只认网关 ID |

## 4. 目录结构（壳子目标形态）

```
temp-mail-gateway/
├── DESIGN.md                     # 本文档
├── package.json
├── wrangler.toml                 # Workers 部署配置（含 D1 binding）
├── drizzle.config.ts
├── src/
│   ├── core/                     # 纯逻辑，不碰任何运行时 API
│   │   ├── app.ts                # createApp(deps)：组装所有路由
│   │   ├── routing.ts            # domain → upstream 解析、域名挑选策略
│   │   └── keys.ts               # 网关 key 生成 / 校验 / hash
│   ├── ports/                    # 抽象接口（壳子的骨架）
│   │   ├── upstream.ts           # UpstreamAdapter 接口 + 类型 + 错误定义
│   │   ├── stores.ts             # UpstreamStore / MailboxStore / ApiKeyStore 接口
│   │   └── crypto.ts             # 加解密接口（AES-GCM 实现）
│   ├── adapters/
│   │   ├── registry.ts           # 适配器注册表：type 字符串 → adapter 实例
│   │   ├── stores/drizzle/       # D1 与 better-sqlite3 共用一套 Drizzle Store 实现
│   │   ├── crypto/               # AES-GCM 加解密（WebCrypto）
│   │   └── upstreams/            # 每个真实上游一个子目录（cftempemail/moemail/yydsmail/duckmail…）
│   ├── api/
│   │   ├── v1.ts                 # 统一邮箱 API
│   │   ├── admin.ts              # 管理 API
│   │   ├── passthrough.ts        # 上游原生透传（/upstream/**）
│   │   ├── middleware/           # key 鉴权、admin 会话、CORS、错误封装
│   │   └── schemas.ts            # zod-openapi schema + presenter（唯一出口）
│   ├── db/
│   │   ├── schema.ts             # Drizzle schema（唯一一份）
│   │   └── migrate-node.ts       # Node 侧迁移执行（migrations/*.sql 在仓库根）
│   ├── core/                     # 纯逻辑（app/routing/keys/errors/ratelimit/monitor）
│   ├── bootstrap.ts              # 注册 4 个真实适配器
│   └── entries/
│       ├── worker.ts             # CF Workers 入口：D1 stores → createApp
│       └── node.ts               # Node/Docker 入口：better-sqlite3 stores → createApp
├── frontend/                     # React 18 + Vite + TS + Tailwind 管理后台 SPA
├── migrations/                   # drizzle-kit 生成的 SQL 迁移（0000~0005）
└── test/
    ├── contract/                 # 适配器契约测试：任何 adapter 都必须过同一套用例
    └── e2e/                      # 内存 SQLite 起真 app 的端到端测试
```

要点：`core/` + `ports/` + `adapters/registry.ts` 是壳子的核心；真实上游适配器只是往 `adapters/upstreams/` 加目录 + 注册一行。

## 5. 上游适配器接口契约（壳子先行的关键）

适配器是**无状态工厂产物**：所有依赖显式传参，适配器内部不持有可变全局状态。邮箱凭证等状态由网关负责持久化，适配器只管和上游说话。

```ts
// ports/upstream.ts

/** 数据库中的一条上游配置（解密后传给适配器） */
export interface UpstreamConfig {
  id: string;                          // 网关内实例 ID
  type: string;                        // 适配器类型，如 "mailtm"、"cf-temp-email"、"dummy"
  baseUrl: string;                     // 如 https://api.mail.tm
  apiKey?: string;                     // 已解密的上游 key（部分上游不需要）
  settings: Record<string, unknown>;   // 适配器私有配置（如默认域名、密码策略）
}

export interface DomainInfo {
  domain: string;
  isPrivate?: boolean;                 // 私有域名（需账号匹配）标记，透传上游原信息
}

/** 一次邮箱创建请求（网关层已校验） */
export interface CreateMailboxRequest {
  localPart?: string;                  // 缺省由适配器/上游生成
  domain: string;                      // 必然是路由到本上游的域名
  password?: string;
  expiresInSeconds?: number;           // 期望有效期；上游钳制时以返回的 expiresAt 为准
}

/** 适配器返回的邮箱引用，网关原样入库 */
export interface MailboxRef {
  upstreamMailboxId: string;
  address: string;
  credentials?: string;                // 如 mail.tm 的 JWT，网关加密存储
  password?: string;
  expiresAt?: Date;
}

export interface MessageSummary {
  id: string;
  from: string;
  to: string[];
  subject: string;
  intro?: string;                      // 正文预览
  seen: boolean;
  hasAttachments: boolean;
  createdAt: Date;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface MessageDetail extends MessageSummary {
  text?: string;
  html?: string[];
  attachments: AttachmentMeta[];
}

/** 适配器错误：选项对象构造；网关中间件负责映射 HTTP 状态码 */
export class UpstreamError extends Error {
  constructor(options: {
    code: "AUTH_FAILED" | "RATE_LIMITED" | "UNAVAILABLE" | "BAD_REQUEST"
      | "NOT_FOUND" | "CAPABILITY_MISSING" | "UNKNOWN";
    upstreamId: string;
    retryable: boolean;
    message: string;
    upstreamCause?: unknown;           // 注意字段名是 upstreamCause（历史文档写的 cause 已过时）
  }) { super(options.message); }
}

export interface UpstreamAdapter {
  readonly type: string;

  listDomains(cfg: UpstreamConfig): Promise<DomainInfo[]>;

  createMailbox(cfg: UpstreamConfig, req: CreateMailboxRequest): Promise<MailboxRef>;

  /** 删除上游侧邮箱；上游不支持时抛 CAPABILITY_MISSING */
  deleteMailbox(cfg: UpstreamConfig, ref: MailboxRef): Promise<void>;

  listMessages(cfg: UpstreamConfig, ref: MailboxRef, opts?: {
    since?: string;                    // 游标：只返回晚于该消息 ID/时间的
  }): Promise<MessageSummary[]>;

  getMessage(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<MessageDetail>;

  deleteMessage?(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<void>;

  /** 原始报文（含附件），附件代理依赖它；可选能力 */
  getSource?(cfg: UpstreamConfig, ref: MailboxRef, messageId: string): Promise<Uint8Array>;

  /** 透传凭证注入：返回要写入转发请求头部的上游鉴权头；未实现 = 该类型不支持透传（501） */
  authHeaders?(cfg: UpstreamConfig): Record<string, string>;

  /** 透传副作用观察：识别"经透传创建/删除了邮箱"的响应，网关据此自动登记/注销注册表 */
  inspectPassthrough?(input: {
    method: string; path: string; status: number;
    requestBodyText?: string; responseBodyText?: string;
  }): { action: "created"; ref: MailboxRef } | { action: "deleted"; upstreamMailboxId: string } | null;

  /** 透传列表过滤：GET 枚举型端点按调用方可用域名改写响应；返回 null 表示不改 */
  filterPassthroughList?(input: {
    path: string; responseBodyText: string;
    isDomainAllowed: (domain: string) => boolean;
  }): string | null;
}
```

设计说明：

- **cfg + ref 全部显式传参**：适配器可被并发用于多个上游实例，也方便测试时直接构造假 cfg。
- **可选能力用 `?` 方法 + CAPABILITY_MISSING**：网关层先查 `deleteMessage in adapter` 决定返回 501 还是透传，不靠配置文件声明能力。
- **出网请求走注入的 `fetch`**：适配器构造函数接收 `deps: { fetchFn, logger }`，默认 `globalThis.fetch`。这是将来做代理池/IP 轮换、以及录制回放测试的钩子。
- **契约测试**：`test/contract/` 提供一套所有适配器必须通过的用例（创建→列域名→收件→详情→删除），Dummy 适配器在 CI 里跑它，真实适配器接入时直接复用，保证行为一致。

## 6. 存储抽象与数据模型

### 6.1 Store 接口（ports/stores.ts）

```ts
// ⚠️ 以下为当前真实签名（以 src/ports/stores.ts 为准；旧版本文档写的
// replaceDomains(domains: string[])、create(name)、revoke(id)、listByApiKeyScope
// 均已过时：前者收 DomainRow[]、create 收 6 字段对象、吊销即硬删除 delete(id)）。

export interface UpstreamStore {
  create(input: NewUpstream): Promise<UpstreamRow>;
  update(id: string, patch: Partial<Pick<UpstreamRow, "name" | "baseUrl" | "apiKeyEnc" | "settingsJson" | "enabled">>): Promise<void>;
  delete(id: string): Promise<void>;                 // 级联删 domains/health_checks；有存活 mailbox 时抛 UPSTREAM_IN_USE
  get(id: string): Promise<UpstreamRow | null>;
  list(): Promise<UpstreamRow[]>;
  listEnabled(): Promise<UpstreamRow[]>;
  /** 差异化同步（不整表重插）：保留存活域名的 enabled；复合主键下不会误删其他渠道同名行 */
  replaceDomains(upstreamId: string, domains: DomainRow[]): Promise<void>;
  listDomainsByUpstream(upstreamId: string): Promise<DomainRow[]>;
  countDomains(upstreamId: string): Promise<number>;
  /** 某域名的全部登记行（多渠道共享域名时的全部候选，升序）；选主在 core/routing 层 */
  listUpstreamsByDomain(domain: string): Promise<UpstreamWithDomain[]>;
  getDomain(upstreamId: string, domain: string): Promise<DomainRow | null>;
  listActiveDomains(): Promise<UpstreamWithDomain[]>;
  listAllDomains(): Promise<UpstreamWithDomain[]>;
  setDomainEnabled(upstreamId: string, domain: string, enabled: boolean): Promise<boolean>;
  setAllDomainsEnabled(upstreamId: string, enabled: boolean): Promise<number>;
  countMailboxes(upstreamId: string): Promise<number>;
}

export interface MailboxStore {
  create(input: NewMailbox): Promise<MailboxRow>;
  get(id: string): Promise<MailboxRow | null>;
  findByAddress(address: string): Promise<MailboxRow | null>;
  findByUpstreamMailboxId(upstreamId: string, upstreamMailboxId: string): Promise<MailboxRow | null>;
  delete(id: string): Promise<void>;
  deleteExpired(before: Date): Promise<number>;      // 只删网关记录，不触碰上游
  list(opts?: MailboxListFilter & { limit?; offset? }): Promise<MailboxRow[]>;
  count(opts?: MailboxListFilter): Promise<number>;  // 与 list 同口径，否则分页总数对不上
}

// 列表过滤：apiKeyId 为严格相等，includeShared 才并入 apiKeyId 为 null 的透传登记记录
interface MailboxListFilter {
  upstreamId?: string; apiKeyId?: string;
  includeShared?: boolean; includeExpired?: boolean; now?: Date;
}

export interface ApiKeyStore {
  create(input: { id; name; keyHash; prefix; keyEnc; domains; channels }): Promise<ApiKeyRow>;
  verify(keyHash: string): Promise<ApiKeyRow | null>;  // 收已 hash 值；命中时按 60s 节流更新 lastUsedAt
  get(id: string): Promise<ApiKeyRow | null>;
  delete(id: string): Promise<void>;                 // 吊销 = 硬删除（列表不留占位）
  update(id, patch: Partial<Pick<ApiKeyRow, "name" | "enabled" | "domains" | "channels">>): Promise<ApiKeyRow | null>;
  list(): Promise<ApiKeyRow[]>;
}

export interface HealthStore {
  insert(check: NewHealthCheck): Promise<void>;
  listByUpstream(upstreamId: string, limit: number): Promise<HealthCheckRow[]>;
  prune(upstreamId: string, keep: number): Promise<void>;
  deleteByUpstream(upstreamId: string): Promise<void>;
}
```

### 6.2 Drizzle schema（SQLite 方言，一份共用）

```ts
export const upstreams = sqliteTable("upstreams", {
  id: text("id").primaryKey(),                       // ULID
  name: text("name").notNull(),                      // 展示名
  type: text("type").notNull(),                      // adapter type
  baseUrl: text("base_url").notNull(),
  apiKeyEnc: text("api_key_enc"),                    // AES-GCM 密文（base64）
  settingsJson: text("settings_json", { mode: "json" }).notNull().default({}),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const domains = sqliteTable("domains", {
  domain: text("domain").notNull(),                  // 小写
  upstreamId: text("upstream_id").notNull().references(() => upstreams.id),
  isPrivate: integer("is_private", { mode: "boolean" }).notNull().default(false),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),  // 管理端调用开关
  syncedAt: integer("synced_at", { mode: "timestamp" }).notNull(),
}, (t) => [primaryKey({ columns: [t.domain, t.upstreamId] }), index("domains_upstream_idx").on(t.upstreamId)]);
// 复合主键 (domain, upstream_id)：同一域名可登记在多个渠道；域名开关逐渠道独立。
// 选主不在存储层：listUpstreamsByDomain 返回全部登记行，由 core/routing.ts 按
// 「key 渠道/域名白名单 × 启用状态」选（见 §7.1 附近的路由说明）。

export const mailboxes = sqliteTable("mailboxes", {
  id: text("id").primaryKey(),                       // 网关 ULID，对外唯一标识
  upstreamId: text("upstream_id").notNull().references(() => upstreams.id),
  address: text("address").notNull().unique(),       // local@domain
  localPart: text("local_part").notNull(),
  domain: text("domain").notNull(),
  upstreamMailboxId: text("upstream_mailbox_id").notNull(),
  credentialsEnc: text("credentials_enc"),           // 加密的 JWT 等
  passwordEnc: text("password_enc"),
  apiKeyId: text("api_key_id"),                      // 哪个调用方建的（软引用）
  webhookUrl: text("webhook_url"),                   // 二期 webhook 用，一期先占位
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),      // SHA-256
  prefix: text("prefix").notNull(),                  // 明文前 8 位，便于列表辨认
  keyEnc: text("key_enc"),                           // 完整明文 AES-GCM 密文；旧 key 为 null（明文不可取回）
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  domainsJson: text("domains_json"),                 // 域名白名单 JSON；null = 不限制
  channelsJson: text("channels_json"),               // 渠道白名单 JSON（上游实例 id）；null = 不限渠道
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// health_checks：健康监控历史（每渠道保留最近 500 条）
export const healthChecks = sqliteTable("health_checks", {
  id: text("id").primaryKey(),
  upstreamId: text("upstream_id").notNull().references(() => upstreams.id),
  checkedAt: integer("checked_at", { mode: "timestamp" }).notNull(),
  status: text("status").notNull(),                  // 'up' | 'down'
  latencyMs: integer("latency_ms"),
  domainsTotal: integer("domains_total"),
  domainsAddedJson: text("domains_added_json"),      // JSON string[]
  domainsRemovedJson: text("domains_removed_json"),  // JSON string[]
  error: text("error"),
  syncAction: text("sync_action"),                   // applied | detected | blocked:<原因>；无差异为 null
}, (t) => [index("health_upstream_idx").on(t.upstreamId, t.checkedAt)]);
```

索引：`mailboxes.upstreamId`、`mailboxes.createdAt`、`domains.upstreamId`、`health_checks(upstreamId, checkedAt)`。

一期**不落消息表**：消息直接从上游代理，不持久化。消息缓存（webhook 重放、OTP 提取的历史）是二期需求，届时新增表即可，不影响现有 schema。

## 7. API 设计

### 7.1 统一邮箱 API（`/v1/*`，Bearer 网关 key 鉴权）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/domains` | 所有启用上游的域名合集（带 `upstreamId`、`upstreamType` 元数据） |
| POST | `/v1/mailboxes` | 创建邮箱。body：`{ domain?, localPart?, expiresInSeconds? }`；`domain` 缺省时由网关在活跃域名中挑选 |
| GET | `/v1/mailboxes` | 列出**本 key 创建的**邮箱（分页，新→旧）。`?limit`（≤100，默认 20）/`?offset`；`?includeExpired=1` 才含已过期；`?includeShared=1` 才含透传登记的共享邮箱 |
| GET | `/v1/mailboxes/:id` | 邮箱详情 |
| DELETE | `/v1/mailboxes/:id` | 删除邮箱。默认严格：上游失败 → 502 且**保留**记录。`?force=1` 尽力删除 → 200 `{deleted, upstreamDeleted, upstreamError?}`，无论上游结果都删记录。上游报「不存在」一律幂等成功（无需 force）；凭证型上游（DuckMail）拒绝 force → 409 `FORCE_DELETE_UNSAFE` |
| GET | `/v1/mailboxes/:id/messages` | 列消息，支持 `?since=<cursor>` 增量拉取；壳子期轮询即够 |
| GET | `/v1/mailboxes/:id/messages/:mid` | 消息详情（text / html / attachments 元数据） |
| DELETE | `/v1/mailboxes/:id/messages/:mid` | 删消息（上游不支持则 501） |
| GET | `/v1/mailboxes/:id/messages/:mid/source` | 原始报文（可选能力，缺失返回 501） |

错误响应统一信封：

```json
{ "error": { "code": "DOMAIN_NOT_ROUTED", "message": "no enabled upstream owns example.com" } }
```

常用 code：`UNAUTHORIZED` / `DOMAIN_NOT_ROUTED` / `MAILBOX_NOT_FOUND` / `MAILBOX_EXPIRED` / `LOCAL_PART_TAKEN` / `UPSTREAM_ERROR`（附上游 `detail`）/ `CAPABILITY_MISSING` / `FORCE_DELETE_UNSAFE`。`UpstreamError.code → HTTP 状态码` 的映射集中在中间件里做一次。

**过期邮箱的读写分档**：`requireMailbox(..., {allowExpired})` 决定是否放行已过期记录。读信/读单封/删单封/原始报文**拒绝**过期记录 → 410 `MAILBOX_EXPIRED`（上游到期即回收，再转发只会拿回一个语义模糊的上游 404 → 502）；查详情与删除自身**放行**，否则用户既看不到状态也删不掉它。租户隔离优先于过期判定——别人的过期邮箱仍报 404，不泄露 ID 存在性。

**读取口径与列表口径刻意不同**：`requireMailbox` 允许任何 key 读 `apiKeyId` 为 null 的共享记录（透传自动登记的邮箱要能被管理），但 `GET /v1/mailboxes` **默认只列出归属自己的**。否则用同一个网关做批量注册时，那些邮箱会灌进普通客户端的列表——批量注册与日常使用应当各用一把 key，列表按 key 隔离是这条隔离的基础。

### 7.2 管理 API（`/admin/*`，admin 会话 cookie 鉴权）

- `POST /admin/session` / `DELETE /admin/session`：`ADMIN_PASSWORD` 环境变量校验，签发/清除 HttpOnly 签名 cookie（SameSite=Lax；配置**显式** CORS 来源时降级为 None+Secure——通配符 `*` 不回显凭证）。会话签名掺入密码摘要，改密码即全量吊销旧会话。登录按来源 IP 限速（10 次/10 分钟）。
- `/admin/upstreams` CRUD；`POST /admin/upstreams/:id/sync-domains`：调 `adapter.listDomains()` 差异化回写 domains 表，返回差异（新增/失效域名）；`GET /admin/upstreams/:id` 详情含域名列表。
- `PUT /admin/upstreams/:id/domains/{domain}`：开关某域名的调用；`PUT /admin/upstreams/:id/domains`：按渠道批量开关（返回受影响数）。
- `PUT /admin/upstreams/:id/monitor`：渠道独立测活间隔 / 关闭监控 / `autoSyncDomains`（false = 域名变动只检测不写注册表）。注意本端点**合并**写入 settings，而 `PUT /admin/upstreams/:id` 是整体替换 settings——后者会抹掉这里配置的监控项。
- `/admin/keys`：签发、列表、`PATCH` 更新（名称/白名单/启停）、`POST …/reveal` 取回明文、`POST …/revoke` = 硬删除。
- `GET /admin/domains`：全量域名（含停用与归属上游，key 域名编辑器候选）。
- `GET /admin/health` + `POST /admin/health/check`：健康状态与手动检测。
- `GET /admin/mailboxes`：邮箱概览（只读，分页 + 按渠道过滤，total 与过滤一致）。
- `POST /admin/mailboxes/prune-expired`：清理已过期的网关记录（**不向上游发请求**，上游到期后自行回收邮箱）；管理端「邮箱概览」页有对应按钮。
- `POST /admin/mailboxes/import`：纳管上游已存在的地址（`{addresses, apiKeyId?}` → `{imported, failed}`，逐地址独立结算）。依赖适配器的可选能力 `resolveByAddress`——只有账号级凭证的上游能实现（cf-temp-email、MoeMail 已实现；DuckMail 因每邮箱独立凭证、YYDS 因缺「地址→账号 id」查询端点，均返回 `CAPABILITY_MISSING`）。**刻意不开在 `/v1`**：cf 的 admin token 是实例级的，自助纳管等于把「读任意已存在地址」发给每把 key。
- `GET /admin/orphan-mailboxes` + `DELETE /admin/orphan-mailboxes/{id}` + `DELETE /admin/orphan-mailboxes`：尽力删除留下的残留（迁移 0007 建 `orphan_mailboxes` 表）。`?force=1` 删除时上游失败即记一条，带上游侧标识供手工清理；上游报「不存在」不记（本来就没了），严格删除被 502 拦下也不记（记录还在）。
- **租户隔离注**：统一 API 的邮箱读取/删除做归属校验（他人 key 的邮箱一律 404，防跨租户读信；透传自动登记的共享邮箱不受限）。
- Admin UI 页面（**React SPA，非 Hono JSX**）：上游列表 + 新建/编辑表单 + 域名同步按钮；域名总览 + 调用开关；key 签发/限制/删除；邮箱概览页（只读）；状态监控页。

### 7.3 上游透传（已实现）

- 路径前缀 `/upstream/{寻址}/**`：整段转发到对应上游。两种寻址：
  - **按实例 ID**：`/upstream/{upstreamId}/**` 精确转发（相比最初设想的裸 `/{upstreamId}/**` 收进了显式命名空间，避免与 SPA 深链和未来顶级路由产生歧义）；
  - **按适配器类型**：`/upstream/{type}/**`（如 `/upstream/moemail`）。单实例直接转发；多实例按域名路由（body 的 `domain` 字段，或 query 中形如邮箱的 `address`/`query` 参数）；无域名时 GET 扇出合并（数组拼接）、DELETE 取第一个 2xx、POST/PUT/PATCH 返回 400 DOMAIN_REQUIRED（防止重复创建的副作用）。类型级响应带 `X-Gateway-Upstream-Id(s)` 与 `X-Gateway-Partial-Failure` 头。
- 鉴权沿用网关 API key（`Authorization: Bearer`）；上游真实凭证由适配器的 `authHeaders(cfg)` 声明并由网关注入，客户端不可见、伪造无效（`X-API-Key`/`x-admin-auth` 等请求头一律剥离重注）。
- 方法、子路径、query string、请求体、响应状态与 body 均原样转发（含 4xx，不做错误信封改写）；逐跳头与网关凭证不外泄。
- 适配器未实现 `authHeaders` 的类型返回 501；单个上游可用 `settings.passthroughEnabled: false` 关闭。
- 透传副作用自动登记：适配器可实现 `inspectPassthrough` 识别"经透传创建/删除了邮箱"的请求，网关自动在注册表登记/注销——原生客户端（如 floatmail）创建的邮箱在管理端邮箱概览可见、统一 API 可管理（两套 API 的邮箱视图一致）。MoeMail 与 YYDS Mail 支持建/删双向观察；cf-temp_email 的删除接口只含上游内部记录 ID，无法映射回注册表，该场景的注销由管理端手动清理或统一 API 删除兜底。
- 已知取舍：透传请求按上游原语义执行（如 MoeMail 的 `expiryTime` 档位白名单会直接 400），不做吸附改写；但网关自身的域名管控（调用开关 / key 白名单）对透传写请求同样前置生效，属网关侧策略而非上游语义改写。

## 8. 安全设计

1. **信封加密**：`MASTER_KEY`（环境变量，32 字节）→ 每条密文独立随机 nonce，AES-256-GCM，存 `iv + ciphertext + tag`。Workers 和 Node 均用 WebCrypto 实现，接口在 `ports/crypto.ts`。
2. **网关 key**：随机 32 字节 base64url，形如 `tmg_xxxxxxxx…`；库中存 SHA-256 hash + 前 8 位 prefix，完整明文用 AES-GCM 加密保存（管理端可随时取回）。校验走常量时间比较。
3. **Admin**：单一密码 + HttpOnly 签名 cookie，登录接口做简单速率限制（内存计数即可，Workers 下单实例内有效，够用）。
4. **XSS**：统一 API 返回的 html 字段是**原样字符串**，由调用方自担；Admin UI 内任何邮件内容一律不直接渲染（一期 admin 页面根本不展示邮件正文，天然规避）。
5. **防滥用（一期做基础）**：按网关 key 的邮箱创建速率限制（简单计数）；备注栏记上游配额。WAF 级防护交给部署平台。
6. **上游可达性风险**：出口 IP 被 WAF 拦是已知风险；`deps.fetchFn` 注入即为将来接代理预留，一期不实现。

## 9. 部署形态

| 形态 | 入口 | 存储 | 配置 |
|---|---|---|---|
| Cloudflare Workers | `src/entries/worker.ts` | D1 binding（wrangler.toml） | vars: `ADMIN_PASSWORD`、`MASTER_KEY`，可选 `ADMIN_CORS_ORIGIN`/`MAILBOXES_PER_KEY_PER_HOUR`/`HEALTH_CHECK_INTERVAL_MS` |
| Docker（**已落地**） | `src/entries/node.ts` | better-sqlite3 文件，落在数据卷 `/data/gateway.db` | env: 同上 + `DATABASE_PATH`/`FRONTEND_DIST`/`PORT` |
| 本地 Node | `src/entries/node.ts`（`@hono/node-server`） | better-sqlite3 文件 | 读根目录 `.env`，真实环境变量优先 |
| Vercel | **未支持**——缺的不是配置文件而是存储实现 | Node 入口的 better-sqlite3 依赖原生模块 + 本地文件，Vercel 文件系统请求间不保留；worker 入口绑的 D1 是 CF 专有 | 若要支持：新增 `adapters/stores/libsql`（Turso：SQLite 协议走 HTTP，迁移文件可复用） |

各入口都只做一件事：把具体 Store 实现和加密实现注入 `createApp(deps)`。核心代码零分支。

**Docker 镜像**：`starsdream666/temp-mail-gateway:v0.1.0`（105MB 压缩 / 339MB 解压）。三阶段构建（后端生产依赖 → 前端 SPA → 精简运行时），基础镜像用 glibc 的 `node:22-bookworm-slim` 而非 Alpine——better-sqlite3 对 glibc 有官方预编译包，Alpine（musl）没有、必须现场 node-gyp 编译。运行时以非 root 用户 `node` 启动，`node_modules/.bin/tsx src/entries/node.ts` 直跑（故 `tsx` 列在 `dependencies` 而非 devDependencies），镜像内不含任何密钥 / `.env` / 测试 / 参考资料。

## 10. 里程碑

### M0：项目壳子（已完成 2026-09-02~05）

- [x] 脚手架：package.json、tsconfig、vitest、wrangler.toml、drizzle.config.ts
- [x] `ports/` 全部接口 + `db/schema.ts` + 迁移
- [x] `crypto.ts` AES-GCM 实现（两端通用）
- [x] D1 / better-sqlite3 共用一套 Drizzle Store 实现（`adapters/stores/drizzle/`）
- [x] Dummy 适配器 + 注册表（现仅测试经 `test/helpers.ts` 显式挂载）
- [x] `core/routing.ts`（域名解析 + 挑选）与 `core/keys.ts`
- [x] `/v1` 全部端点（zod-openapi）+ key 鉴权中间件 + 错误信封
- [x] `/admin` API + 管理后台（上游 CRUD、域名同步、key 管理）
- [x] worker / node 双入口可启动
- [x] 契约测试 + e2e（建 key → 建邮箱 → 假消息 → 读消息 → 删邮箱）
- [x] README（本地启动、部署 Workers 的最小步骤）

### M1：首批真实上游（已完成 2026-09-05，见上）

完成标志：**M0 不含真实上游即可全链路跑通；M1 已接入 4 个真实适配器**（cloudflare_temp_email、MoeMail、YYDS Mail、DuckMail）。接入新真实上游时，除适配器目录本身外零改动。

- [x] cloudflare_temp_email 适配器（管理端 API：`x-admin-auth`；建邮箱/收信/删单封/删邮箱/原始报文，端点以 floatmail 扩展的调用为参考还原）
- [x] MoeMail 适配器（`X-API-Key`；建邮箱含 expiryTime、收信、删邮箱；无单封删除与原始报文 → 能力缺失走 501）
- [x] 契约测试以模拟上游 fetch 覆盖两个适配器（`test/contract/mocks/`）
- [x] 与真实自建实例联调（域名同步、建邮箱、收信、删除全生命周期，2026-09-05 通过）
- [x] MoeMail 有效期同步：expiresInSeconds 可选配置 + 档位就近吸附（1h/24h/3d，**不含 7d**——真实实例拒绝；0=永久只能经 `settings.defaultExpiryMs: 0` 显式表达）+ expiresAt 与上游一致
- [x] 域名调用管控：domains.enabled 开关（管理端 UI / PUT /admin/upstreams/{id}/domains/{domain}，另支持按渠道批量 PUT /admin/upstreams/{id}/domains），停用域名不路由/不列出/创建 403 DOMAIN_DISABLED；重新同步保留停用状态；批量停用渠道域名 ≠ 停用上游实例（前者只挡建箱）
- [x] key 白名单（域名 + 渠道双维度）：api_keys.domains_json / channels_json（null=不限制，channels 为上游实例 id 且校验存在性），/v1/domains 只返回「启用 ∩ 域名白名单 ∩ 渠道白名单」的可用域名，创建校验（DOMAIN_NOT_ALLOWED / CHANNEL_NOT_ALLOWED）+ 随机挑选限定交集；统一 API 与透传写请求双重生效；渠道白名单自动覆盖渠道后续同步的新域名
- [x] 域名总览页（前端）：全渠道域名预览，关键字/层级（顶级/二级/三级…按段数）/顶级域/主域筛选 + 按渠道（上游实例）分组 + 开关 + 渠道批量启用/停用；key 调用限制编辑器同款筛选与一键全选 + 渠道限制
- [x] 上游状态监控：health_checks 表 + 定时探测（Node setInterval 到期扫描，全局默认 5 分钟可调 + 渠道独立间隔；Workers 用 `[triggers]` cron 调 scheduled → runHealthSweep）——存活探测走适配器 listDomains + 域名增删 diff，新渠道自动纳入；GET /admin/health（时间线）+ POST /admin/health/check（手动一轮）；状态监控页条形时间线（存活率/时延/域名变化，不统计请求数）
- [x] 域名变化自动同步（迁移 0006 加 `health_checks.sync_action`）：测活检测到增删后默认直接 `replaceDomains` 收敛注册表，渠道可用 `settings.autoSyncDomains=false` 退回只检测；安全闸 `planDomainSync`（纯函数、单测覆盖）——空列表与超 `max(5, 30%)` 的批量移除只应用新增、保留待移除域名并标记 `blocked:<原因>` 等人工确认，探测失败一律不动注册表；`sync_action` 取值 `applied` / `detected` / `blocked:*`，`GET /admin/health` 用 `pendingSync` 单独暴露待确认项
- [x] YYDS Mail 适配器（`X-API-Key`（AC- 前缀）；按官方 OpenAPI 规范实现：建邮箱含 Idempotency-Key、收信、删单封、删邮箱、原始报文，`{success,data,error,errorCode}` 信封解包，baseUrl 自动归一 `/v1`；expiresAt 缺失时按官方 24h 留存策略推算；2026-09-05 与真实实例联调通过：建/列/删全生命周期 OK，用户 key 的请求可过上游 CF 盾——匿名请求仍被 IP 级拦截）
- [x] DuckMail 适配器（hydra 格式分页域名列表自动翻页；建箱网关代管密码+POST /token 换邮箱 Bearer 凭证；完整能力含原始报文/单封删除；expiresIn 缺省 24h、正数秒自定义；2026-09-05 官方托管 api.duckmail.sbs 真实验证全生命周期通过）
- [x] 内置 Dummy 假上游退出生产适配器列表（仅测试经 test/helpers.ts 显式挂载）
- [ ] mail.tm 适配器（JSON-LD/hydra、JWT 管理、SSE）—— 暂缓，参考项目未覆盖
- [ ] 上游不可用时的降级提示已在创建链路生效（sync warning），列表页展示待前端跟进

### M2：透传与推送

- [x] 原生格式透传 `/upstream/{寻址}/**`（实例 ID 与适配器类型两种寻址；任意方法/query/body 整段转发，凭证注入，列表过滤 + 建删副作用登记，测试覆盖）
- [ ] webhook 回调（mailbox.webhookUrl 已占位）
- [ ] 附件代理（依赖 `getSource`）

### M3：自我托管完善

- [x] Docker 镜像 + compose（2026-09-05，`starsdream666/temp-mail-gateway:v0.1.0` 已推送 Docker Hub；容器内实测迁移/管理登录/SPA/真实上游建箱/重启持久化全通）
- [ ] 配置驱动的通用适配器（JSON 定义请求模板，免代码接入）
- [ ] webmail 只读界面
- [ ] Vercel 形态（需先补 libSQL/Turso store 适配器，见 §9）

## 11. 风险与对策（回顾）

| 风险 | 对策 |
|---|---|
| 上游透传保真度（mail.tm 用 JSON-LD/hydra） | 透传已实现并按类型寻址/合并（见 §7.3）；mail.tm 适配器未接入，JSON-LD/hydra 格式归一到统一 API 由适配器层负责 |
| 数据中心出口 IP 被上游 WAF 拦 | `fetchFn` 注入留代理口子；上线前先小流量验证各上游可达性 |
| 免费上游消亡（1secmail 先例） | 适配器可插拔 + 管理端可禁用；`provider 可用性在接入时重新验证` |
| 批量注册导致上游封 key | 网关层限速；上游配置里记录配额，接近时告警 |
| 域名路由歧义（同一域名多上游） | domains 复合主键 `(domain, upstream_id)` 允许多渠道共享同一域名；选主在 core/routing 层——按 key 白名单 ∩ 启用状态在全部登记行里取最早，域名开关逐渠道独立 |
