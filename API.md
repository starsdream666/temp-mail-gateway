# Temp Mail Gateway API 调用指南（AI / 开发者版）

> 本文件是项目统一 API 的机器友好参考。实现真值位于 `src/api/v1.ts`、`src/api/schemas.ts` 与 `src/api/middleware/auth.ts`；运行时 OpenAPI 3.1 JSON 位于 `/api/doc`，Swagger UI 位于 `/api/ui`。

## 1. 基本约定

- 默认本地 Base URL：`http://localhost:8787`
- 统一 API 前缀：`/v1`
- 请求与响应默认使用 `application/json`；原始邮件端点返回 `message/rfc822`；删除成功常返回 `204 No Content`。
- 所有 `/v1/*` 请求都需要网关 API Key。推荐：`Authorization: Bearer <API_KEY>`。
- 兼容头：`Authorization: <API_KEY>`（裸值）、`X-API-Key`、`X-Admin-Auth`、`X-Gateway-Key`。
- API Key 在管理后台“API Keys”页签发。Key 可受域名白名单、渠道白名单、每小时建箱上限与并发请求上限共同限制。
- 日期时间均为带时区的 ISO 8601 字符串；`expiresAt` 可能为 `null`。
- 路径参数：`{id}` 是网关邮箱 ID，`{mid}` 是上游邮件 ID；不要把邮箱地址当作 `{id}`。

```bash
BASE=http://localhost:8787
API_KEY=tmg_xxx
curl "$BASE/v1/domains" -H "Authorization: Bearer $API_KEY"
```

## 2. 标准错误

非 2xx JSON 错误使用统一信封：

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "无效的 API key",
    "details": {}
  }
}
```

常见状态码：`400` 参数/路由错误；`401` 无凭证或 Key 无效；`403` 域名或渠道不在 Key 白名单；`404` 资源不存在（也用于租户隔离）；`409` 地址冲突或操作受限；`410` 邮箱已过期；`429` 创建速率或并发超限；`501` 上游缺少能力；`502` 上游请求失败。

## 管理后台全局设置

后台保持**仅密码登录**：`POST /admin/session`，body 为 `{"password":"你的管理员密码"}`。以下接口需要登录后获得的会话 Cookie；网关 API Key 无权修改全局设置。

- `GET /admin/settings` → `{settings: {...}}`，只返回非敏感配置。
- `PATCH /admin/settings` → `{settings: {...}, reauthenticationRequired: boolean}`。只更新提交的字段，未知字段或无效值返回 400。

| PATCH 字段 | 取值与含义 |
|---|---|
| `healthCheckEnabled` | 布尔值，控制全局自动验活，手动检测不受影响 |
| `healthCheckIntervalMs` | 60000–86400000 的整数，未单独配置的渠道使用此间隔 |
| `mailboxesPerKeyPerHour` | 非负安全整数，默认每 Key 每小时建箱次数；0 不限 |
| `maxConcurrentRequestsPerKey` | 非负安全整数，默认每 Key 并发请求数；0 不限 |
| `newPassword` | 8–128 字符的新密码（不能全为空格）；不传则不修改密码 |
| `currentPassword` | 修改密码时必填；校验失败返回 403，并且整次更新不写入 |

修改密码后返回 `reauthenticationRequired: true` 并清除当前 Cookie，所有旧会话立即失效；客户端应提示用新密码重新登录。响应不会回传密码或摘要。普通配置更新返回 `false`，不改变登录状态。保存的配置优先于环境变量；密码未在后台修改前继续使用 `ADMIN_PASSWORD`。

`POST /admin/keys` 和 `PATCH /admin/keys/{id}` 另支持 `maxConcurrentRequests`：`null` 继承全局、`0` 不限、正整数单独设置；省略时创建继承、更新保持原值。Key 响应返回保存值和 `effectiveMaxConcurrentRequests`（实际生效值）。并发额度在 `/v1/*` 与 `/upstream/*` 之间共用，管理员会话透传不占用 Key 额度；计数按 Node 进程 / Workers isolate 分别维护。

## 3. 端点速查

| 方法 | 路径 | 用途 | 成功响应 |
|---|---|---|---|
| GET | `/v1/domains` | 列出当前 Key 可用的启用域名 | `200 {domains}` |
| POST | `/v1/mailboxes` | 创建邮箱 | `201 {mailbox}` |
| GET | `/v1/mailboxes` | 分页列出当前 Key 的邮箱 | `200 {total,mailboxes}` |
| GET | `/v1/mailboxes/{id}` | 获取邮箱详情 | `200 {mailbox}` |
| DELETE | `/v1/mailboxes/{id}` | 删除邮箱 | 严格模式 `204`；force 模式 `200` |
| GET | `/v1/mailboxes/{id}/messages` | 列出邮件摘要 | `200 {messages}` |
| GET | `/v1/mailboxes/{id}/messages/{mid}` | 获取邮件详情 | `200 {message}` |
| DELETE | `/v1/mailboxes/{id}/messages/{mid}` | 删除邮件 | `204` |
| GET | `/v1/mailboxes/{id}/messages/{mid}/source` | 获取 RFC 822 原始报文 | `200 message/rfc822` |

## 4. 域名与邮箱

### GET `/v1/domains`

只返回“启用域名 ∩ Key 域名白名单 ∩ Key 渠道白名单”，共享域名按域名去重。

```bash
curl "$BASE/v1/domains" -H "Authorization: Bearer $API_KEY"
```

```json
{"domains":[{"domain":"duckmail.sbs","upstreamId":"upstream_id","upstreamType":"duckmail","isPrivate":false}]}
```

### POST `/v1/mailboxes`

每个 Key 按自己的每小时上限独立计数，超限返回 `429 RATE_LIMITED`。管理员可在「API Keys → 调用限制」设置正整数上限、不限制或继承系统默认（默认 60 次/小时）。该额度只用于此创建接口，查询和读信不消耗额度。创建请求通过鉴权、参数校验和限流检查后即计数，后续上游失败也会计入。

请求体字段：

- `domain?: string`：目标域名；缺省时从当前 Key 可用域名中自动选择。
- `localPart?: string`：邮箱前缀，最多 64 字符，只允许字母、数字、`.`、`_`、`-`，且首字符必须是字母或数字；缺省时自动生成。
- `expiresInSeconds?: integer`：相对有效期，范围 `1..31536000` 秒；缺省时跟随上游策略或永久。

```bash
curl -X POST "$BASE/v1/mailboxes" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain":"duckmail.sbs","localPart":"demo","expiresInSeconds":3600}'
```

```json
{
  "mailbox": {
    "id": "mailbox_id",
    "address": "demo@duckmail.sbs",
    "localPart": "demo",
    "domain": "duckmail.sbs",
    "upstreamId": "upstream_id",
    "expiresAt": "2026-09-09T12:00:00.000Z",
    "createdAt": "2026-09-09T11:00:00.000Z"
  }
}
```

### GET `/v1/mailboxes`

查询参数：`limit` 默认 20、最大 100；`offset` 默认 0；`includeExpired=true|false|1|0`；`includeShared=true|false|1|0`。默认只列出当前 Key 创建且未过期的邮箱。共享邮箱可被单条读取，但只有显式传 `includeShared=1` 才进入列表。

```bash
curl "$BASE/v1/mailboxes?limit=20&offset=0&includeExpired=0&includeShared=0" \
  -H "Authorization: Bearer $API_KEY"
```

### GET `/v1/mailboxes/{id}`

返回 `{ "mailbox": Mailbox }`。此端点允许查看已过期记录，便于客户端区分“已过期”和“已删除”。

### DELETE `/v1/mailboxes/{id}`

- 默认严格删除：先删上游；上游失败则返回 `502` 并保留网关记录；成功返回 `204`。
- `?force=1` 尽力删除：仍尝试删除上游，但无论结果如何都会删除网关记录，返回 `200 {deleted:true,upstreamDeleted:boolean,upstreamError?}`。
- 上游已经不存在按删除成功处理。依赖每邮箱独立凭证的上游可能以 `409` 拒绝 force，以免永久失去清理上游的凭证。

```bash
curl -X DELETE "$BASE/v1/mailboxes/mailbox_id?force=1" \
  -H "Authorization: Bearer $API_KEY"
```

## 5. 邮件

### GET `/v1/mailboxes/{id}/messages`

可选查询参数 `since=<message_id>` 用于增量拉取。

```bash
curl "$BASE/v1/mailboxes/mailbox_id/messages" -H "Authorization: Bearer $API_KEY"
```

消息摘要字段：`id`、`from`、`to[]`、`subject`、可选 `intro`、`seen`、`hasAttachments`、`createdAt`。

### GET `/v1/mailboxes/{id}/messages/{mid}`

返回 `{message}`。详情在摘要字段之外增加可选 `text`、可选 `html: string[]`、`attachments[]`。附件元数据字段为 `id`、`filename`、`contentType`、`size`；统一 API 当前未提供附件内容下载端点。

### DELETE `/v1/mailboxes/{id}/messages/{mid}`

成功返回 `204`；上游不支持删除邮件时返回 `501`。

### GET `/v1/mailboxes/{id}/messages/{mid}/source`

返回 `Content-Type: message/rfc822` 的二进制原始报文；上游不支持时返回 `501`。

```bash
curl "$BASE/v1/mailboxes/mailbox_id/messages/message_id/source" \
  -H "Authorization: Bearer $API_KEY" \
  -o message.eml
```

## 6. 推荐调用流程

1. 调用 `GET /v1/domains` 获取当前 Key 真正可用的域名。
2. 调用 `POST /v1/mailboxes` 创建邮箱，保存返回的 `mailbox.id`，不要只保存地址。
3. 轮询 `GET /v1/mailboxes/{id}/messages`；需要增量时传上一轮末尾邮件的 ID 作为 `since`。
4. 对目标 `mid` 调用详情端点，优先读取 `text`，没有时再处理 `html[]`。
5. 用完后删除邮箱；自动化清理应先用严格模式，只有明确接受上游残留时才用 force。

轮询建议：使用 2–5 秒间隔并设置总超时；遇到 `410` 立即停止；遇到 `429` 或 `502` 做指数退避；不要并发创建大量邮箱绕过限流。

## 7. JavaScript 示例

```js
const baseUrl = 'http://localhost:8787';
const apiKey = process.env.TMG_API_KEY;

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (response.status === 204) return undefined;
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  return payload;
}

const { mailbox } = await request('/v1/mailboxes', {
  method: 'POST',
  body: JSON.stringify({ domain: 'duckmail.sbs' }),
});
const { messages } = await request(`/v1/mailboxes/${encodeURIComponent(mailbox.id)}/messages`);
```

## 8. Python 示例

```python
import os
import requests

BASE = "http://localhost:8787"
HEADERS = {"Authorization": f"Bearer {os.environ['TMG_API_KEY']}"}

response = requests.post(
    f"{BASE}/v1/mailboxes",
    headers=HEADERS,
    json={"domain": "duckmail.sbs"},
    timeout=15,
)
response.raise_for_status()
mailbox = response.json()["mailbox"]

messages = requests.get(
    f"{BASE}/v1/mailboxes/{mailbox['id']}/messages",
    headers=HEADERS,
    timeout=15,
).json()["messages"]
```

## 9. 透传与管理 API 边界

- `/v1/*` 是稳定、跨上游的统一接口，普通客户端和 AI 集成应优先使用它。
- `/upstream/{上游ID或适配器类型}/*` 是上游原生格式透传，参数、响应和能力随上游变化；真实上游凭证由网关注入。只有必须兼容某上游原生客户端时使用，详见 `README.md` 的“原生 API 透传”。
- `/admin/*` 是管理后台 API，使用签名 HttpOnly Cookie 会话，不应拿网关 API Key 调用，也不应作为普通业务集成接口。
- 管理后台的“API 调用”页面提供人类可读、可复制的示例；`/api/doc` 是自动生成的完整 OpenAPI 真值。

### 管理端 Key 限流配置

使用管理员会话 Cookie 调用 `POST /admin/keys`（签发）或 `PATCH /admin/keys/{id}`（更新），请求体可带 `mailboxesPerHour`：

| 值 | 含义 |
|---|---|
| 正整数 | 该 Key 每小时邮箱创建请求上限 |
| `0` | 不限流 |
| `null` | 继承 `MAILBOXES_PER_KEY_PER_HOUR`（缺省 60） |
| 省略 | 签发时继承默认；更新时保持原值 |

例如 `{"name":"测试客户端","mailboxesPerHour":10}` 签发低额度 Key，或 `{"mailboxesPerHour":null}` 将已有 Key 恢复为系统默认。负数、小数、字符串等非法值返回 `400 VALIDATION_ERROR`。

签发、更新与列表响应中的 Key 都包含 `mailboxesPerHour`（保存值）和 `effectiveMailboxesPerHour`（当前生效值，`0` 为不限）。保存后下一次请求生效，当前一小时窗口内的已用次数保留；不限流期间也计数。计数保存在进程内存中，重启后清空，Workers 的不同 isolate 不共享计数。
