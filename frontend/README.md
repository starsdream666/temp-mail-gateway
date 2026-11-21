# 管理后台前端

`frontend/` 是 Temp Mail Gateway 的 React 单页管理后台。生产环境通常由网关后端托管构建产物；也可以单独部署前端并配置 API 地址。

详细模块边界、会话认证与扩展约定见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 当前界面

登录后可使用以下管理页面：

- 上游管理、域名总览、API Key 管理、邮箱概览
- 状态监控、API 调用文档、全局设置

页面路由和侧栏导航分别维护在 `src/App.tsx` 与 `src/components/Layout.tsx`。主题与动效偏好由 `ThemeContext` 管理，并保存在浏览器本地存储中。

## 技术栈

- React 18、React Router 6、Vite 6、TypeScript（严格模式）
- Tailwind CSS 与 Lucide React
- 原生 `fetch` API 客户端：统一处理错误、会话 Cookie 与 401 失效
- 不使用额外的全局状态管理库

## 本地开发

需要 Node.js 22 和 npm。在仓库根目录准备后端配置并启动服务：

```powershell
Copy-Item .env.example .env
npm ci
npm run dev
```

编辑 `.env` 中的 `MASTER_KEY` 和 `ADMIN_PASSWORD`。也可以使用 Bash 的 `cp .env.example .env`。Node 服务读取根目录 `.env`，真实进程环境变量优先。

另开终端启动前端：

```powershell
npm --prefix frontend ci
npm run frontend:dev
```

打开 `http://localhost:5173`。Vite 将 `/admin`、`/api`、`/v1` 和 `/upstream` 路径代理到 `http://localhost:8787`；代理按路径段匹配，不会吞掉 `/api-docs` 等前端路由。也可以在 `frontend/` 目录内运行 `npm run dev`。

默认管理员密码来自后端 `.env` 的 `ADMIN_PASSWORD`。首次登录后可在“全局设置”中更改。

## 构建与部署

```bash
npm run frontend:build
```

构建脚本会先清理 `frontend/dist/`，再运行 TypeScript 检查并生成 Vite 产物。运行 Node/Docker 后端时，默认会托管该目录；部署 Cloudflare Workers 前同样需要先构建前端。若不需要前端，可只运行后端，此时根路径提供服务信息 JSON。

前后端分离时，在**构建前**设置 `VITE_API_BASE_URL`，例如 `https://gateway.example.com`；同源反向代理的路径前缀（例如 `/gateway`）也受支持。该值会写入构建产物，修改后需重新构建。跨域管理请求还需要后端 `ADMIN_CORS_ORIGIN` 配置为前端的确切来源。

本地预览构建结果：

```bash
npm --prefix frontend run preview
```
