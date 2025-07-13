/**
 * 多仓库镜像代理服务（零依赖、原生 Node.js 实现）
 */
const http = require('http');
const https = require('https');
const {parse: parseUrl} = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

// ===== 仓库配置（多仓库支持） =====
const repositories = {
    maven: {
        'central': 'https://repo1.maven.org/maven2',
        'apache': 'https://repo.maven.apache.org/maven2',
        'google': 'https://dl.google.com/dl/android/maven2',
        'jitpack': 'https://jitpack.io',
        'gradle-plugins': 'https://plugins.gradle.org/m2',
        'spring-plugins': 'https://repo.spring.io/plugins-release',
        'spring-milestones': 'https://repo.spring.io/milestone',
        'spring-snapshots': 'https://repo.spring.io/snapshot',
    },
    pypi: {
        'official': 'https://pypi.org/pypi/web/simple'
    },
    npm: {
        'official': 'https://registry.npmjs.org'
    },
    go: {
        'official': 'https://proxy.golang.org'
    },
    apt: {
        'ubuntu': 'http://archive.ubuntu.com/ubuntu',
        'debian': 'http://deb.debian.org/debian',
    },
};

// ===== 基本配置项 =====
const PORT = process.env.PORT || 3000; // 服务端口
const LOG_DIR = path.join(__dirname, 'logs');
const BODY_LIMIT = 10 * 1024 * 1024; // 请求体最大10MB
const REQUEST_TIMEOUT = 30_000; // 代理请求超时30秒
const IS_PROD = process.env.NODE_ENV === 'production'; // 生产环境标志

/**
 * 保证日志目录存在
 */
function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR);
    }
}

/**
 * 流式日志写入，分级 info/warn/error
 * @param {string} level 日志级别
 * @param {string} message 日志内容
 * @param {object} meta 额外元数据
 */
function log(level, message, meta) {
    if (IS_PROD) return; // 生产环境不写日志
    ensureLogDir();
    const logFile = path.join(LOG_DIR, `${level}.log`);
    const time = new Date().toISOString();
    const record = `[${time}] [${level}] ${message}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;
    fs.promises.appendFile(logFile, record).catch(() => {
    });
}

/**
 * 规范化路径，防止目录穿越攻击
 * @param {string} p 路径
 * @returns {string|null} 安全路径或null
 */
function normalizePath(p) {
    if (p.includes('..')) return null;
    return p.replace(/\/+/g, '/');
}

/**
 * 返回JSON响应，带安全HTTP头
 * @param {http.ServerResponse} res 响应对象
 * @param {number} code 状态码
 * @param {object} obj 响应内容
 * @param {object} headers 额外HTTP头
 */
function sendJSON(res, code, obj, headers = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(code, Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
        'Content-Length': Buffer.byteLength(body),
    }, headers));
    res.end(body);
}

/**
 * 根据accept-encoding自动Gzip响应
 * @param {http.IncomingMessage} req 请求对象
 * @param {http.ServerResponse} res 响应对象
 * @param {stream.Readable} bodyStream 响应流
 */
function gzipMaybe(req, res, bodyStream) {
    if (/\bgzip\b/i.test(req.headers['accept-encoding'] || '')) {
        res.setHeader('Content-Encoding', 'gzip');
        const gz = zlib.createGzip();
        bodyStream.pipe(gz).pipe(res);
    } else {
        bodyStream.pipe(res);
    }
}

/**
 * 代理转发请求到目标仓库
 * @param {http.IncomingMessage} req 客户端请求对象
 * @param {http.ServerResponse} res 客户端响应对象
 * @param {string} type 仓库类型
 * @param {string} mirrorName 仓库镜像名称
 * @param {string} restPath 仓库下的路径
 * @param {boolean} isHead 是否为HEAD请求
 */
function proxyRequest(req, res, type, mirrorName, restPath, isHead = false) {
    const repoType = repositories[type];
    if (!repoType) {
        return sendJSON(res, 404, {error: '仓库类型不存在'});
    }
    const baseUrl = repoType[mirrorName];
    if (!baseUrl) {
        return sendJSON(res, 404, {error: '该仓库类型下镜像不存在'});
    }
    const safePath = normalizePath(restPath);
    if (!safePath) {
        return sendJSON(res, 400, {error: '路径非法'});
    }

    // 拼接目标URL
    const origQuery = parseUrl(req.url).query || '';
    const baseParsed = parseUrl(baseUrl);
    let targetPath = baseParsed.pathname.replace(/\/$/, '') + '/' + safePath.replace(/^\//, '');
    const targetUrl = `${baseParsed.protocol}//${baseParsed.host}${targetPath}${origQuery ? '?' + origQuery : ''}`;
    const isHttps = baseParsed.protocol === 'https:';
    const mod = isHttps ? https : http;
    const headers = Object.assign({}, req.headers);
    delete headers['host'];

    // 请求体大小限制
    let bodySize = 0;
    const reqBody = [];
    let aborted = false;

    req.on('data', chunk => {
        bodySize += chunk.length;
        if (bodySize > BODY_LIMIT) {
            sendJSON(res, 413, {error: '请求体过大'});
            req.destroy();
            aborted = true;
        } else {
            reqBody.push(chunk);
        }
    });
    req.on('end', () => {
        if (aborted) return;
        const proxyOptions = {
            protocol: baseParsed.protocol,
            hostname: baseParsed.hostname,
            port: baseParsed.port,
            path: targetPath + (origQuery ? '?' + origQuery : ''),
            method: isHead ? 'HEAD' : req.method,
            headers,
            timeout: REQUEST_TIMEOUT,
        };
        log('info', '代理转发请求', {type, mirrorName, path: safePath, method: proxyOptions.method});

        const proxy = mod.request(proxyOptions, proxyRes => {
            // 设置安全头
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Content-Security-Policy', "default-src 'none'");
            // 透传响应头部（排除content-length，gzip后长度变化）
            for (const [k, v] of Object.entries(proxyRes.headers)) {
                if (k === 'content-length') continue;
                res.setHeader(k, v);
            }
            if (isHead) {
                // HEAD只返回头部不返回正文
                return res.end();
            }
            gzipMaybe(req, res, proxyRes);
        });

        proxy.on('timeout', () => {
            proxy.destroy();
            sendJSON(res, 504, {error: '代理请求超时'});
            log('warn', '代理超时', {targetUrl});
        });
        proxy.on('error', err => {
            sendJSON(res, 502, {error: '代理请求异常', detail: err.message});
            log('error', '代理请求异常', {error: err.message, targetUrl});
        });

        // 仅对有请求体的方法转发body
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            for (const chunk of reqBody) proxy.write(chunk);
        }
        proxy.end();
    });
}

/**
 * 处理HEAD请求，只返回响应头部
 * @param {http.IncomingMessage} req 请求对象
 * @param {http.ServerResponse} res 响应对象
 */
function handleHeadRoute(req, res) {
    const {pathname} = parseUrl(req.url);
    const segments = pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (pathname === '/' || pathname === '') {
        // 服务说明
        const obj = {
            service: '多仓库镜像代理服务',
            version: '1.0',
            repositories: Object.entries(repositories).map(([type, mirrors]) => ({
                type,
                mirrors: Object.keys(mirrors)
            })),
            usage: '/{type}/{mirrorName}/{path}',
            health: '/health',
            repos: '/repositories'
        };
        const body = JSON.stringify(obj);
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'",
            'Content-Length': Buffer.byteLength(body),
        });
        return res.end();
    }
    if (pathname === '/health') {
        // 健康检查
        const obj = {
            status: 'ok',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            load: os.loadavg(),
            timestamp: Date.now(),
        };
        const body = JSON.stringify(obj);
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'",
            'Content-Length': Buffer.byteLength(body),
        });
        return res.end();
    }
    if (pathname === '/repositories') {
        // 仓库类型列表
        const obj = {
            repositories: Object.entries(repositories).map(([type, mirrors]) => ({
                type,
                mirrors: Object.keys(mirrors)
            }))
        };
        const body = JSON.stringify(obj);
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'",
            'Content-Length': Buffer.byteLength(body),
        });
        return res.end();
    }
    if (segments.length === 1 && repositories[segments[0]]) {
        // 单一仓库类型详情
        const obj = {
            type: segments[0],
            mirrors: repositories[segments[0]]
        };
        const body = JSON.stringify(obj);
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'",
            'Content-Length': Buffer.byteLength(body),
        });
        return res.end();
    }
    if (segments.length >= 2 && repositories[segments[0]] && repositories[segments[0]][segments[1]]) {
        // 仓库文件HEAD透传
        const [type, mirrorName, ...rest] = segments;
        const restPath = rest.join('/');
        if (!restPath) {
            const body = JSON.stringify({error: '镜像名后必须跟具体路径'});
            res.writeHead(400, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'",
            });
            return res.end();
        }
        // 发起到上游的HEAD请求
        return proxyRequest(req, res, type, mirrorName, restPath, true);
    }
    // 未命中返回404
    const body = JSON.stringify({error: '未找到对应资源'});
    res.writeHead(404, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
    });
    return res.end();
}

/**
 * 处理常规路由（GET/POST/PUT/PATCH）
 * @param {http.IncomingMessage} req 请求对象
 * @param {http.ServerResponse} res 响应对象
 */
function handleRoute(req, res) {
    const {pathname} = parseUrl(req.url);
    const segments = pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (pathname === '/' || pathname === '') {
        // 服务说明
        return sendJSON(res, 200, {
            service: '多仓库镜像代理服务',
            version: '1.0',
            repositories: Object.entries(repositories).map(([type, mirrors]) => ({
                type,
                mirrors: Object.keys(mirrors)
            })),
            usage: '/{type}/{mirrorName}/{path}',
            health: '/health',
            repos: '/repositories'
        });
    }
    if (pathname === '/health') {
        // 健康检查
        return sendJSON(res, 200, {
            status: 'ok',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            load: os.loadavg(),
            timestamp: Date.now(),
        });
    }
    if (pathname === '/repositories') {
        // 仓库类型列表
        return sendJSON(res, 200, {
            repositories: Object.entries(repositories).map(([type, mirrors]) => ({
                type,
                mirrors: Object.keys(mirrors)
            }))
        });
    }
    if (segments.length === 1 && repositories[segments[0]]) {
        // 单一仓库类型详情
        return sendJSON(res, 200, {
            type: segments[0],
            mirrors: repositories[segments[0]]
        });
    }
    if (segments.length >= 2 && repositories[segments[0]] && repositories[segments[0]][segments[1]]) {
        // 代理转发到具体仓库
        const [type, mirrorName, ...rest] = segments;
        const restPath = rest.join('/');
        if (!restPath) {
            return sendJSON(res, 400, {error: '镜像名后必须跟具体路径'});
        }
        return proxyRequest(req, res, type, mirrorName, restPath);
    }
    // 未命中返回404
    sendJSON(res, 404, {error: '未找到对应资源'});
}

/**
 * 优雅关闭服务，处理SIGTERM/SIGINT信号
 * @param {http.Server} server 服务实例
 */
function gracefulShutdown(server) {
    log('info', '服务正在优雅退出...', {});
    server.close(() => process.exit(0));
}

// 全局异常处理，保证日志落盘
process.on('uncaughtException', err => {
    log('error', '未捕获异常', {error: err.stack});
    process.exit(1);
});
process.on('unhandledRejection', err => {
    log('error', 'Promise未处理拒绝', {error: err && err.stack || err});
    process.exit(1);
});

// ===== 启动HTTP服务，支持HEAD方法 =====
const server = http.createServer((req, res) => {
    // 仅允许部分HTTP方法
    if (!['GET', 'POST', 'PUT', 'PATCH', 'HEAD'].includes(req.method)) {
        return sendJSON(res, 405, {error: '不支持的HTTP方法'});
    }
    if (req.method === 'HEAD') {
        return handleHeadRoute(req, res);
    }
    handleRoute(req, res);
});
server.listen(PORT, () => {
    log('info', `镜像代理服务启动于端口${PORT}`, {});
    console.log(`镜像代理服务启动于端口${PORT}`);
});
process.on('SIGTERM', () => gracefulShutdown(server));
process.on('SIGINT', () => gracefulShutdown(server));