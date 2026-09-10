# Temp Mail Gateway - 管理后台前端 (SPA)

本工程是为「临时邮箱聚合网关（Temp Mail Gateway）」量身定制的现代化管理后台单页应用（SPA）。管理员可通过此后台配置上游临时邮箱服务、管理网关 API Key、实时同步域名以及监控全网关邮箱状态。

## 技术栈与设计标准

- **核心框架**：React 18 + Vite 6 + TypeScript (Strict)
- **路由管理**：React Router v6（支持受保护路由守卫）
- **样式方案**：Tailwind CSS（基于靛蓝 indigo-600 主题的现代浅色管理台）
- **图标系统**：Lucide React
- **网络通信**：原生 `fetch` 统一封装（自动捕获 401 会话失效、错误信封解析、加载与错误态规范）

## 目录结构

```
frontend/
├── index.html               # 页面入口
├── package.json             # 依赖与脚本
├── vite.config.ts           # Vite 配置（包含 /admin 与 /api 联调代理）
├── tsconfig.json            # TypeScript 严格模式配置
├── tailwind.config.js       # Tailwind CSS 主题配置
├── src/
│   ├── api/
│   │   └── client.ts        # 统一 apiFetch 封装与 /admin 端点集合
│   ├── types/
│   │   └── index.ts         # 数据实体与错误信封 TypeScript 契约
│   ├── components/
│   │   ├── Layout.tsx       # 响应式侧边栏主布局
│   │   ├── ProtectedRoute.tsx # 路由守卫（未登录自动重定向）
│   │   ├── Toast.tsx        # 全局浮动通知系统
│   │   ├── Modal.tsx        # 通用居中模态框
│   │   ├── ConfirmDialog.tsx# 危险操作二次确认对话框（醒目红色后果提醒）
│   │   ├── UpstreamFormModal.tsx # 上游新建/编辑表单（带 Settings JSON 校验）
│   │   ├── Badge.tsx        # 状态彩色徽章
│   │   ├── CopyButton.tsx   # 一键复制按钮（带成功反馈）
│   │   ├── Loading.tsx      # 表格加载骨架屏与 Spinner
│   │   ├── EmptyState.tsx   # 引导性空状态组件
│   │   └── ErrorState.tsx   # 错误信息展示与重试按钮
│   ├── context/
│   │   └── AuthContext.tsx  # 会话鉴权上下文（HttpOnly Cookie 驱动）
│   ├── pages/
│   │   ├── Login.tsx        # 管理员登录页（401 内联密码错误提示）
│   │   ├── Upstreams.tsx    # 上游管理（核心页面：列表、编辑、同步差异、删除）
│   │   ├── ApiKeys.tsx      # API Key 管理（签发一次性明文展示、吊销）
│   │   └── Mailboxes.tsx    # 临时邮箱概览（上游筛选、地址复制、分页）
│   ├── utils/
│   │   └── format.ts        # 时间格式化工具（ISO 8601 -> YYYY-MM-DD HH:mm）
│   ├── App.tsx              # 路由配置与全局上下文注入
│   ├── main.tsx             # React 渲染入口
│   └── index.css            # 基础样式与 Tailwind 指令
```

## 快速开始

### 1. 启动后端服务

在项目根目录启动网关后端（监听 `http://localhost:8787`）：

```bash
# 在项目根目录下运行
MASTER_KEY=dev-master-key-0123456789 ADMIN_PASSWORD=dev-admin npm run dev
```

### 2. 安装并启动前端开发服务器

在 `frontend/` 目录运行：

```bash
cd frontend
npm install
npm run dev
```

开发服务器启动于 `http://localhost:5173`。Vite 默认通过反向代理将 `/admin` 与 `/api` 转发至 `http://localhost:8787`，彻底避免浏览器跨域与 Cookie 传输问题。

> 提示：也可以在项目根目录下直接使用 `npm run frontend:dev` 启动前端。

### 3. 登录后台

- 打开浏览器访问 `http://localhost:5173`
- 输入密码：首次使用后端环境变量 `ADMIN_PASSWORD`（示例 `dev-admin`）；在「全局设置」修改后使用新密码。后台仅密码登录。
- 点击登录即可进入上游管理后台。

### 4. 生产构建打包

```bash
cd frontend
npm run build
```

产物将输出至 `frontend/dist/`。

## 验收清单覆盖

- [x] **登录与退出**：使用正确密码（`dev-admin`）成功进入后台；错误密码内联展示「密码错误」；支持安全退出。
- [x] **新建上游**：类型通过下拉动态从 `GET /admin/adapter-types` 读取；创建成功后自动同步域名并反馈同步结果。
- [x] **手动同步域名**：点击后显示加载中，完成后弹出详细增删报告（`added` / `removed` / `total` / `warning`），列表域名数即时更新。
- [x] **编辑上游**：未修改 API Key 时留空保持不变（`hasApiKey` 仍为 true）；支持勾选「清除已配置 Key」向后端提交 `null`。
- [x] **Settings JSON 编辑**：内置失焦格式校验与语法报错，防止格式不合法的配置提交。
- [x] **删除上游防护**：二次确认弹窗列出后果，后端因名下有邮箱返回 409 冲突时直接给出清晰友好提示。
- [x] **网关 API Key 签发**：成功签发后弹出模态框，完整展示一次性明文 Key，配备一键复制与高危警告。
- [x] **API Key 吊销**：二次危险确认；吊销 = 硬删除（后端 `POST /admin/keys/:id/revoke`），确认后 key 立即失效并从列表移除（无"置灰占位"）。
- [x] **邮箱概览**：支持按上游服务筛选；支持 50 条分页与上下翻页；邮箱完整地址支持一键快速复制；展示创建时间与到期时间。
- [x] **会话失效机制**：统一 `apiFetch` 拦截 401 响应，自动清空本地会话并跳转至登录页。
- [x] **严格类型检查**：通过 `npm run build`（`tsc && vite build`），0 类型与语法错误。
