#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Put the TinyEMU WebAssembly engine (x86emu-wasm.js + .wasm) into engine/.
 *
 *   node scripts/fetch-engine.mjs [version]        a release from TinyEMU's GitHub
 *                                                   Pages (default: latest), checked
 *                                                   against its SHA256SUMS
 *   node scripts/fetch-engine.mjs --from <dir>     copy a local build, e.g.
 *                                                   <TinyEMU>/dist/wasm
 *   --out <dir>       where to write (default: this repository's engine/)
 *   --base <url>      another Pages site (default: TINYEMU_PAGES or
 *                     https://gramthanos.github.io/TinyEMU/)
 *
 * Writes engine/VERSION with what was installed.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['x86emu-wasm.js', 'x86emu-wasm.wasm'];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: fetch-engine.mjs [version] [--from <dir>] [--out <dir>] [--base <url>]';

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };

async function main(args) {
    const opt = (name) => {
        const i = args.indexOf(name);
        if (i < 0) return null;
        const v = args[i + 1];
        if (!v || v.startsWith('--')) fail(`${name} needs a value`);
        args.splice(i, 2);
        return v;
    };
    const from = opt('--from');
    const out = resolve(opt('--out') || join(ROOT, 'engine'));
    let base = opt('--base') || process.env.TINYEMU_PAGES || 'https://gramthanos.github.io/TinyEMU/';
    if (!base.endsWith('/')) base += '/';
    if (args.length > 1 || args.some((a) => a.startsWith('--'))) fail(USAGE);
    const version = args[0] || 'latest';
    if (!/^[\w.-]+$/.test(version)) fail(`not a version name: ${version}`);

    await mkdir(out, { recursive: true });

    if (from) {
        for (const f of FILES) await copyFile(join(from, f), join(out, f));
        await writeFile(join(out, 'VERSION'), `local ${resolve(from)}\n`);
        console.log(`engine: copied ${FILES.join(', ')} from ${resolve(from)} to ${out}`);
        return;
    }

    const dir = new URL(`engine/${version}/`, base);
    const get = async (url) => {
        let r;
        try { r = await fetch(url); } catch (e) { fail(`${url}: ${e.cause?.code || e.message}`); }
        const body = Buffer.from(await r.arrayBuffer());
        if (!r.ok) fail(`${url}: HTTP ${r.status}`);
        return body;
    };
    const sums = new Map((await get(new URL('SHA256SUMS', dir))).toString('utf8').trim().split('\n')
        .map((l) => l.trim().split(/\s+\*?/)).map(([h, n]) => [n, h]));
    const data = {};
    for (const f of FILES) {
        data[f] = await get(new URL(f, dir));
        const want = sums.get(f);
        const have = createHash('sha256').update(data[f]).digest('hex');
        if (!want) fail(`${f} is not in ${dir}SHA256SUMS`);
        if (want !== have) fail(`${f}: checksum mismatch (got ${have}, expected ${want})`);
    }
    for (const f of FILES) await writeFile(join(out, f), data[f]);

    let resolved = version;
    if (version === 'latest') {
        try { resolved = JSON.parse((await get(new URL('index.json', base))).toString('utf8')).latest || version; }
        catch { /* keep 'latest' */ }
    }
    await writeFile(join(out, 'VERSION'), `${resolved} ${dir.href}\n`);
    console.log(`engine: ${resolved} from ${dir.href} -> ${out} (checksums match)`);
}

main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Fail ? `fetch-engine: ${e.message}` : e);
    process.exitCode = 1;
});
