# multi-repository-proxy

多仓库代理服务，支持主流开发包管理仓库的统一代理与转发

## 功能特性

- 支持多种仓库类型：Maven、PyPI、NPM、Go、APT 等
- 可配置多个上游仓库源
- 统一代理入口，简化开发环境配置

## 支持的仓库类型与默认源

- **Maven**：central、apache、google、jitpack、gradle-plugins、spring-plugins、spring-milestones、spring-snapshots
- **PyPI**：official
- **NPM**：official
- **Go**：official
- **APT**：ubuntu、debian

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
node server.js
```

默认监听端口可在 `server.js` 中修改.

### 3. 配置代理

将你的包管理工具的仓库源指向本服务地址. 例如：

- Maven: `http://localhost:端口号/maven/central/`
- NPM: `http://localhost:端口号/npm/official/`
- PyPI: `http://localhost:端口号/pypi/official/`
- Docker: `http://localhost:端口号/docker/dockerhub/`
- Go: `http://localhost:端口号/go/official/`

## 示例地址

你也可以直接使用公共代理服务：

- <https://mirrors-eo.xihan.website>

  全球CDN有限速
- <https://mirrors-cy.xihan.website>

  香港CDN，无限速

常见仓库示例：

- Maven Central: <https://mirrors-eo.xihan.website/maven/central/>
- Google Maven: <https://mirrors-cy.xihan.website/maven/google/>
- JitPack: <https://mirrors-cy.xihan.website/maven/jitpack/>
- Gradle Plugins: <https://mirrors-cy.xihan.website/maven/gradle-plugins/>
- PyPI: <https://mirrors-cy.xihan.website/pypi/official/>
- NPM: <https://mirrors-cy.xihan.website/npm/official/>
- Go: <https://mirrors-cy.xihan.website/go/official/>

## 目录结构

```
.
├── Dockerfile                # Docker 部署文件
├── package.json              # Node.js 项目依赖
├── server.js                 # 主服务端代码
```

## 进阶用法

- 可在 `server.js` 中自定义或扩展仓库源

# 本项目 CDN 加速及安全防护由 Tencent EdgeOne / 慈云数据 赞助

[![EdgeOne](https://edgeone.ai/media/34fe3a45-492d-4ea4-ae5d-ea1087ca7b4b.png)](https://edgeone.ai/zh?from=github)

[![Ciyun](https://www.zovps.com/themes/web/www/upload/local66b59c45243ca.png)](https://www.zovps.com)
