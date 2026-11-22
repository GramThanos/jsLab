// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * linux.js — minimal single-VM bootstrap for the TinyEMU WASM build.
 *
 * This is the simple, framework-light path: it boots ONE emulator into an
 * xterm.js terminal using the Module.api binding defined in lib.js. For running
 * several isolated VMs on one page, use lib/vm/ (VMManager) instead — this file
 * stays deliberately small as a reference and for single-VM pages.
 *
 * Requires (loaded before this script): xterm.js + xterm-addon-fit, and the
 * emulator bundle engine/x86emu-wasm.js (TinyEMU, built with --js-library wasm/lib.js).
 *
 * Usage:
 *   TinyEMULinux.start({
 *     mount: '#terminal',                 // container element or selector
 *     bundle: '../engine/x86emu-wasm.js', // emscripten output
 *     config: 'alpine-x86.cfg',           // TinyEMU .cfg (absolute or relative)
 *     memoryMB: 256,
 *     network: false,                     // basic build has no external net
 *   });
 */

'use strict';

(function (global) {

    function resolveEl(mount) {
        if (!mount) return document.body;
        return typeof mount === 'string' ? document.querySelector(mount) : mount;
    }

    function absURL(url) {
        return new URL(url, global.location.href).href;
    }

    function start(opts) {
        opts = opts || {};
        const el = resolveEl(opts.mount || '#terminal');
        const bundle = opts.bundle || '../engine/x86emu-wasm.js';
        const wasmBin = opts.wasmBin || bundle.replace(/\.js$/, '.wasm');
        const configUrl = absURL(opts.config || 'alpine-x86.cfg');
        const memoryMB = opts.memoryMB || 256;
        const cmdline = opts.cmdline || '';
        const hasNetwork = opts.network ? 1 : 0;

        // --- terminal ---
        const xterm = new global.Terminal({ cols: opts.cols || 80, rows: opts.rows || 30 });
        const fit = global.FitAddon ? new global.FitAddon.FitAddon() : null;
        if (fit) xterm.loadAddon(fit);
        xterm.open(el);
        if (fit) fit.fit();

        // --- clipboard UX (harvested from the old tinyemu.xterm.js) ---
        let queueChar = null;                 // set once the runtime is up
        function paste(text) {
            if (!queueChar || !text) return;
            for (let i = 0; i < text.length; i++) queueChar(text.charCodeAt(i));
        }
        let lastPaste = 0;
        xterm.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown') return true;
            // Ctrl+Shift+V — paste the clipboard into the guest
            if (e.key === 'V' && e.ctrlKey && e.shiftKey) {
                if (Date.now() - lastPaste > 300) {
                    lastPaste = Date.now();
                    navigator.clipboard.readText().then(paste).catch(() => {});
                }
                return false;
            }
            // Ctrl+Shift+C — copy the current selection
            if (e.key === 'C' && e.ctrlKey && e.shiftKey) {
                if (xterm.hasSelection()) {
                    navigator.clipboard.writeText(xterm.getSelection()).catch(() => {});
                    xterm.clearSelection();
                }
                return false;
            }
            return true;
        });
        // Right-click: copy the selection if there is one, else paste.
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (xterm.hasSelection()) {
                navigator.clipboard.writeText(xterm.getSelection()).catch(() => {});
                xterm.clearSelection();
            } else {
                navigator.clipboard.readText().then(paste).catch(() => {});
            }
        });

        // --- optional download indicator ---
        const dlEl = opts.downloadIndicator ? resolveEl(opts.downloadIndicator) : null;
        let dlTimer = null;
        function setDownloading(on) {
            if (!dlEl) return;
            if (on) { clearTimeout(dlTimer); dlEl.style.display = 'block'; }
            else { dlTimer = setTimeout(() => { dlEl.style.display = 'none'; }, 400); }
        }

        // --- the Module.api the bundle (via lib.js) calls into ---
        const Module = {
            noExitRuntime: true,
            locateFile: (p) => (p.endsWith('.wasm') ? absURL(wasmBin) : p),
            api: {
                terminal: {
                    write: (str) => xterm.write(str),
                    getSize: () => [xterm.cols, xterm.rows],
                },
                downloading: { update: setDownloading },
                // wget request handle table used by emscripten_async_wget3_data
                wgetRequests: (function () {
                    const table = {}; let next = 1;
                    return {
                        new(http) { const h = next++; table[h] = http; return h; },
                        remove(h) { delete table[h]; },
                        instance: table,
                    };
                })(),
                export_file: (name, file, url) => {
                    const a = document.createElement('a');
                    a.href = url; a.download = name;
                    document.body.appendChild(a); a.click(); a.remove();
                },
                // net / display are wired only when needed
                net: opts.net || null,
                display: null,
            },
        };

        Module.onRuntimeInitialized = function () {
            const consoleQueueChar = Module.cwrap('console_queue_char', null, ['number']);
            queueChar = consoleQueueChar;     // enable clipboard paste (see above)
            Module.cwrap('fs_import_file', null, ['string', 'number', 'number']);
            Module.ccall('vm_start', null,
                ['string', 'number', 'string', 'string', 'number', 'number', 'number'],
                [configUrl, memoryMB, cmdline, null, 0, 0, hasNetwork]);

            // keyboard → guest
            xterm.onData((input) => {
                for (let i = 0; i < input.length; i++) consoleQueueChar(input.charCodeAt(i));
            });
            if (typeof opts.onReady === 'function') opts.onReady(Module);
        };

        global.Module = Module;      // the classic bundle reads the global Module

        const s = document.createElement('script');
        s.src = bundle;
        s.onerror = () => xterm.write('\r\n[failed to load ' + bundle + ']\r\n');
        document.head.appendChild(s);

        return { xterm, Module };
    }

    global.TinyEMULinux = { start };

})(typeof window !== 'undefined' ? window : this);
