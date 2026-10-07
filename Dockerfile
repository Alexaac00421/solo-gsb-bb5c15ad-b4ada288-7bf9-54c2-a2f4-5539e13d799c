# 定向赛计时裁决台 · 一体化镜像
# 运行时依赖仅为 Node.js + npm 包（sql.js 为纯 JS/WASM 的 SQLite，无需编译链与外部服务）
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/app/data/timer.db

WORKDIR /app

# 安装依赖（含锁文件，可复现）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 应用代码
COPY src ./src

# 数据目录：SQLite 库文件所在，容器首次启动时自动建表初始化
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

EXPOSE 8080

# 启动即完成数据库初始化（幂等建表）并监听
CMD ["node", "src/server.js"]
