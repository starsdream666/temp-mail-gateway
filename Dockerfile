# syntax=docker/dockerfile:1
#
# temp-mail-gateway —— Node / Docker 运行形态的镜像。
#
# 三阶段构建：后端生产依赖（含 better-sqlite3 原生编译）→ 前端 SPA 构建 → 精简运行时。
# 构建工具链只存在于前两个阶段，不进最终镜像。
#
# 构建（本机需经代理访问 npm / GitHub prebuild）：
#   docker build -t starsdream666/temp-mail-gateway:v0.2.4 \
#     --build-arg HTTP_PROXY=http://host.docker.internal:7890 \
#     --build-arg HTTPS_PROXY=http://host.docker.internal:7890 .
#
# 运行（MASTER_KEY / ADMIN_PASSWORD 必填，绝不烧进镜像）：
#   docker run -d -p 127.0.0.1:8787:8787 -v tmg-data:/data \
#     -e MASTER_KEY=... -e ADMIN_PASSWORD=... starsdream666/temp-mail-gateway:v0.2.4

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- 阶段 1：后端生产依赖 ----------
FROM ${NODE_IMAGE} AS backend-deps

# 代理只作用于构建期：npm registry 与 better-sqlite3 的 GitHub prebuild 都要出网。
# 宿主机的 127.0.0.1 在容器里不可达，须用 host.docker.internal。
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY="localhost,127.0.0.1"
ENV HTTP_PROXY=${HTTP_PROXY} HTTPS_PROXY=${HTTPS_PROXY} NO_PROXY=${NO_PROXY} \
    http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY} no_proxy=${NO_PROXY}

WORKDIR /app

# 基础镜像选 glibc（bookworm-slim）而非 Alpine：better-sqlite3 对 glibc 提供官方
# 预编译包，经代理直接下载即可，无需在镜像里装 gcc/python 工具链。
# （Alpine 是 musl，没有预编译包，必须 node-gyp 现场编译——慢且易失败。）
# 若 prebuild 下载不通，可改用镜像源：
#   --build-arg BETTER_SQLITE3_MIRROR=https://registry.npmmirror.com/-/binary/better-sqlite3
ARG BETTER_SQLITE3_MIRROR=""
ENV npm_config_better_sqlite3_binary_host_mirror=${BETTER_SQLITE3_MIRROR}

COPY package.json package-lock.json ./
# 只装生产依赖；tsx 已列入 dependencies（本项目以 tsx 直跑 TS 作为生产运行方式）
RUN npm ci --omit=dev --no-audit --no-fund
# 装完立刻自检原生模块可加载，避免把坏掉的 better-sqlite3 带进运行时镜像
RUN node -e "new (require('better-sqlite3'))(':memory:').close(); console.log('better-sqlite3 OK')"

# ---------- 阶段 2：前端 SPA 构建 ----------
FROM ${NODE_IMAGE} AS frontend-build

ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY="localhost,127.0.0.1"
ENV HTTP_PROXY=${HTTP_PROXY} HTTPS_PROXY=${HTTPS_PROXY} NO_PROXY=${NO_PROXY} \
    http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY} no_proxy=${NO_PROXY}

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# build = clean && tsc && vite build（clean 步骤规避了 emptyOutDir 的已知问题）
RUN npm run build

# ---------- 阶段 3：运行时 ----------
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    DATABASE_PATH=/data/gateway.db \
    FRONTEND_DIST=/app/frontend/dist \
    PORT=8787

WORKDIR /app

COPY --from=backend-deps /app/node_modules ./node_modules
COPY package.json LICENSE THIRD_PARTY_NOTICES.md ./
COPY src ./src
COPY migrations ./migrations
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# /data 是数据卷挂载点：先建好并交给 node 用户，命名卷首次挂载会继承此归属
RUN mkdir -p /data && chown -R node:node /data /app

USER node
VOLUME ["/data"]
EXPOSE 8787

# 存活探测走服务自身的信息端点（无需鉴权）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/info').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 直接调 tsx 的 bin（不经 npm 包装），信号能直达进程
CMD ["node_modules/.bin/tsx", "src/entries/node.ts"]
