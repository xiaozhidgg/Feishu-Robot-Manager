# 飞书 DeepSeek 机器人（长连接，无需公网 IP）—— 容器镜像
# 构建：docker build -t feishu-deepseek-bot:1.0 .
# 运行：docker run -d --name feishu-bot --restart unless-stopped \
#         --env-file .env -v "$PWD/docs.json:/app/docs.json:ro" feishu-deepseek-bot:1.0
FROM node:22-alpine

# 让 TZ=Asia/Shanghai 真正生效（alpine 默认没有 tzdata）
RUN apk add --no-cache tzdata

WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Shanghai

# 先装依赖，代码改动时不重复 npm ci
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# 机器人只读 docs.json、不写磁盘，用非 root 运行
USER node

# 长连接模式：不监听端口，不需要 -p
CMD ["node", "index.js"]
