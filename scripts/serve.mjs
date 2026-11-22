#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Serve this repository over HTTP for the demos (ES modules and WASM need
 * http://, not file://):
 *
 *   node scripts/serve.mjs [port]      default 8000, then open /demos/demo.html
 *
 * Static files only, from the repository root; nothing outside it is served.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8000);
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
    '.wasm': 'application/wasm', '.cfg': 'text/plain; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

createServer(async (req, res) => {
    try {
        let path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
        if (path !== ROOT && !path.startsWith(ROOT + sep)) throw new Error('outside');
        if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
        const body = await readFile(path);
        res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(body);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found\n');
    }
}).listen(PORT, () => console.log(`jsLab on http://localhost:${PORT}/ (demos: /demos/demo.html)`));
