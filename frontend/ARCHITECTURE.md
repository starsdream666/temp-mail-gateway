# Temp Mail Gateway - 前端架构与功能接入详细指南

本文档旨在为后续开发者与 AI 模型提供**管理后台单页应用（SPA）**的完整架构设计、模块构造、契约协议以及功能扩展指引。

---

## 1. 架构总览与设计原则

新增 `/settings` 全局设置页（`src/pages/Settings.tsx`），由 `ProtectedRoute` 保护，入口在侧栏「全局设置」。全局监控 / Key 默认限额与密码修改使用独立表单，保存按钮有未修改 / 提交中状态，加载失败可重试。仅提交改动字段；密码变更需当前密码和两次新密码校验，成功后清除登录态并跳回登录页。

认证继续使用密码登录，不引入账号字段。设置调用集中在 `api/client.ts` 的 `getGlobalSettings` / `updateGlobalSettings`，类型为 `GlobalSettings` / `UpdateGlobalSettingsPayload`；服务端 `GET/PATCH /admin/settings` 的响应不包含密码摘要。

Key 表单的 `KeyRateLimitField` 支持建箱次数与并发两种类型，均可继承系统默认、使用自定义上限或不限制。状态监控页的“跟随全局默认”直接使用服务端生效间隔，全局暂停时显示暂停提示。

Temp Mail Gateway 管理后台是一个纯净、轻量且具备高度健壮性的现代化 SPA，设计遵循以下核心原则：

1. **零状态管理库冗余**：
   - 不引入 Redux、Zustand 或 React Query，避免引入不必要的运行时抽象。
   - 全局共享状态（如管理员会话状态）通过 React 原生 Context（`AuthContext`、`ToastContext`）提供；局部页面状态基于 React Hooks（`useState`、`useEffect`、`useCallback`）自闭环管理。
2. **严苛的无 Any 类型约束**：
   - 全工程开启 TypeScript `strict: true`、`noUnusedLocals: true`、`noUnusedParameters: true`。
   - 所有前后端数据交换严格对齐后端 OpenAPI 契约（`src/types/index.ts`），杜绝隐式类型转换。
3. **完善的三态保障（Loading / Error / Empty）**：
   - 任何异步数据呈现均有骨架屏（`TableSkeleton`）或 Spinner。
   - 接口错误统一通过 `ErrorEnvelope` 提取 `message` 渲染并提供重试按钮（`ErrorState`）。
   - 空数据提供场景化的图文说明与引导操作按钮（`EmptyState`）。
4. **防御性交互**：
   - 写操作按钮全链路防重复提交（在 pending 状态下禁用并展示动画）。
   - 破坏性/不可逆操作（删除上游、吊销 API Key）具备强制二次确认（`ConfirmDialog`），标注醒目红色后果。
5. **同源开发，跨域就绪**：
   - 本地开发通过 Vite Proxy 将 `/admin` 与 `/api` 代理到后端网关（`http://localhost:8787`），避免跨域与 Cookie 丢弃问题。
   - 请求客户端内置 `credentials: 'include'`，原生支持基于 `ADMIN_CORS_ORIGIN` 的独立域名跨域部署。

---

## 2. 目录架构与职责划分

```
frontend/
├── index.html                   # HTML 单页入口
├── package.json                 # 依赖声明与 npm scripts
├── vite.config.ts               # Vite 构建、代理与优化配置
├── tsconfig.json                # TypeScript 严格模式配置
├── tailwind.config.js           # Tailwind CSS 配色与排版定制
├── src/
│   ├── api/
│   │   └── client.ts            # 核心网络层：apiFetch 与全部管理端 API 封装
│   ├── types/
│   │   └── index.ts             # 领域实体、请求体、响应体与错误类声明
│   ├── context/
│   │   └── AuthContext.tsx      # 会话认证上下文（登录态探测、401 失效通知）
│   ├── components/
│   │   ├── Layout.tsx           # 后台主布局（响应式侧边栏、移动端汉堡抽屉）
│   │   ├── ProtectedRoute.tsx   # 路由鉴权守卫（未登录自动重定向至 /login）
│   │   ├── Toast.tsx            # 全局 Toast 通知上下文与容器
│   │   ├── Modal.tsx            # 通用居中对话框（支持 ESC 快捷退出、遮罩层）
│   │   ├── ConfirmDialog.tsx    # 危险操作二次确认弹窗
│   │   ├── UpstreamFormModal.tsx# 上游新建/编辑弹窗（集成 Settings JSON 校验）
│   │   ├── CopyButton.tsx       # 剪贴板快速复制按钮（绿色对勾反馈）
│   │   ├── Badge.tsx            # 多色语义化徽章（dot 状态指示器）
│   │   ├── Loading.tsx          # 列表表格骨架屏与居中 Spinner
│   │   ├── EmptyState.tsx       # 引导性空状态组件
│   │   └── ErrorState.tsx       # 错误提示卡片与重试触发器
│   ├── pages/
│   │   ├── Login.tsx            # 管理员登录页（401 内联密码错误展示）
│   │   ├── Upstreams.tsx        # 上游管理页面（列表、状态切换、同步、删除）
│   │   ├── ApiKeys.tsx          # API Key 管理（签发一次性明文展示、吊销）
│   │   └── Mailboxes.tsx        # 临时邮箱概览（上游筛选、翻页分页、地址复制）
│   ├── utils/
│   │   └── format.ts            # 本地时间格式化（ISO 8601 -> YYYY-MM-DD HH:mm）
│   ├── App.tsx                  # 顶级路由与 Context 树组装
│   ├── main.tsx                 # DOM 渲染挂载点
│   └── index.css                # Tailwind 基础与组件层样式
```

---

## 3. 核心机制详解

### 3.1 认证与会话链路

后端采用 HttpOnly Cookie 维持管理员会话，前端逻辑流转如下：

```
                    [ 浏览器启动 / 页面刷新 ]
                               │
                               ▼
                   调用 GET /admin/me 探活
                               │
                ┌──────────────┴──────────────┐
             200 OK                       401 Unauthorized
                │                                     │
                ▼                                     ▼
        AuthContext 认证通过                  未登录 / 会话失效
     放行至受保护后台路由 (/*)             重定向至登录页 (/login)
                                                      │
                                                      ▼
                                            输入密码 POST /admin/session
                                                      │
                                       ┌──────────────┴──────────────┐
                                     204 成功                      401 失败
                                       │                             │
                                       ▼                             ▼
                            Set-Cookie 建立会话            表单内联报「密码错误」
                              跳转至 /upstreams
```

- **401 全局失效截断器**：
  在 `src/api/client.ts` 中的 `apiFetch` 设有全局拦截：
  ```ts
  if (response.status === 401) {
    if (unauthorizedListener) {
      unauthorizedListener(); // 触发 AuthContext 清空登录态，自动将路由踢回 /login
    }
  }
  ```

### 3.2 错误信封处理（ErrorEnvelope）

后端返回的所有非 2xx 响应一律遵循统一的错误信封：
```json
{
  "error": {
    "code": "UPSTREAM_IN_USE",
    "message": "该上游名下仍有 3 个活跃邮箱，请先清理",
    "details": "..."
  }
}
```
- 前端定义了类 `ApiError` 继承自 `Error`，将 `status`、`code`、`message`、`details` 解析后包装抛出。
- 业务页面捕获后优先展示 `err.message`；若需要针对特定状态码做逻辑分支（如 409 冲突拒绝删除），通过 `err.status === 409` 或 `err.code === 'UPSTREAM_IN_USE'` 进行判断。

### 3.3 交互硬性规范对照表

| 业务场景 | 触发动作 | 前端处理规范 |
|---|---|---|
| **登录校验失败** | POST /admin/session 返回 401 | 表单输入框下方直接内联红字提示「密码错误」，不使用全局弹窗，焦点保持在输入框。 |
| **上游启用切换** | 点击 Switch 开关 | 即时触发 `PUT /admin/upstreams/:id { enabled: !curr }`，采用乐观更新，失败时自动回滚并 Toast 报错。 |
| **同步域名** | 点击「同步域名」按钮 | 按钮进入旋转 loading 态；成功后弹出模态框完整呈现 `added`（绿色 tag）、`removed`（红色 tag）、`total`，若存在 `warning` 以警示条呈现。 |
| **删除上游受阻** | DELETE /admin/upstreams/:id 返回 409 | 捕获 409 错误信封，Toast 呈现「该上游名下仍有 N 个邮箱，请先清理」。 |
| **API Key 签发** | POST /admin/keys 返回 201 | 弹出专属模态框展示明文 Key。配置一键复制按钮与强制红色/黄色警告条，说明关闭后不再展示。 |
| **API Key 吊销** | 点击「删除」按钮 | 弹出 `ConfirmDialog`，红字警告不可逆；确认后调用 `POST /admin/keys/:id/revoke`，**硬删除**该 key（立即失效并从列表移除，不留置灰占位）。 |
| **邮箱列表查看** | 查看邮箱地址 | 采用等宽字体展示，紧跟快速复制小图标，点击后变为绿色对勾「已复制」。 |

---

## 4. 数据契约与实体声明 (`src/types/index.ts`)

为了便于其它模型了解字段类型，以下是核心实体汇总：

```typescript
// 适配器元信息
export interface AdapterTypeInfo {
  type: string;                  // 适配器标识，如 'dummy', 'mailtm'
  displayName: string;           // 页面显示的中文名，如 'Dummy（内置假上游）'
  description: string;           // 适配器特性说明
  capabilities: {
    deleteMessage: boolean;      // 是否支持上游删除邮件
    getSource: boolean;          // 是否支持获取 eml 原文
  };
}

// 上游简略信息（列表项）
export interface UpstreamSummary {
  id: string;                    // 上游唯一 ID
  name: string;                  // 上游名称 (1-100 字)
  type: string;                  // 对应 AdapterTypeInfo.type
  baseUrl: string;               // 接口请求基础 URL
  enabled: boolean;              // 启用开关
  hasApiKey: boolean;            // 是否已设置鉴权 Key（防泄漏，不返回明文）
  domainCount: number;           // 当前已同步的域名数量
  createdAt: string;             // ISO 8601 创建时间
}

// 上游详细信息（含 settings 与域名）
export interface UpstreamDetail extends UpstreamSummary {
  settings: Record<string, unknown>; // 适配器私有 JSON 配置
  domains: {
    domain: string;              // 域名，如 'mail.test'
    isPrivate: boolean;          // 是否专属域名
    enabled: boolean;            // 调用开关：false = 已停用（建箱被拒，读信不受影响）
    syncedAt: string;            // ISO 8601 上次同步时间
  }[];
}

// 域名同步结果
export interface SyncDomainsResult {
  added: string[];               // 本次新增域名数组
  removed: string[];             // 本次失效移除域名数组
  total: number;                 // 当前有效总数
  warning?: string;              // 可选的同步部分警告信息
}

// 网关 API Key
export interface ApiKeyInfo {
  id: string;
  name: string;                  // Key 标识名称
  prefix: string;                // Key 前缀，如 'tmg_9x2KqfLm'
  enabled: boolean;              // 是否有效（吊销是硬删除，列表不留"已吊销"占位）
  domains: string[] | null;      // 域名白名单（小写）；null = 不限制
  channels: string[] | null;     // 渠道白名单（上游实例 id）；null = 不限渠道；与域名白名单取交集
  lastUsedAt: string | null;     // 最近一次调用的时间
  createdAt: string;
}

// 签发 Key 成功返回（仅此一次包含明文 key）
export interface CreatedApiKey extends ApiKeyInfo {
  key: string;                   // 完整明文密钥
}

// 临时邮箱记录
export interface Mailbox {
  id: string;
  address: string;               // 完整邮箱地址，如 'user@mail.test'
  localPart: string;             // 前缀部分
  domain: string;                // 域名部分
  upstreamId: string;            // 归属上游 ID
  expiresAt: string | null;      // ISO 8601 到期时间，null 表示永久有效
  createdAt: string;
}
```

---

## 5. 功能接入与扩展指南（针对其它模型/开发者）

### 5.1 如何接入一个新的管理端 API？

1. **在 `src/types/index.ts` 补充契约**：
   声明 Payload 接口及 Response 接口。
2. **在 `src/api/client.ts` 添加端点方法**：
   使用已封装的 `apiFetch<T>` 函数，传入相对路径及 options：
   ```ts
   export async function getSystemMetrics(): Promise<SystemMetrics> {
     return await apiFetch<SystemMetrics>('/admin/metrics');
   }
   ```
3. **在组件或页面中调用**：
   使用 `useState` + `try...catch` 包裹调用，捕获 `ApiError` 并通过 `toast.error(err.message)` 提示。

### 5.2 如何新增一个管理后台页面？

1. **在 `src/pages/` 目录下创建页面组件**（例如 `SystemLogs.tsx`）：
   ```tsx
   import React, { useState, useEffect } from 'react';
   import { TableSkeleton } from '../components/Loading';
   import { EmptyState } from '../components/EmptyState';
   import { ErrorState } from '../components/ErrorState';

   export const SystemLogs: React.FC = () => {
     // 维持 loading / error / empty 三态规范
     return <div className="space-y-6">...</div>;
   };
   ```
2. **在 `src/components/Layout.tsx` 的 `navItems` 中添加导航项**：
   ```ts
   {
     to: '/logs',
     label: '系统日志',
     icon: <FileText className="w-5 h-5" />,
     description: '审计日志与调用轨迹',
   }
   ```
3. **在 `src/App.tsx` 的路由树中注册路由**：
   ```tsx
   <Route path="logs" element={<SystemLogs />} />
   ```

### 5.3 表单编写与校验范式

以 `UpstreamFormModal.tsx` 为基准：
- **前置本地校验**：必填项校验、URL 格式合法性校验、JSON 解析（`JSON.parse`）合法性校验。
- **内联错误显示**：字段下方以 `<p className="mt-1 text-xs text-rose-600">{errors.fieldName}</p>` 实时呈现。
- **后端校验响应映射**：若后端返回 400 校验失败信封，`err.details` 会被解构并填充至 `errors` 状态，就地高亮标红。

---

## 6. 环境与构建命令

```bash
# 进入前端目录
cd frontend

# 安装依赖
npm install

# 启动本地开发服务 (代理到后端 8787 端口)
npm run dev

# 执行 TypeScript 严格类型检查并打包构建
npm run build

# 本地预览打包产物
npm run preview
```

### 环境变量说明
- `VITE_API_BASE_URL`：可选。默认不设置（走同源相对路径或 Vite 代理）。若前端托管在不同于后端的 CDN/域名上，可配置为如 `https://api.gateway.com`，请求将自动发送至目标并携带 HttpOnly Cookie（需配合后端 `ADMIN_CORS_ORIGIN` 配置）。

---

## 7. 与后端的部署接入（已接入，默认同源）

生产环境**默认由后端直接托管本 SPA**，无需独立部署，也不需要配置 CORS：

```bash
npm run frontend:build   # 在仓库根目录执行，产物写入 frontend/dist
```

后端 `createApp({ assets })` 通过 `SpaAssets` 接口消费 `frontend/dist`，两种运行时的差异全部收敛在入口文件：

| 运行时 | 静态文件 | SPA 回退 |
|---|---|---|
| Node / Docker | `@hono/node-server` 的 `serveStatic` | 启动时读入 `dist/index.html` 并内存返回 |
| Cloudflare Workers | `wrangler.toml` 的 `[assets]` 前置匹配 | Worker 内经 `ASSETS` 绑定取 `index.html` |

**路由优先级**（理解这点才能正确新增页面与接口）：

```
静态资源 (/assets/**)  →  API 路由 (/v1、/admin、/api)  →  SPA 回退 (index.html)
```

两条硬性约束：

1. **前端路由路径不得与 API 前缀冲突**。`/v1`、`/admin`、`/api` 是后端命名空间，这些前缀下的未匹配路径**始终返回 JSON 错误信封**而非 `index.html`。因此新增前端页面时，路径不要以这三者开头（现有 `/upstreams`、`/keys`、`/mailboxes`、`/login` 均安全）。
2. 未执行前端构建时（`frontend/dist` 不存在），后端自动退化为纯 API 模式，根路径返回服务信息 JSON。

上述行为由后端测试 `test/e2e/spa-hosting.test.ts` 锁定，修改路由结构后请运行 `npm test` 校验。

### 构建注意事项

`package.json` 的 `build` 脚本前置了 `clean`（`node -e` 删除 `dist`），而非依赖 Vite 的 `emptyOutDir`——后者在 Git Bash / MSYS 环境下删除目录会静默失败并中断构建，导致 `dist` 中堆积多份旧哈希产物。请保持 `vite.config.ts` 中 `emptyOutDir: false` 与 `clean` 脚本的组合。
