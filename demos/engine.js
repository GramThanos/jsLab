// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * engine.js — which TinyEMU WebAssembly engine the demos load.
 *
 * The page's `?engine=` picks it:
 *   (none)                 the release jsLab pins (lib/vm/engine.js)
 *   ?engine=latest         TinyEMU's newest release
 *   ?engine=v2026-11-22    that release from TinyEMU's GitHub Pages
 *   ?engine=/my-build/     a folder holding x86emu-wasm.js + .wasm, e.g. a local
 *                          TinyEMU build served next to jsLab
 * "latest" is resolved to its version through the Pages' index.json, so the
 * page names what it runs and snapshots tie to that build.
 */

import { ENGINE_VERSION, engineUrls, listEngineVersions } from '../lib/vm/index.js';

/**
 * @param {string|null} [choice]  a release, 'latest' or a folder; default: the page's ?engine=
 * @returns {Promise<{ label: string, urls: { wasmJsUrl: string, wasmBinUrl: string } }>}
 *          `urls` for VMManager, `label` names the engine for the page
 */
export async function resolveEngine(choice = new URLSearchParams(location.search).get('engine')) {
    let where = choice || ENGINE_VERSION;
    if (where === 'latest') {
        try { where = (await listEngineVersions()).latest || where; } catch { /* load engine/latest/ */ }
    }
    const urls = engineUrls(where);
    return { label: where.includes('/') ? urls.wasmJsUrl.replace(/[^/]*$/, '') : `TinyEMU ${where}`, urls };
}
