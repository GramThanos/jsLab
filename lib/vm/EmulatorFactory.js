// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * EmulatorFactory.js — run many isolated TinyEMU instances from ONE unmodified
 * Emscripten bundle, with no rebuild.
 *
 * The shipped `x86emu-wasm.js` is a pre-MODULARIZE build: at top level it does
 *   var Module = typeof Module !== "undefined" ? Module : {};
 * and references the free variables `term` and `net_state`, ending with `run()`.
 * Loaded as a plain <script> that makes one global `Module` — a singleton.
 *
 * We instead fetch the bundle as text and wrap it in a function:
 *   (function (Module, term, net_state) { <bundle...>; return Module; })
 * Each call gets its own closure scope → its own `Module`, `term`, `net_state`,
 * and its own copies of every internal (`_malloc`, `HEAPU8`, the asm exports).
 * Because the bundle also does `Module["cwrap"] = ...`, `Module["_malloc"] = ...`,
 * etc., the returned `Module` exposes everything callers need. This is manual
 * MODULARIZE and removes the singleton limitation on the main thread AND inside
 * a worker (see docs/runtime.md §4 and TinyEMU's plan-c-changes.md §1).
 *
 * Note: `new Function` (like eval) must be permitted by the page CSP.
 */

'use strict';

const _sourceCache = new Map();   // url -> Promise<string>

/** Fetch (and cache) the Emscripten bundle source text. */
export function loadEmulatorSource(url) {
    if (!_sourceCache.has(url)) {
        // 'no-cache' revalidates (cheap conditional GET) so a rebuilt bundle is
        // never masked by a stale HTTP cache entry; unchanged → 304.
        const p = fetch(url, { cache: 'no-cache' }).then((r) => {
            if (!r.ok) throw new Error(`failed to fetch ${url}: HTTP ${r.status}`);
            return r.text();
        }).catch((e) => { _sourceCache.delete(url); throw e; });
        _sourceCache.set(url, p);
    }
    return _sourceCache.get(url);
}

export class EmulatorFactory {
    /** @param {string} sourceText  the raw x86emu-wasm.js text */
    constructor(sourceText) {
        // Build the closure once; reuse it for every instance. Everything the
        // bundle needs from the host it reaches through `Module.api` (defined by
        // lib.js) and the `Module` config, so `Module` is the only injected
        // binding — each call gets its own isolated one.
        // eslint-disable-next-line no-new-func
        this._make = new Function('Module', sourceText + '\n;return Module;');
    }

    static async fromUrl(url) {
        return new EmulatorFactory(await loadEmulatorSource(url));
    }

    /**
     * Instantiate one isolated emulator.
     *
     * @param {object} o
     * @param {(path:string)=>string} o.locateFile  resolves 'x86emu-wasm.wasm'
     * @param {ArrayBuffer} [o.wasmBinary]  the .wasm bytes, so the bundle fetches nothing
     * @param {object} o.api        the Module.api object lib.js calls into
     *                              (terminal, net, downloading, wgetRequests, ...)
     * @param {(Module:object)=>void} o.onReady   called after runtime init
     * @param {(t:string)=>void} [o.print]
     * @param {(t:string)=>void} [o.printErr]
     * @returns {object} the isolated Module (methods valid after onReady)
     */
    create({ locateFile, wasmBinary, pageUrl, api, onReady, print, printErr, x86jit, x86jitThreshold, x86jitTailcalls }) {
        const Module = {
            locateFile,
            ...(wasmBinary ? { wasmBinary } : {}),
            // what relative URLs in a config are relative to (TinyEMU's lib.js);
            // in a worker, location is the worker script, not the page
            pageUrl,
            // x86 WebAssembly JIT (TinyEMU's wasm/x86jit.js): on unless x86jit is false
            x86jit: x86jit !== false,
            x86jitThreshold,
            x86jitTailcalls,      // true: chain with tail calls (A/B; measured slower)
            noExitRuntime: true,
            api,
            print: print || (() => {}),
            printErr: printErr || (() => {}),
        };
        // onRuntimeInitialized fires after the runtime is up → safe to cwrap/ccall.
        Module.onRuntimeInitialized = () => { if (onReady) onReady(Module); };

        this._make(Module);   // runs the bundle; auto-calls run()
        return Module;
    }
}
