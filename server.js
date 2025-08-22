const express = require('express');
const {Readable} = require('stream');

const app = express();
const port = process.env.PORT || 3000;

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

// Build prefix map for explicit routing
function buildPrefixMap() {
    const map = {};
    for (const type of Object.keys(repositories)) {
        for (const repoKey of Object.keys(repositories[type])) {
            const prefix = `/${type}/${repoKey}/`;
            map[prefix] = repositories[type][repoKey].replace(/\/$/, '');
        }
    }
    return map;
}

const prefixMap = buildPrefixMap();

// Logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
    next();
});

// CORS preflight
app.options('*', (req, res) => {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, If-None-Match, If-Modified-Since, Content-Type, Accept, Authorization'
    });
    res.sendStatus(204);
});

// Main handler
app.use(async (req, res) => {
    try {
        // Allow only GET/HEAD/OPTIONS
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            res.set('Allow', 'GET, HEAD, OPTIONS');
            return res.status(405).send('Method Not Allowed');
        }

        // Use originalUrl to preserve path+query
        let pathAndQuery = req.originalUrl || req.url || '/';
        // Ensure pathAndQuery begins with '/'
        if (!pathAndQuery.startsWith('/')) pathAndQuery = '/' + pathAndQuery;

        // 1) explicit prefix routing
        for (const prefix of Object.keys(prefixMap)) {
            if (pathAndQuery.startsWith(prefix)) {
                const upstreamBase = prefixMap[prefix];
                const stripped = pathAndQuery.slice(prefix.length) || '/';
                const target = upstreamBase + stripped;
                return await proxyToUpstream(req, res, target);
            }
        }

        // 2) heuristics: try to infer repository type
        const heur = detectRepositoryByPath(pathAndQuery);
        if (heur) {
            if (heur.type === 'maven') {
                // Try all maven upstreams in order
                const upstreamList = Object.values(repositories.maven).map(u => u.replace(/\/$/, ''));
                return await tryUpstreamsInOrder(req, res, upstreamList, pathAndQuery);
            } else {
                // single upstream for detected type: take the 'official' or fallback first entry
                const repoMap = repositories[heur.type];
                const first = repoMap[heur.repo] || repoMap[Object.keys(repoMap)[0]];
                if (!first) return res.status(502).send('No upstream configured for detected repository type');
                const target = first.replace(/\/$/, '') + pathAndQuery;
                return await proxyToUpstream(req, res, target);
            }
        }

        // If nothing matched, return 404 with hint
        return res.status(404).send(`
No explicit repository prefix found and unable to infer repository type from path.
You can use explicit prefixes like:
  /maven/central/...
  /pypi/official/simple/...
  /npm/official/...
  /go/official/...
  /apt/ubuntu/...

Or place files/paths that match common patterns (e.g. .jar/.pom for maven).
`);
    } catch (err) {
        console.error('Unhandled proxy error:', err);
        return res.status(500).send('Internal Server Error');
    }
});

// Attempts a list of upstream bases in order and returns the first successful (<400) response
async function tryUpstreamsInOrder(req, res, bases, pathAndQuery) {
    let lastError = null;
    for (const base of bases) {
        const target = base + pathAndQuery;
        try {
            const upstreamRes = await fetchWithForwardedHeaders(req, target);
            if (upstreamRes.status < 400) {
                return await streamResponseToClient(upstreamRes, res);
            } else {
                // keep last Response to possibly return useful info
                lastError = upstreamRes;
            }
        } catch (err) {
            lastError = err;
        }
    }

    if (lastError instanceof Response) {
        return await streamResponseToClient(lastError, res);
    } else if (lastError) {
        return res.status(502).send('Upstream fetch failed: ' + String(lastError));
    } else {
        return res.status(502).send('No upstream available');
    }
}

async function proxyToUpstream(req, res, target) {
    try {
        const upstreamRes = await fetchWithForwardedHeaders(req, target);
        return await streamResponseToClient(upstreamRes, res);
    } catch (err) {
        console.error('Fetch to upstream failed:', err);
        return res.status(502).send('Fetch to upstream failed: ' + String(err));
    }
}

// Detect repository type by path heuristics. Returns {type, repo?} or null
function detectRepositoryByPath(path) {
    const lower = path.toLowerCase();

    // Maven artifacts: typical file extensions and layout
    if (/\.(jar|pom|aar|zip|war|ear|module|sources\.jar|javadoc\.jar)(?:$|\?)/i.test(path) ||
        /^\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/[0-9]+\//i.test(path) || // e.g. /com/google/guava/...
        /\/maven2\//i.test(path)) {
        return {type: 'maven'};
    }

    // PyPI simple index
    if (lower.startsWith('/simple/') || lower.includes('/simple/')) {
        return {type: 'pypi', repo: 'official'};
    }

    // NPM heuristics (scoped package or direct registry access)
    if (lower.startsWith('/-/') || /\/@[^\/]+\/|^\/?[^\/]+$/.test(path) && lower.includes('-')) {
        // This is a loose heuristic - prefer explicit prefix when possible
        return {type: 'npm', repo: 'official'};
    }
    if (path.includes('/-/') || path.includes('/package/')) {
        return {type: 'npm', repo: 'official'};
    }

    // Go proxy heuristics (v1 protocol paths)
    if (path.includes('/@v/') || path.includes('/@latest') || /^\/[^\/]+\/[^\/]+\/@v\//.test(path) || path.startsWith('/mod/')) {
        return {type: 'go', repo: 'official'};
    }

    // APT heuristics
    if (lower.includes('/dists/') || lower.includes('/pool/') || lower.endsWith('.deb')) {
        return {type: 'apt', repo: 'ubuntu'}; // default to ubuntu; user can use explicit prefix to choose debian
    }

    return null;
}

// Build headers to forward to upstream
function buildForwardHeaders(req) {
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
        const val = req.headers[name];
        if (val) headers[name] = val;
    }
    // Add Via header
    const viaVal = req.headers['via'] ? req.headers['via'] + ', ' : '';
    headers['via'] = viaVal + 'express-multi-proxy';
    return headers;
}

// Perform fetch to upstream while forwarding relevant headers and method
async function fetchWithForwardedHeaders(req, target) {
    const init = {
        method: req.method,
        headers: buildForwardHeaders(req),
        redirect: 'follow'
    };
    // GET/HEAD: no body. If needed in future, support other methods.
    return await fetch(target, init);
}

// Stream upstream Response to the Express response, copying headers and status
async function streamResponseToClient(upstreamRes, expressRes) {
    // Set status
    expressRes.status(upstreamRes.status);

    // Copy headers, skipping hop-by-hop
    upstreamRes.headers.forEach((value, name) => {
        const lname = name.toLowerCase();
        if (['transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'upgrade'].includes(lname)) {
            return;
        }
        expressRes.setHeader(name, value);
    });

    // Ensure CORS
    expressRes.setHeader('Access-Control-Allow-Origin', '*');

    // If no body or HEAD, end
    if (expressRes.req.method === 'HEAD' || upstreamRes.body == null) {
        return expressRes.end();
    }

    // Stream body: support Node streams or Web Streams
    if (upstreamRes.body && typeof upstreamRes.body.pipe === 'function') {
        // Node stream
        upstreamRes.body.pipe(expressRes);
    } else if (upstreamRes.body && typeof upstreamRes.body.getReader === 'function') {
        // Web ReadableStream -> convert
        const nodeStream = Readable.fromWeb(upstreamRes.body);
        nodeStream.pipe(expressRes);
    } else {
        // Fallback: buffer small responses
        const buf = Buffer.from(await upstreamRes.arrayBuffer());
        expressRes.send(buf);
    }
}

app.listen(port, () => {
    console.log(`Multi-repo proxy listening on port ${port}`);
});