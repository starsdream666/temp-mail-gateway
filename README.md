# Temp Mail Gateway（临时邮箱聚合网关）

在多个临时邮箱上游服务（mail.tm、cloudflare_temp_email 等）前架一层 API 网关：对外提供**一套统一邮箱 API**，请求按邮箱域名路由到拥有该域名的上游。管理后台可配置上游、同步域名、签发网关 API key。

- 设计文档：[DESIGN.md](./DESIGN.md)
- API 调用指南（适合 AI / 开发者读取）：[API.md](./API.md)
- 前端架构说明：[frontend/ARCHITECTURE.md](./frontend/ARCHITECTURE.md)
- 当前状态：**壳子 + 管理后台 SPA + 4 个真实上游适配器（cloudflare_temp_email、MoeMail、YYDS Mail、DuckMail）+ 统一 API + 原生格式透传 + 域名/渠道管控 + 每 Key 独立限流 + 健康监控（域名自动同步）+ 过期清理 + 地址纳管 + 残留可见性 + Docker `v0.2.5`**。前后端 typecheck 干净。cf 适配器已按 v1.9.0 实测修正 MIME/分页/`address_id`。
- 开源协议：[MIT](./LICENSE)；第三方依赖声明：[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)

## 快速开始（Docker，推荐）

镜像：[`starsdream666/temp-mail-gateway`](https://hub.docker.com/r/starsdream666/temp-mail-gateway)（默认使用 `latest`，每次 `main` 发布后更新；固定版本请使用镜像库中已发布的版本标签）



```bash
cp .env.example .env          # 填写 MASTER_KEY（≥16 字符随机串）与 ADMIN_PASSWORD
docker compose up -d          # 管理后台 + API 在 http://127.0.0.1:8787
```

或不用 compose：

```bash
docker run -d --name temp-mail-gateway \
  -p 127.0.0.1:8787:8787 -v tmg-data:/data \
  -e MASTER_KEY=$(openssl rand -base64 32) \
  -e ADMIN_PASSWORD=your-strong-password \
  starsdream666/temp-mail-gateway:latest
```

- 镜像**不含任何密钥**，`MASTER_KEY` / `ADMIN_PASSWORD` 运行时注入，缺失则启动即退出。
- 数据库落在数据卷 `/data/gateway.db`（`DATABASE_PATH` 可改），迁移在启动时自动执行，容器重建不丢数据。
- compose 默认只绑 `127.0.0.1`：管理后台虽有登录密码，仍建议放在反向代理（TLS + 访问控制）后再对外。
- 自建镜像（需要代理时）：

  ```bash
  docker build -t starsdream666/temp-mail-gateway:latest \
    --build-arg HTTP_PROXY=http://host.docker.internal:7890 \
    --build-arg HTTPS_PROXY=http://host.docker.internal:7890 .
  ```

  宿主机的 `127.0.0.1` 在构建容器里不可达，必须写 `host.docker.internal`。若 better-sqlite3 的 GitHub 预编译包下不来，加 `--build-arg BETTER_SQLITE3_MIRROR=https://registry.npmmirror.com/-/binary/better-sqlite3`。

## GitHub Actions 自动构建与发布

工作流位于 [`.github/workflows/docker.yml`](./.github/workflows/docker.yml)，构建目标为 `linux/amd64`。它先执行前后端类型检查和前端构建，再启动真正构建出的 Docker 镜像，验证 SQLite 迁移、登录、全局设置、Key 限流、静态资源和 API。只有这些检查通过后，才推送同一个已测试的镜像。

首次在 GitHub 仓库 **Settings → Secrets and variables → Actions → New repository secret** 中配置：

| Secret | 内容 |
|---|---|
| `DOCKERHUB_TOKEN` | `starsdream666` 的 Docker Hub 访问令牌，需要有目标镜像仓库的读写权限 |

Docker 用户名和镜像名已写入工作流的非敏感配置。令牌仅交给 `docker/login-action`，不进入构建参数、镜像、源码或日志；GitHub 托管 runner 使用自身网络，不需要本地 7890 代理。

| 触发事件 | 行为 |
|---|---|
| 提交至 `main` | 检查、构建并发布 `latest`、`main`、`sha-<短提交号>` |
| 推送 `v*` 版本标签 | 校验标签与 `package.json` 版本一致，发布原始标签（如 `v0.2.5`）、完整版本号（`0.2.5`）、主次版本号（`0.2`）、SHA 标签；正式版本同时更新 `latest`，预发布版本不更新 `latest` |
| 向 `main` 提交 PR | 类型检查、构建和冒烟验证，不登录 Docker Hub、不推送镜像 |
| Actions 页面手动运行 | 默认只验证；在 `main` 或版本标签上勾选 `publish` 后才推送 |

发布版本前同步更新 `package.json`、`package-lock.json` 与服务端版本号（`src/core/app.ts`），提交后推送相应 `v<版本号>` 标签。工作流会拒绝版本不一致的发布。

GitHub Actions 使用固定提交 SHA 的第三方 Action，由 Dependabot 每周检查更新。

## 快速开始（本地 Node）

```bash
npm install                 # 后端依赖
npm run frontend:install    # 前端依赖
npm run frontend:build      # 构建管理后台到 frontend/dist（后端会自动托管）

npm run dev                 # 管理后台 + API 都在 http://localhost:8787
```

配置读自根目录 `.env`：**没有现成的 `.env`**，首次使用先 `cp .env.example .env` 并填写 `MASTER_KEY` / `ADMIN_PASSWORD`（本地开发可直接用示例值）；**真实环境变量优先于 `.env`**，部署时用环境变量或 secret 覆盖即可。任何终端（PowerShell / CMD / Git Bash）都只需 `npm run dev`，无需 `VAR=value` 前缀语法。

- 管理后台：<http://localhost:8787/>（默认密码见 `.env` 的 `ADMIN_PASSWORD`）
- 管理后台 API 调用说明：登录后打开侧栏“API 调用”（位于“状态监控”下方）
- OpenAPI 文档：<http://localhost:8787/api/doc> ，Swagger UI：<http://localhost:8787/api/ui>
- 未执行 `frontend:build` 时后端自动退化为纯 API 模式，`/` 返回服务信息 JSON。

## 全局设置

登录后打开侧栏「全局设置」（`/settings`），可修改管理员密码、过期邮箱自动清理、自动验活开关、默认验活间隔、每个 Key 的默认并发请求上限和每小时建箱上限。后台保持仅密码登录。配置保存在数据库，重启后保留；保存后新的请求和下一轮巡检读取最新设置，无需重启。

- 生效优先级：渠道 / Key 单独设置 → 数据库中的全局设置 → 环境变量 → 内置默认值。
- 验活间隔允许 60–86400 秒；关闭全局自动验活会暂停全部定时检查，仍可手动「立即检测」。Node 每分钟扫描一次；Workers 受部署的 Cron 调度频率约束（当前每分钟），页面修改间隔不会修改 Cron。
- **过期邮箱自动清理默认关闭**，只删除「邮箱概览」中的网关记录，不调用上游删除接口；未过期和长期有效（无到期时间）的邮箱会保留。开启后可选「按间隔清理」（60–86400 秒，默认 1 小时）或「过期立即清理」。启用或修改清理设置后，首次检查先执行一次；间隔模式的上次清理时间保存在数据库，重启和多实例不会重置计时。
- Node/Docker 每秒检查清理任务，立即模式通常在过期后 1 秒内处理；Workers 的 Cron 每分钟检查，访问邮箱概览也会检查是否需要清理，实际执行精度受 Cron 调度影响。清理独立于渠道验活，无需页面保持打开；已打开的邮箱概览在启用自动清理时每 5 秒刷新一次，页面隐藏时暂停刷新。
- 默认并发上限为 `0`（不限，兼容旧行为）。正整数限制每个 Key 同时执行的请求数，统一 API 与上游透传合计；超限返回 `429 RATE_LIMITED`。完成、失败或取消响应流后释放名额。
- 默认每小时建箱上限为 `60`（环境变量可覆盖）；`0` 为不限，仅针对 `POST /v1/mailboxes`。修改默认值不会重置本小时的已用次数。
- API Keys 的签发和「调用限制」均支持独立的并发上限及建箱限额：跟随系统默认 / 自定义 / 不限制。并发计数与建箱计数按 Node 进程或 Workers isolate 分别计算，多实例之间不共享额度。
- 修改密码需验证当前密码；新密码至少 8 字符，使用随机盐 PBKDF2 摘要存储，不会在设置接口回传。修改后所有旧会话失效，需要重新登录。在后台改密后，保存的密码优先于 `ADMIN_PASSWORD`；该环境变量仍用于首次登录及作为部署必填项。`MASTER_KEY`、数据库路径、服务端口等部署配置仍通过环境变量管理。

升级包含迁移 `0009_global_settings.sql` 和 `0010_mailbox_auto_cleanup.sql`（清理设置、持久化调度时间及到期索引）。Node/Docker 用新代码启动时自动执行；Workers 在发布新代码前运行 `npx wrangler d1 migrations apply DB --remote`。修改本地代码不会更新 Docker Hub 已发布的镜像，Docker 部署需重新构建镜像。旧 Key 新增的并发字段为 `null`，继承全局默认。

## 上游状态监控（存活 + 域名变化）

Node/Docker 部署自带**定时健康监控**：每 60 秒扫描一次各渠道是否到期，到期才探测——全局默认间隔 5 分钟（`HEALTH_CHECK_INTERVAL_MS` 可调），**每个渠道可在状态监控页单独设置频率或关闭监控**（下限 1 分钟）；服务启动 10 秒后跑首轮：

- **存活探测**：调用各适配器的域名列表端点（轻量、公开），同时验证凭证与响应形状；失败记录错误信息；
- **域名变化：默认直接同步进注册表**（上游新增的域名立刻可用，已下架的域名立刻从域名列表消失）。上游已下架的域名留在表里也建不出邮箱，只会污染域名下拉与 Key 白名单选择器，所以检测到即收敛。每个渠道可在状态监控页取消勾选「自动同步域名变动」退回只检测不改；
- **新渠道自动纳入**：每轮遍历全部启用实例，接入新上游即自动进入监控；
- 结果写入 `health_checks` 表（每渠道保留最近 500 条），管理后台「状态监控」页以**条形时间线**展示每渠道存活历史、存活率、时延与域名变化（并标明该次差异是「已同步到域名列表」还是「仅检测」）；
- 页面提供「立即检测」手动触发（`POST /admin/health/check`）；只监控存活，不统计请求次数。

### 自动同步的安全闸（不可关闭）

自动同步只在"上游的回答可信"时才动注册表。以下两种情况**只应用新增、保留待移除域名**，并在状态监控页显示「未自动应用 + 确认并同步」按钮，等人工确认：

| 情况 | 判定 | 理由 |
|---|---|---|
| 上游返回空域名列表 | `fetched` 为空而注册表非空 | 上游故障、凭证失效、WAF 拦截页都可能让域名端点返回空数组——不能因此清空注册表 |
| 一次性移除过多 | 移除数 > `max(5, 注册数 × 30%)` | 拦的是"上游返回了残缺列表"这类故障；真实的批量下架点一次确认即可 |

另外两条硬规则：**探测失败（status=down）时绝不改注册表**（拿不到列表 ≠ 上游没有域名）；同步只替换域名集合，**不会重置管理员对单个域名设置的调用开关**（存活下来的域名保留其 enabled 状态）。

自动同步不影响存量邮箱：域名从注册表移除后，该域名下已创建的邮箱仍可正常读信与删除（统一 API 的读写按邮箱记录寻址，不查域名表），只是不能再用它建新邮箱——而上游已经下架了这个域名，本来也建不出来。

Workers 部署没有常驻定时器：已内置 `scheduled` 处理函数并按 `wrangler.toml` 的 `[triggers]` cron（默认每分钟）执行到期扫描——扫描只探测"超过自身有效间隔"的渠道，渠道仍可在状态监控页单独调频率或关闭。任意部署形态下都可用状态页的「立即检测」（`POST /admin/health/check`）手动触发一轮。

**请求配额提示**：每次探测 = 1 次对上游的请求。若上游部署在 Cloudflare 免费版（每日 10 万请求），默认 5 分钟/轮 ≈ 288 次/天/渠道（约 0.3% 配额）；把自托管渠道的频率调到 30 分钟/轮则仅 ≈ 48 次/天。官方托管渠道（如 YYDS Mail）不消耗你的配额。

### 前端热重载开发

改前端代码时用两个进程，Vite 把 `/admin`、`/api` 代理到 8787：

```bash
npm run dev             # 终端 1：后端
npm run frontend:dev    # 终端 2：前端 (5173)
```

访问 <http://localhost:5173>。改完后 `npm run frontend:build` 让后端托管构建产物。
- 环境变量：

| 变量 | 必填 | 说明 |
|---|---|---|
| `MASTER_KEY` | 是 | AES-256-GCM 主密钥（任意 ≥16 字符机密串），用于加密上游 key 与邮箱凭证 |
| `ADMIN_PASSWORD` | 是 | 管理端登录密码 |
| `DATABASE_PATH` | 否 | SQLite 文件路径，默认 `./data/gateway.db`（启动时自动跑 `migrations/`） |
| `FRONTEND_DIST` | 否 | 管理后台构建产物目录，默认 `./frontend/dist`；不存在则为纯 API 模式 |
| `ADMIN_CORS_ORIGIN` | 否 | 前端独立域名部署时填其来源（逗号分隔或 `*`）；同域托管/走 Vite 代理不用配 |
| `PORT` | 否 | 默认 8787 |
| `MAILBOXES_PER_KEY_PER_HOUR` | 否 | 每 key 每小时邮箱创建请求的初始默认上限，默认 60，0 = 不限；后台全局设置或单个 Key 可覆盖 |
| `MAX_CONCURRENT_REQUESTS_PER_KEY` | 否 | 每 Key 初始默认并发上限，默认 0（不限），后台可覆盖 |
| `HEALTH_CHECK_INTERVAL_MS` | 否 | 初始默认验活间隔（毫秒），默认 300000；后台可覆盖 |

### 每个 Key 独立限流

在管理后台「API Keys」页，签发新 Key 或点击已有 Key 的「调用限制」，即可设置「邮箱创建限流」：

- **跟随系统默认**：优先使用「全局设置」的值，否则使用 `MAILBOXES_PER_KEY_PER_HOUR`，未设置时为每小时 60 次；旧 Key 升级后保持此模式。
- **自定义上限**：填写正整数，例如测试 Key 每小时 10 次、生产 Key 每小时 300 次，额度分别计数。
- **不限制**：该 Key 不受网关的邮箱创建次数限制。

列表显示实际生效的上限，并标明是否继承系统默认。保存后下一次请求生效，无需重启；修改上限保留当前窗口内的已用次数，包括不限流期间的创建请求。

管理接口 `POST /admin/keys` 与 `PATCH /admin/keys/{id}` 支持 `mailboxesPerHour`：正整数为自定义上限，`0` 为不限，`null` 为继承默认；创建时省略表示继承，更新时省略表示保持原值。响应同时返回 `mailboxesPerHour` 与实际生效值 `effectiveMailboxesPerHour`。

```bash
# 将已有 Key 设置为每小时最多 120 次邮箱创建请求（需先登录取得 cookies.txt）
curl -X PATCH "$BASE/admin/keys/{id}" -b cookies.txt \
  -H 'Content-Type: application/json' -d '{"mailboxesPerHour":120}'
```

限流作用于 `POST /v1/mailboxes`；超限返回 `429 RATE_LIMITED`。通过鉴权和参数校验、被限流器放行的创建请求即计数，后续域名或上游错误不会退还次数；读信、查询及原生 API 透传不消耗此额度。计数仍采用内存固定窗口，从每个 Key 首次创建请求起计一小时；进程重启会清空计数，Workers 下各 isolate 独立计数。

升级包含迁移 `0008_api_key_rate_limit.sql`。Node/Docker 使用新代码启动时自动执行；Cloudflare Workers 部署新代码前先运行 `npx wrangler d1 migrations apply DB --remote`。现有 Key 的值为 `null`，沿用原来的默认上限。

### 首次配置（用 curl 或 Swagger UI）

```bash
BASE=http://localhost:8787

# 1. 登录（写 cookie 到本地）
curl -s -X POST $BASE/admin/session -H 'Content-Type: application/json' \
  -d '{"password":"dev-admin"}' -c cookies.txt

# 2. 建一个上游（DuckMail 支持匿名系统域名，无需 apiKey），创建时自动同步域名
curl -s -X POST $BASE/admin/upstreams -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"name":"DuckMail","type":"duckmail","baseUrl":"https://api.duckmail.sbs"}'

# 3. 签发网关 key（明文加密存储，之后可随时 POST /admin/keys/{id}/reveal 取回）
curl -s -X POST $BASE/admin/keys -b cookies.txt -H 'Content-Type: application/json' -d '{"name":"me"}'
# → {"key":{"key":"tmg_xxx...","prefix":"tmg_xxx",...}}

# 4. 用网关 key 创建邮箱并收信（验证码邮件到达后 GET /v1/mailboxes/{id}/messages 读取）
curl -s -X POST $BASE/v1/mailboxes -H "Authorization: Bearer tmg_xxx" \
  -H 'Content-Type: application/json' -d '{"domain":"duckmail.sbs"}'

# 5. 列出这把 key 名下的邮箱（换设备/清缓存后找回；默认不含已过期与透传共享的）
curl -s "$BASE/v1/mailboxes?limit=20" -H "Authorization: Bearer tmg_xxx"

# 6. 删除邮箱：默认严格（上游失败即 502 且保留记录）；?force=1 为尽力删除
curl -s -X DELETE "$BASE/v1/mailboxes/{id}?force=1" -H "Authorization: Bearer tmg_xxx"
# → {"deleted":true,"upstreamDeleted":true}
#   上游删不掉时 upstreamDeleted=false 并附 upstreamError，网关记录仍会移除
```

### 纳管上游已有的邮箱地址

客户端从「直连上游」切到「走网关」时，上游早已存在的邮箱不在网关注册表里，统一 API 读不到它们。管理后台「邮箱概览」页的**纳管已有地址**可以把它们补登记进来（也可直接调 `POST /admin/mailboxes/import`，body `{addresses: [...], apiKeyId?}`）：

- 逐地址独立结算，一个失败不影响其余（返回 `{imported, failed}`，`failed` 里带 code 与中文原因）；
- 按域名解析归属渠道后，调适配器**反查上游确认该地址真的存在**才登记，顺带回填上游的权威到期时间；
- `apiKeyId` 缺省登记为共享邮箱（任何 key 可读、默认不进列表），指定后只对该 key 的 `GET /v1/mailboxes` 可见；
- **DuckMail 无法纳管**：它的邮箱操作依赖每邮箱独立凭证（密码建箱时随机生成），事后换不回 token，返回 `CAPABILITY_MISSING`。YYDS Mail 同样未实现——其上游标识是账号 id 且没有「地址 → id」查询端点。

刻意只放管理端而不开在 `/v1`：cf-temp-email 用的是实例级 admin token，网关拿它能读该实例上**任意**地址；若开成 key 自助纳管，等于把「读任意已存在地址」的权限发给每把 key。

### 尽力删除的残留（孤儿记录）

`DELETE /v1/mailboxes/{id}?force=1` 在上游删除失败时仍会移除网关记录，此时上游那个邮箱可能还在。这类残留会记入 `orphan_mailboxes` 并在「邮箱概览」页顶部以告警块列出，带**上游侧标识**（cf 是地址本身、MoeMail 是 uuid）——手工清理时正是靠它定位。清理完成后可逐条或整体消账（`DELETE /admin/orphan-mailboxes/{id}` / `DELETE /admin/orphan-mailboxes`）。

上游报「不存在」不算残留（本来就没了，无需清理）；严格删除（不带 force）被 502 拦下时也不算——记录还在，谈不上孤儿。

### 邮箱列表的归属口径

`GET /v1/mailboxes` **只返回调用方 key 自己创建的邮箱**。这条隔离让「批量注册」与「日常使用」各用一把 key 即可互不可见——批量注册的邮箱不会出现在日常客户端的列表里。两个例外都需要显式开启：`?includeShared=1` 并入经透传自动登记的共享邮箱（它们没有归属 key），`?includeExpired=1` 并入已过期记录。

注意读取单个邮箱（`GET /v1/mailboxes/{id}`）比列表宽松：共享邮箱任何 key 都能读，这样透传创建的邮箱才能被管理。

## 代码检查

```bash
npm run typecheck
npm run frontend:build
```

## 部署到 Cloudflare Workers

```bash
npx wrangler d1 create temp-mail-gateway     # 把 database_id 填入 wrangler.toml
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put MASTER_KEY
npx wrangler secret put ADMIN_PASSWORD
npm run deploy                                # 自动先构建前端再 wrangler deploy
```

管理后台通过 `wrangler.toml` 的 `[assets]` 托管（`directory = ./frontend/dist`，`binding = ASSETS`）：静态文件由平台前置匹配，未命中的请求进入 Worker——API 路径正常处理，其余路径回退 `index.html` 交给前端路由。

Vercel 形态（复用 worker 入口）为 M3 目标，未验证。

## 前后端接入方式

前端是独立的 React SPA（`frontend/`），与后端**同源部署**，接入点收敛在 `createApp({ assets })` 的 `SpaAssets` 接口里：

| 运行时 | 静态文件 | SPA 回退 |
|---|---|---|
| Node / Docker | `@hono/node-server` 的 `serveStatic` 中间件 | 读 `frontend/dist/index.html` 后内存返回 |
| Workers | 平台 `[assets]` 前置匹配 | Worker 内经 `ASSETS` 绑定取 `index.html` |

路由优先级：静态资源 → API 路由（`/v1`、`/admin`、`/api`）→ SPA 回退。`/v1`、`/admin`、`/api` 前缀下的未匹配路径**始终返回 JSON 错误信封**，不会被回退成 HTML。

## 接入新的上游适配器

1. 新建 `src/adapters/upstreams/<name>/index.ts`，实现 `UpstreamAdapter`（接口见 `src/ports/upstream.ts`）：
   `listDomains / createMailbox / deleteMailbox / listMessages / getMessage` 必选，`deleteMessage / getSource` 可选。
   - 失败一律抛 `UpstreamError`（code + retryable），网关统一转 HTTP 状态码；
   - 适配器无状态，配置和邮箱凭证全部显式传参；出网请求走注入的 `deps.fetchFn`（共享工具见 `adapters/upstreams/_shared/http.ts`）。
2. 在 `src/bootstrap.ts` 注册适配器。

壳子（路由/存储/管理端/统一 API）无需任何改动。

### 已内置的上游类型

| type | 对应服务 | apiKey 含义 | 私有 settings | 说明 |
|---|---|---|---|---|
| `cf-temp-email` | [cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email)（自建实例） | 实例管理员 token（`x-admin-auth`） | 无 | 走管理端 API：建邮箱、收信、删单封、删邮箱、原始报文 |
| `moemail` | [MoeMail](https://github.com/beilunyang/moemail)（自建实例） | MoeMail API Key（`X-API-Key`） | 见下方有效期说明 | 建邮箱、收信、删单封、删邮箱；无原始报文（上游正文以 content/html 内联返回，不提供 RFC822 端点） |
| `yydsmail` | [YYDS Mail](https://vip.215.im/docs)（官方托管或自建部署） | AC- 前缀 API Key（`X-API-Key`） | 无 | 完整能力：建邮箱、收信、删单封、删邮箱、原始报文；baseUrl 填实例根地址（带不带 `/v1` 均可，自动归一） |
| `duckmail` | [DuckMail](https://github.com/MoonWeSif/DuckMail)（官方托管 api.duckmail.sbs 或自建部署） | 可选；dk_ 前缀 API Key（私有域名可见与建箱需要） | 无 | 完整能力：建邮箱（网关代管密码+token）、收信、删单封、删邮箱、原始报文；系统域名可匿名建箱，域名列表自动翻页 |
| `dummy` | 内存态假上游 | 不需要 | `domains: string[]` | **仅供本地开发验证**，不注册进生产适配器列表 |

### MoeMail 有效期（全部可选，最大兼容）

创建邮箱时通过统一 API 传 `expiresInSeconds`（`POST /v1/mailboxes`），不传则依次兜底：上游实例 settings 的 `defaultExpiryMs` → 内置默认 24h——**任何情况下配置都不是必填**。

真实 MoeMail 只接受固定档位（**1h / 24h / 3d / 0=永久**，取自上游源码 `app/types/email.ts` 的 `EXPIRY_OPTIONS`，并对真实实例逐档实测），适配器会把请求值**就近吸附**到档位（如 2h→1h、5 天→3 天，平局取更长档），网关记录的 `expiresAt` 与上游实际有效期保持一致。档位表可用 settings 覆盖：

```json
{ "defaultExpiryMs": 86400000 }                      // 未显式请求时的兜底档位
{ "expiryPresetsMs": [3600000, 86400000, 259200000] }  // 自定义档位表
{ "defaultExpiryMs": 0 }                                 // 该渠道默认建永久邮箱（上游 expiryTime=0）
{ "expiryPresetsMs": [] }                            // 关闭吸附、原样透传（适配接受任意值的分支版本）
```

## 域名管控与 key 白名单（域名 / 渠道）

调用控制均只影响**创建新邮箱**，存量邮箱的收发不受影响。**统一 API（`POST /v1/mailboxes`）与原生格式透传的建箱请求（POST/PUT/PATCH）都会被拦截**——floatmail 等原生客户端走透传，同样受限；GET/DELETE 读信清理不受限。

调用方视角的 `GET /v1/domains` 永远只返回**对该 key 真正可用的域名**：启用域名 ∩ key 域名白名单 ∩ key 渠道白名单，不会列出用不了的域名造成误导。

**邮箱/域名列表同样过滤**：透传 GET 命中"枚举型"端点（适配器通过 `filterPassthroughList` 声明）时，响应按同一套可用域名改写——原生客户端"看到的邮箱和域名"与"能创建的域名"保持一致。已覆盖：MoeMail 渠道的 `GET /api/emails`（邮箱列表）与 `GET /api/config`（`emailDomains` 域名下拉）、Temp 渠道的 `GET /open_api/settings`（`domains`）、YYDS 的 `GET /v1/domains`、DuckMail 的 `GET /domains`。被过滤的邮箱仍可通过统一 API 按邮箱 ID 读取；管理后台不受影响，始终可见全部。

### 域名调用开关（管理端 → 上游详情 / 域名总览）

每个同步到的域名可单独开启/关闭（也可 `PUT /admin/upstreams/{id}/domains/{domain}` body `{"enabled":false}`）；**域名总览页还支持按渠道一键批量开关**（`PUT /admin/upstreams/{id}/domains` body `{"enabled":false}`）。停用后：

- `GET /v1/domains` 不再列出该域名；
- 用该域名创建邮箱返回 `403 DOMAIN_DISABLED`；
- 未指定域名创建时，随机挑选只在启用域名中进行（全部停用则 `400 DOMAIN_NOT_ROUTED`）。

重新同步域名**保留**停用状态（仅对仍然存在的域名）；新同步到的域名默认启用。

> 注意：**批量停用渠道域名 ≠ 停用上游实例**。前者只挡该渠道的建箱请求；后者（上游开关）连透传和读信一起禁掉。两者可独立使用，互不冲突。

### key 白名单：域名 + 渠道（管理端 → API Key 管理）

签发 key 时可勾选**域名白名单**和**渠道（上游实例）白名单**，也可对已有 key 点击「调用限制」修改（`POST /admin/keys` / `PATCH /admin/keys/{id}` 的 `domains` / `channels` 字段）：

- 不传 / 空数组 / `null` = **不限制**，存量 key 迁移后默认不限制；channels 里的 id 必须是已存在的上游实例，未知 id 返回 400；
- 两种白名单同时配置时取**交集**（域名属于渠道 X 且在域名名单内才放行）；
- 配置了限制的 key：
  - `GET /v1/domains` 只返回交集内的启用域名；
  - 创建邮箱：渠道外返回 `403 CHANNEL_NOT_ALLOWED`，域名名单外返回 `403 DOMAIN_NOT_ALLOWED`，域名已停用返回 `403 DOMAIN_DISABLED`；
  - 未指定域名创建时，只在交集内随机挑选。
- **渠道白名单自动覆盖该渠道后续同步的新域名**（域名白名单是静态快照，做不到这一点）——只想限制"用哪个渠道"时优先用渠道白名单。

## 上游原生格式透传（passthrough）

除了统一 API，还可以**直接按上游原生格式**调用——路径前缀 `/upstream/{寻址}` 后面的部分原样转发给对应上游，方法、query、请求体、响应状态与内容都不改写。两种寻址方式：

```bash
# 方式一：按上游 ID 精确调用（ID 在管理后台上游列表 / 详情面板复制）
curl -X POST http://localhost:8787/upstream/$UPSTREAM_ID/api/emails/generate \
  -H "Authorization: Bearer tmg_你的网关key" -H "Content-Type: application/json" \
  -d '{"name":"foo","domain":"rtytr.bond","expiryTime":3600000}'

# 方式二：按适配器类型调用（如 /upstream/moemail、/upstream/cf-temp-email），无需知道 ID
curl -X POST http://localhost:8787/upstream/moemail/api/emails/generate \
  -H "Authorization: Bearer tmg_你的网关key" -H "Content-Type: application/json" \
  -d '{"name":"foo","domain":"rtytr.bond","expiryTime":3600000}'
```

**类型级寻址的路由规则**（同一类型部署了多个上游实例时）：

| 场景 | 行为 |
|---|---|
| 该类型只有一个启用实例 | 全部请求直接转发到它 |
| 非 DELETE 请求携带域名（body 的 `domain`/`address` 字段，或 query 中形如邮箱的 `address`/`query` 参数） | 路由到拥有该域名且开启透传的实例；body 同时带 `domain` 和 `address` 时域名必须一致 |
| GET 且无域名（如列出全部邮箱） | 扇出到开启透传的候选实例并**合并**结果（数组字段拼接），`X-Gateway-Merged-Upstreams` 标记参与数 |
| DELETE（如按 UUID 删邮箱） | 优先用已登记邮箱的 ID/地址确定唯一归属，其次使用唯一域名归属；无法确定或多个实例均匹配时返回 400 `UPSTREAM_REQUIRED`，不会发送删除请求。此时需改用 `/upstream/{上游ID}` |
| POST/PUT/PATCH 且无域名 | 400 `DOMAIN_REQUIRED`（避免一次请求在多个实例重复创建） |

其他规则：

- **鉴权形式兼容**（主 API 与透传一致）：网关 key 可通过 `Authorization: Bearer <key>`、`Authorization: <key>`（裸值）、`X-API-Key`、`X-Admin-Auth`、`X-Gateway-Key` 任一请求头携带；
- 透传额外接受**管理员会话 cookie**——原生客户端（如浏览器扩展）从登录过管理后台的同一浏览器发起时，往往一个 key 头都不带（例如探测上游公开端点 `/open_api/settings`），管理员本人视同可信；
- 上游真实凭证由网关注入，客户端拿不到也伪造不了（伪造的 `X-API-Key`/`X-Admin-Auth` 值无法通过网关 key 校验）；
- 透传是"原样代理"：上游的校验（如 MoeMail 的 `expiryTime` 档位白名单）、错误格式、状态码都原样呈现，不做吸附与错误信封改写；
- 类型级响应带 `X-Gateway-Upstream-Id(s)` 头标明实际服务的实例；部分实例失败时带 `X-Gateway-Partial-Failure`；
- **自动登记**：经透传创建的邮箱会自动进入网关注册表——管理后台「邮箱概览」可见，统一 API 也能读它的收件箱、删除它（与 `POST /v1/mailboxes` 创建的邮箱同一视图）。原生格式删除成功时自动注销（含 204 空响应）；YYDS 的 `success:false` 业务失败保留登记。**MoeMail、YYDS Mail、DuckMail 支持建/删双向自动登记**；cloudflare_temp_email 的删除接口只含上游内部 ID，暂无法自动注销，可在管理后台手动清理。
- **域名管控同样生效**：透传的写请求（POST/PUT/PATCH）会前置校验「域名调用开关 + key 域名白名单 + key 渠道白名单」（域名停用 → 403 `DOMAIN_DISABLED`；域名白名单外 → 403 `DOMAIN_NOT_ALLOWED`；渠道白名单外 → 403 `CHANNEL_NOT_ALLOWED`，请求不会转发到上游）；域名无法解析（body/query 均未携带）或尚未同步进注册表时不拦，保持原样代理语义。
- **类型寻址的候选按 key 渠道白名单收窄（读请求也收）**：`/upstream/{类型}` 的语义是"让网关替我选实例"，因此选主前先过滤到白名单内，全部在名单外 → 403 `CHANNEL_NOT_ALLOWED`。这条对读请求同样生效，原因是不带域名的 GET 会**扇出到该类型全部实例并合并响应**——同一上游软件的两个账户（例如「日常」与「批量注册」各一把上游 key）注册成两个渠道时，合并结果会把另一个账户的邮箱列表泄漏给调用方，而列表过滤按域名工作、区分不出共享同一套域名的两个账户。**按 ID 显式寻址（`/upstream/{上游ID}`）的读请求不受此限**：那是调用方明确指定目标，读存量邮箱不该因白名单调整而中断。
- 单个上游可在 settings 里设 `{"passthroughEnabled": false}` 关闭，按 ID、域名路由和 GET 合并均遵守该开关；适配器不支持透传的类型返回 501。

### 接入 floatmail 浏览器扩展（原生客户端实测）

floatmail 的两个邮箱渠道都可以指向网关的透传地址，"key" 一栏填**网关 key**（不是上游的真实凭证）：

| floatmail 渠道 | API 地址 | 密钥 |
|---|---|---|
| Temp Email（cloudflare_temp_email） | `http://localhost:8787/upstream/cf-temp-email` | 网关 key |
| MoeMail | `http://localtest.me:8787/upstream/moemail` | 网关 key |

注意两点：

1. **MoeMail 渠道不能用 `localhost`**：floatmail 对经 background 代理的请求有 SSRF 防护，硬性拒绝本机/内网主机名（连白名单都只收公网地址）。`localtest.me` 是解析到 127.0.0.1 的公网通配域名，能通过它的字符串级检查、实际仍访问本机网关（已实测）。
2. Temp Email 渠道走的是扩展 popup 的直连请求，`localhost` 可正常使用。
3. **同一上游软件挂了多个账户渠道时，用按 ID 寻址而不是按类型**（`/upstream/{上游ID}`，ID 可在管理后台上游列表复制）。按类型寻址在多实例下会扇出合并或按登记序选主，可能读到另一个账户的数据；配了渠道白名单的 key 已由网关收窄（见上一节），但按 ID 寻址是不依赖白名单配置的确定做法。

## 目录结构

```
src/
├── core/          # createApp 组装、域名路由、key 工具、限速（运行时无关）
├── ports/         # 抽象接口：UpstreamAdapter / Stores / Crypto
├── adapters/
│   ├── registry.ts        # 适配器注册表
│   ├── crypto/webcrypto.ts# AES-GCM 信封加密（两端通用）
│   ├── stores/drizzle/    # D1 + better-sqlite3 共用的 Store 实现
│   └── upstreams/dummy/   # 内置假上游（内存态）
├── api/           # /v1 统一 API、/admin 管理 API、中间件、OpenAPI schema
├── db/            # Drizzle schema + Node 迁移执行器（SQL 在 /migrations）
└── entries/       # worker.ts（Cloudflare）、node.ts（Node/Docker）

frontend/          # 管理后台 SPA（React + Vite），构建产物 dist/ 由后端托管
```

## 前端

管理后台位于 `frontend/`（React 18 + Vite + TypeScript + Tailwind，无状态管理库），共 7 个业务页面 + 登录：上游管理、域名总览、API Keys、邮箱概览、状态监控、API 调用、全局设置。架构与扩展指引见 [frontend/ARCHITECTURE.md](./frontend/ARCHITECTURE.md)。

## 已知边界

- 不持久化消息（实时从上游代理）；webhook、附件代理为二期（`mailboxes.webhookUrl` 已占位）。**上游原生透传已实现**（见上文 passthrough 章节）。
- 邮箱 `expiresAt` 已存储但无过期清理任务（上游到期自行清理后，网关记录会累积，管理端邮箱概览可见僵尸行）。
- `/v1` 邮箱已做归属隔离（key A 建的邮箱 key B 读/删返回 404；透传自动登记的共享邮箱除外）。
- 出口 IP 可能被上游 WAF 拦截；适配器的 `fetchFn` 注入点已为代理预留。
- 限速为单实例内存计数（Workers 下按 isolate 计），多实例部署需换共享存储；登录限速在生产应置于注入真实客户端 IP 的反代之后（见 `clientKeyOf`）。
