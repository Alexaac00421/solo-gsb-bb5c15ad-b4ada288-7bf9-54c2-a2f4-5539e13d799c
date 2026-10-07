# 离线定向赛计时裁决台 —— 单镜像（Node.js + better-sqlite3，本地 SQLite 文件）
FROM node:20-bookworm-slim

# better-sqlite3 附带预编译二进制；保留构建工具链以便无预编译包时从源码初始化
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先拷依赖清单，尽量命中构建缓存（有 lockfile 时 npm ci，否则 npm install 完成依赖初始化）
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# 拷贝应用代码
COPY server.js ./
COPY src ./src
COPY public ./public

# SQLite 数据持久化目录（node 用户可写）
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/app/data/timing.db

EXPOSE 8080

USER node

CMD ["node", "server.js"]
