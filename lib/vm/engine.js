// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * engine.js — where the TinyEMU WebAssembly engine (x86emu-wasm.js + .wasm) is
 * loaded from. jsLab ships no engine: by default it loads the release pinned
 * below from TinyEMU's GitHub Pages, which allows cross-origin loading. The one
 * engine runs both the PC (x86) and the RISC-V (riscv32 / riscv64) machines.
 *
 * engineUrls() takes a release name ('v2026-11-22', or 'latest', which follows
 * TinyEMU's newest release) or the URL / path of a folder that holds the two
 * files, such as a TinyEMU build served next to the page ('./my-engine/').
 */

/** TinyEMU's GitHub Pages: engine/<version>/ holds each release, index.json lists them. */
export const ENGINE_PAGES = 'https://gramthanos.github.io/TinyEMU/';

/** The release jsLab loads by default: the latest when this jsLab was released. */
export const ENGINE_VERSION = 'v2026-11-22';

const FILES = { wasmJsUrl: 'x86emu-wasm.js', wasmBinUrl: 'x86emu-wasm.wasm' };

/**
 * @param {string} [where]  a release name, or a folder URL / path (has a '/');
 *                          a relative path resolves against the page
 * @returns {{ wasmJsUrl: string, wasmBinUrl: string }}  absolute; for VMManager's `urls`
 */
export function engineUrls(where = ENGINE_VERSION) {
    let dir;
    if (where.includes('/')) {
        dir = new URL(where.endsWith('/') ? where : where + '/', globalThis.location?.href);
    } else if (/^[\w.-]+$/.test(where)) {
        dir = new URL(`engine/${where}/`, ENGINE_PAGES);
    } else {
        throw new Error(`not an engine release or folder: ${where}`);
    }
    return Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, new URL(f, dir).href]));
}

/** The releases on TinyEMU's Pages: { latest: string, versions: string[] }. */
export async function listEngineVersions() {
    const url = new URL('index.json', ENGINE_PAGES);
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const j = await r.json();
    return { latest: j.latest, versions: (j.versions || []).map((v) => v.version) };
}
