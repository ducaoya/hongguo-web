FROM node:22-alpine

WORKDIR /app

# 依赖为纯 JS（axios 树），直接内置 node_modules，构建零网络依赖
COPY package.json ./
COPY node_modules ./node_modules
COPY server.js ./server.js
COPY vendor ./vendor
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8630

EXPOSE 8630

HEALTHCHECK --interval=60s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1

USER node

CMD ["node", "server.js"]
