/**
 * Dev server for the viz. Builds viz-dist/ once, keeps rebuilding on source changes, and serves the
 * built directory on localhost. Dev == prod: it serves the exact static bundle that ships to a host,
 * so there is no server-only behaviour to diverge.
 *
 *   npm run viz   ->   http://localhost:5173/
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', 'viz-dist');
const PORT = Number(process.env.VIZ_PORT ?? 5173);

await build({ watch: true });

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
};

// Fail LOUDLY on a port collision instead of crashing with a raw stack (or, worse, leaving a stale
// server from another checkout serving an old page at this port (which reads as "the wrong viz came up").
process.on('uncaughtException', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error(`\n[viz] PORT ${PORT} IS ALREADY IN USE: another server is holding it (e.g. a leftover`
            + ` viz from another checkout). Nothing was served from THIS build.\n`
            + `      Free it:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN   then  kill <PID>\n`
            + `      Or pick another port:  VIZ_PORT=5199 npm run viz\n`);
        process.exit(1);
    }
    throw err;
});

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        let path = decodeURIComponent(url.pathname);
        if (path === '' || path.endsWith('/')) path += 'index.html';   // '/' → '/index.html', '/viz/' → '/viz/index.html'
        const filePath = normalize(join(OUT, path));
        if (!filePath.startsWith(OUT)) { res.writeHead(403); return res.end('forbidden'); }
        const body = await readFile(filePath);
        res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
        res.end(body);
    } catch (err) {
        if (err && err.code === 'ENOENT') { res.writeHead(404); return res.end('not found'); }
        res.writeHead(500); res.end(String((err && err.stack) || err));
    }
});
server.listen(PORT, () => console.log(`[viz] http://localhost:${PORT}/`));
