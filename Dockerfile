# 在岗哨 Presence Beacon
# 纯 Node + SQLite，无原生依赖，无需编译

FROM node:22-alpine

# node:sqlite 还是实验特性，会刷一屏 ExperimentalWarning
ENV NODE_OPTIONS="--disable-warning=ExperimentalWarning"
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV DB_FILE=/data/presence.db

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /data && chown -R node:node /data /app

USER node
VOLUME ["/data"]
EXPOSE 8080

# alpine 里没有 curl，用 node 自己探活
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 必须直接用 node 当 PID 1，才能收到 SIGTERM 优雅退出；别用 npm start
CMD ["node", "server/index.js"]
