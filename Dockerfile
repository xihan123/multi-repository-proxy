# 使用官方 Node.js 22 Alpine 镜像
FROM node:22-alpine

# 安装必要的系统工具
RUN apk add --no-cache \
    dumb-init \
    curl \
    ca-certificates \
    tzdata

# 设置时区
ENV TZ=Asia/Shanghai

# 创建应用目录
WORKDIR /app

# 只复制必要的文件（原生实现不需要package.json中的依赖）
COPY server.js .
COPY package.json .

# 安装 undici 依赖
RUN npm install

# 创建日志目录
RUN mkdir -p logs

# 创建非特权用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

# 更改文件所有权
RUN chown -R nodejs:nodejs /app

# 切换到非特权用户
USER nodejs

# 暴露端口
EXPOSE 3000

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# 使用 dumb-init 启动应用
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]