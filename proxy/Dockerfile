# zoetrope — 拦截代理 + 多视图 hub
#
# 构建上下文 = 项目根目录（见 docker-compose.yml 的 context: .）
# 依赖清单复用 vendor/Scramjet-App（上游参考实现），只替换 src/ 与 public/。
#
# 出网说明：本机容器可直连 IPv4 国内站点，但 npm registry 在 Cloudflare 上、
# 容器直连不通，因此构建期需要经 HTTP 代理；运行期不需要（见 network_mode: host）。

FROM node:22-bookworm-slim

ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY=""

WORKDIR /app

COPY vendor/Scramjet-App/package.json vendor/Scramjet-App/pnpm-lock.yaml ./

# corepack 自带于 Node 22；pnpm 本体与依赖都经代理下载。
# 注意：只有显式传入代理时才覆盖环境，否则会把 BuildKit 从 buildx 配置
# （DOCKER_CONFIG 里的 "proxies"）注入的代理置空，导致装不上包。
RUN set -eux; \
    if [ -n "$HTTP_PROXY" ]; then \
        export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" no_proxy="$NO_PROXY"; \
    fi; \
    corepack enable; \
    pnpm install --prod --frozen-lockfile; \
    corepack disable; \
    rm -rf /root/.cache/node/corepack

COPY proxy/src ./src
COPY proxy/public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS=--dns-result-order=ipv4first

EXPOSE 8080
CMD ["node", "src/index.js"]
