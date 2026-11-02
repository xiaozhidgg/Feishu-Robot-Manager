# 飞书 DeepSeek 机器人（长连接，无需公网 IP）—— 容器镜像
# 构建：docker build -t feishu-deepseek-bot:1.0 .
# 运行：docker run -d --name feishu-bot --restart unless-stopped \
#         --env-file .env -v "$PWD/docs.json:/app/docs.json:ro" feishu-deepseek-bot:1.0
FROM node:22-alpine

# 国内网络友好：apk / npm 都走国内镜像；镜像不可达时退回默认源，不阻断构建
RUN sed -i 's#dl-cdn.alpinelinux.org#mirrors.aliyun.com#' /etc/apk/repositories \
 && (apk add --no-cache tzdata || true)

WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    npm_config_registry=https://registry.npmmirror.com

# 先装依赖，代码改动时不重复 npm ci
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com && npm cache clean --force

COPY . .

# 机器人只读 docs.json、不写磁盘，用非 root 运行
USER node

# 长连接模式：不监听端口，不需要 -p
CMD ["node", "index.js"]
