const http = require('http');
const {pipeline} = require('stream');
const {URL} = require('url');
const {Pool} = require('undici');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const REQUEST_TIMEOUT_MS = 30_000; // per upstream request timeout

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

// Build pools per origin and store base path
const pools = {}; // origin -> Pool
const repoMeta = {}; // `${type}/${key}` -> { origin, basePath }

for (const type of Object.keys(repositories)) {
    for (const key of Object.keys(repositories[type])) {
        const raw = repositories[type][key];
        const u = new URL(raw);
        const origin = `${u.protocol}//${u.host}`;
        const basePath = u.pathname.replace(/\/$/, '');
        if (!pools[origin]) {
            pools[origin] = new Pool(origin, {
                connections: 8,
                pipelining: 1,
            });
        }
        repoMeta[`${type}/${key}`] = {origin, basePath};
    }
}

// Build prefix map for explicit routing
const prefixMap = {};
for (const k of Object.keys(repoMeta)) {
    const [type, repo] = k.split('/');
    const prefix = `/${type}/${repo}/`;
    prefixMap[prefix] = repoMeta[k];
}

// Hop-by-hop headers to remove when forwarding or returning
const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade'
]);

function now() {
    return new Date().toISOString();
}

function copyHeaders(srcHeaders, setHeaderCb) {
    for (const [name, value] of Object.entries(srcHeaders || {})) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue;
        setHeaderCb(name, value);
    }
}

function detectRepositoryByPath(path) {
    const lower = path.toLowerCase();

    if (/\.(jar|pom|aar|zip|war|ear|module|sources\.jar|javadoc\.jar|asc|sha1|md5)(?:$|\?)/i.test(path) ||
        /^\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/[0-9]+\//i.test(path) ||
        /\/maven2\//i.test(path)) {
        return {type: 'maven'};
    }

    if (lower.startsWith('/simple/') || lower.includes('/simple/')) {
        return {type: 'pypi', repo: 'official'};
    }

    if (path.includes('/-/') || /\/@[^\/]+\/|^\/?[^\/]+$/.test(path) && path.includes('-')) {
        return {type: 'npm', repo: 'official'};
    }
    if (path.includes('/package/') || path.startsWith('/-/')) {
        return {type: 'npm', repo: 'official'};
    }

    if (path.includes('/@v/') || path.includes('/@latest') || path.startsWith('/mod/')) {
        return {type: 'go', repo: 'official'};
    }

    if (lower.includes('/dists/') || lower.includes('/pool/') || lower.endsWith('.deb')) {
        return {type: 'apt', repo: 'ubuntu'};
    }

    return null;
}

function buildForwardHeaders(incomingHeaders) {
    const headers = {};
    const forwardList = [
        'range',
        'if-none-match',
        'if-modified-since',
        'accept',
        'user-agent',
        'authorization',
        'accept-encoding'
    ];
    for (const name of forwardList) {
        if (incomingHeaders[name]) headers[name] = incomingHeaders[name];
    }
    headers.via = (incomingHeaders.via ? incomingHeaders.via + ', ' : '') + 'node-proxy';
    return headers;
}

function joinPaths(basePath, requestPath) {
    if (!basePath) return requestPath;
    if (!requestPath || requestPath === '/') return basePath || '/';
    return (basePath + (requestPath.startsWith('/') ? requestPath : '/' + requestPath));
}

async function requestUpstream(pool, path, method, headers, abortSignal) {
    return pool.request({
        path,
        method,
        headers,
        signal: abortSignal,
    });
}

async function tryUpstreamsInOrder(req, res, upstreamList, requestPathAndQuery) {
    let lastErr = null;
    for (const meta of upstreamList) {
        const pool = pools[meta.origin];
        const fullPath = joinPaths(meta.basePath, requestPathAndQuery);
        const headers = buildForwardHeaders(req.headers);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            console.log(now(), 'trying upstream', meta.origin, fullPath);
            const {
                statusCode,
                headers: upstreamHeaders,
                body
            } = await requestUpstream(pool, fullPath, req.method, headers, controller.signal);
            clearTimeout(timeout);

            if (statusCode < 400) {
                copyHeaders(upstreamHeaders, (name, value) => res.setHeader(name, value));
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.writeHead(statusCode);

                if (req.method === 'HEAD' || !body) {
                    return res.end();
                }
                return pipeline(body, res, (err) => {
                    if (err) {
                        console.error(now(), 'stream error while piping body:', err);
                        try {
                            if (!res.headersSent) res.writeHead(502);
                        } catch (e) {
                        }
                        try {
                            res.end();
                        } catch (e) {
                        }
                    }
                });
            } else {
                lastErr = {
                    statusCode,
                    headers: upstreamHeaders,
                    message: `upstream ${meta.origin} returned ${statusCode}`
                };
            }
        } catch (err) {
            clearTimeout(timeout);
            lastErr = err;
        }
    }

    if (lastErr && lastErr.statusCode) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(lastErr.statusCode);
        return res.end(`Upstream returned ${lastErr.statusCode}`);
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(502);
        return res.end('All upstreams failed: ' + String(lastErr));
    }
}

async function proxyToMeta(req, res, meta, requestPathAndQuery) {
    const pool = pools[meta.origin];
    const fullPath = joinPaths(meta.basePath, requestPathAndQuery);
    const headers = buildForwardHeaders(req.headers);

    console.log(now(), 'proxy -> origin=' + meta.origin, ' fullPath=' + fullPath);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const {
            statusCode,
            headers: upstreamHeaders,
            body
        } = await requestUpstream(pool, fullPath, req.method, headers, controller.signal);
        clearTimeout(timeout);

        copyHeaders(upstreamHeaders, (name, value) => res.setHeader(name, value));
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(statusCode);

        if (req.method === 'HEAD' || !body) return res.end();

        return pipeline(body, res, (err) => {
            if (err) {
                console.error(now(), 'stream error while piping body:', err);
                try {
                    if (!res.headersSent) res.writeHead(502);
                } catch (e) {
                }
                try {
                    res.end();
                } catch (e) {
                }
            }
        });
    } catch (err) {
        clearTimeout(timeout);
        console.error(now(), 'fetch error', err);
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (err.name === 'AbortError') {
            res.writeHead(504);
            return res.end('Upstream request timed out');
        }
        res.writeHead(502);
        return res.end('Upstream fetch failed: ' + String(err));
    }
}

const server = http.createServer(async (req, res) => {
    try {
        const method = req.method.toUpperCase();
        const originalUrl = req.url || '/';
        console.log(now(), method, originalUrl);

        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            res.setHeader('Allow', 'GET, HEAD, OPTIONS');
            res.writeHead(405);
            return res.end('Method Not Allowed');
        }

        if (method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Range, If-None-Match, If-Modified-Since, Content-Type, Accept, Authorization');
            res.writeHead(204);
            return res.end();
        }

        const pathAndQuery = originalUrl.startsWith('/') ? originalUrl : '/' + originalUrl;

        // explicit prefix routing
        for (const prefix of Object.keys(prefixMap)) {
            if (pathAndQuery.startsWith(prefix)) {
                const meta = prefixMap[prefix];
                // properly remove the prefix and ensure leading '/'
                const rel = '/' + pathAndQuery.slice(prefix.length);
                // rel is like '/com/google/...'
                return await proxyToMeta(req, res, meta, rel);
            }
        }

        // heuristics
        const heur = detectRepositoryByPath(pathAndQuery);
        if (heur) {
            if (heur.type === 'maven') {
                const ordered = [];
                for (const key of Object.keys(repositories.maven)) {
                    const meta = repoMeta[`maven/${key}`];
                    if (meta) ordered.push(meta);
                }
                return await tryUpstreamsInOrder(req, res, ordered, pathAndQuery);
            } else {
                const repoKey = heur.repo || Object.keys(repositories[heur.type])[0];
                const meta = repoMeta[`${heur.type}/${repoKey}`];
                if (!meta) {
                    res.writeHead(502);
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    return res.end('No upstream configured for detected repository type');
                }
                return await proxyToMeta(req, res, meta, pathAndQuery);
            }
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(404);
        return res.end(
            `No explicit repository prefix found and unable to infer repository type from path.
Use explicit prefixes such as:
  /maven/central/...
  /pypi/official/simple/...
  /npm/official/...
  /go/official/...
  /apt/ubuntu/...
`);
    } catch (err) {
        console.error(now(), 'unexpected error in request handler:', err);
        try {
            res.writeHead(500);
            res.end('Internal Server Error');
        } catch (e) {
        }
    }
});

server.listen(PORT, () => {
    console.log(`${now()} High-performance proxy listening on port ${PORT}`);
});