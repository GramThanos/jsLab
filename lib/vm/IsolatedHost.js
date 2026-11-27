// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * IsolatedHost.js — run a VM's worker inside a sandboxed frame (mode: 'isolated').
 *
 * The page makes a hidden <iframe sandbox="allow-scripts" srcdoc=…>: an opaque
 * origin (no access to the page's storage, cookies or DOM), whose <meta> CSP
 * sets `connect-src 'none'` (no fetch, XHR, WebSocket, EventSource, beacon).
 * The frame starts the VM worker from a blob: URL, and a worker from a blob: URL
 * inherits its creator's CSP, so the worker can't reach the network or any
 * storage either. That needs no response headers, so it works on static hosts
 * such as GitHub Pages.
 *
 *   page ──MessagePort──▶ worker (in the frame)        [the frame only relays the port]
 *
 * Everything the worker needs from outside it asks the page for:
 *   - its own code: the page fetches vm-worker.js and the modules it imports
 *     and sends their source; the frame's CSP allows no script origin, only
 *     blob: (a classic worker from a blob: URL; a module worker from one can't
 *     start in an opaque origin), and the worker makes blob: modules of them;
 *   - the engine: the page fetches x86emu-wasm.js and .wasm and sends them in
 *     the start config (engineSource, wasmBinary);
 *   - files: TinyEMU's XHRs (config, kernel, disk chunks) go through PortXHR to
 *     the page, which serves only URLs on its allowlist, up to a size cap
 *     (RequestPolicy.js);
 *   - volumes: always page-owned (PageStorage.js);
 *   - snapshots: moved as transferable ArrayBuffers.
 *
 * Requirements: none from the server. A page with its own CSP must allow
 * srcdoc frames (frame-src) and the page's fetches of the engine and files.
 *
 * VM config: `mode: 'isolated'`, and optionally `isolation: { allow: [...],
 * maxBytes }` to add URLs (strings, '…/' folders, RegExps, predicates) to the
 * allowlist and set the per-response cap.
 */

'use strict';

import { WorkerHost } from './WorkerHost.js';
import { loadEmulatorSource } from './EmulatorFactory.js';
import { RequestPolicy, urlFolder } from './RequestPolicy.js';
import { parseConfig, configFiles, resolveConfigFiles, isInlineUrl } from './TinyemuConfig.js';

const _wasmCache = new Map();   // url -> Promise<ArrayBuffer>

function loadWasm(url) {
    if (!_wasmCache.has(url)) {
        const p = fetch(url, { cache: 'no-cache' }).then((r) => {
            if (!r.ok) throw new Error(`failed to fetch ${url}: HTTP ${r.status}`);
            return r.arrayBuffer();
        }).catch((e) => { _wasmCache.delete(url); throw e; });
        _wasmCache.set(url, p);
    }
    return _wasmCache.get(url);
}

/* A static import / re-export of a relative module, one per line, as jsLab's
 * worker modules write them: group 1 up to the quote, 2 the quote, 3 the path. */
const IMPORT_RE = /^(\s*(?:import|export)\b[^;'"]*?(?:\bfrom\s*)?)(['"])(\.{1,2}\/[^'"]+)\2/gm;

const _moduleCache = new Map();   // url -> Promise<string>

function loadModule(url) {
    if (!_moduleCache.has(url)) {
        const p = fetch(url, { cache: 'no-cache' }).then((r) => {
            if (!r.ok) throw new Error(`failed to fetch ${url}: HTTP ${r.status}`);
            return r.text();
        }).catch((e) => { _moduleCache.delete(url); throw e; });
        _moduleCache.set(url, p);
    }
    return _moduleCache.get(url);
}

/**
 * The source of the worker module and every module it imports, by absolute URL.
 * The page fetches them and hands them to the worker, which loads nothing from
 * any server itself (and, from an opaque origin, often couldn't: browsers block
 * requests from it to localhost and private networks).
 * @returns {Promise<Object<string,string>>}
 */
export async function collectModules(entryUrl) {
    const out = {};
    const walk = async (url) => {
        if (url in out) return;
        out[url] = null;
        const src = await loadModule(url);
        out[url] = src;
        const deps = [...src.matchAll(IMPORT_RE)].map((m) => new URL(m[3], url).href);
        await Promise.all(deps.map(walk));
    };
    await walk(new URL(entryUrl).href);
    return out;
}

/* The classic worker the frame starts (a module worker from a blob: URL can't
 * start in an opaque origin). It makes a blob: URL per module, with the relative
 * imports pointing at the others' blob: URLs, imports the entry module, and
 * gives it the page's port. */
const BOOT_WORKER = `
self.onmessage = function (e) {
  var d = e.data;
  if (!d || d.type !== 'jslab-modules' || !e.ports[0]) return;
  self.onmessage = null;
  var port = e.ports[0], urls = {}, loading = {};
  var RE = new RegExp(${JSON.stringify(IMPORT_RE.source)}, 'gm');
  function load(u) {
    if (urls[u]) return urls[u];
    if (loading[u]) throw new Error('import cycle at ' + u);
    if (typeof d.modules[u] !== 'string') throw new Error('missing module ' + u);
    loading[u] = true;
    var src = d.modules[u].replace(RE, function (m, pre, q, spec) {
      return pre + q + load(new URL(spec, u).href) + q;
    });
    return (urls[u] = URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  }
  var fail = function (err) { port.postMessage({ type: 'error', message: 'isolated worker: ' + String(err && err.message || err).slice(0, 2000) }); };
  try {
    import(load(d.entry)).then(function () {
      self.onmessage({ data: { type: 'port' }, ports: [port] });   // vm-worker.js takes it from here
    }, fail);
  } catch (err) { fail(err); }
};`;

/** The frame's document: its CSP, and a script that starts the worker. */
export function isolatedFrameHtml() {
    const csp = [
        "default-src 'none'",
        // the relay script below; blob: modules; new Function and wasm. No
        // server origin: the worker loads no script from anywhere.
        "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
        'worker-src blob:',
        "connect-src 'none'",
    ].join('; ');
    const script = `
(function () {
  var started = false;
  addEventListener('message', function (e) {
    var d = e.data;
    if (started || e.source !== parent || !d || d.type !== 'jslab-isolated-start' || !e.ports[0]) return;
    started = true;
    var boot = URL.createObjectURL(new Blob([${JSON.stringify(BOOT_WORKER)}], { type: 'text/javascript' }));
    var w = new Worker(boot);
    w.onerror = function (ev) {
      parent.postMessage({ type: 'jslab-isolated-error', message: String(ev && ev.message || 'worker error') }, '*');
    };
    w.postMessage({ type: 'jslab-modules', modules: d.modules, entry: d.entry }, [e.ports[0]]);
  });
  parent.postMessage({ type: 'jslab-isolated-ready' }, '*');
})();`;
    const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">`
        + `<meta http-equiv="Content-Security-Policy" content="${attr(csp)}">`
        + `<script>${script}</script></head><body></body></html>`;
}

export class IsolatedHost extends WorkerHost {
    /**
     * @param {object} urls
     * @param {object} sink
     * @param {object} [policy]      see WorkerHost; pageStorage is always on
     * @param {object} [isolation]   { allow: [...], maxBytes }
     */
    constructor(urls, sink, policy = {}, isolation = {}) {
        super(urls, sink, { ...policy, pageStorage: true });
        this.policy.fetch = true;
        this.isolation = isolation || {};
        this.frame = null;
        this._onWindowMessage = null;
    }

    /* The allowlist: the config, the folders of the files it names, the base
     * images of block volumes, and whatever the embedder adds. */
    async _allowlist(config) {
        const allow = [];
        const page = config.pageUrl || location.href;
        const cfgUrl = new URL(config.configUrl, page).href;
        if (!/^data:/i.test(cfgUrl)) allow.push(cfgUrl);
        let cfg = null;
        try {
            const text = await (await fetch(cfgUrl)).text();
            cfg = resolveConfigFiles(parseConfig(text), isInlineUrl(cfgUrl) ? page : cfgUrl);
        } catch { /* a snapshot resume, or the engine reports it */ }
        for (const f of cfg ? configFiles(cfg) : []) {
            if (/^https?:/i.test(f)) allow.push(urlFolder(f));
            else if (/^blob:/i.test(f)) allow.push(f);
        }
        if (config.driveUrl) allow.push(urlFolder(new URL(config.driveUrl, page).href));
        for (const v of config.volumes || []) {
            if (v && v.baseUrl) allow.push(urlFolder(new URL(v.baseUrl, page).href));
        }
        return [...new Set(allow)].concat(this.isolation.allow || []);
    }

    async _prepare(config) {
        const [{ config: cfg, transfer }, engineSource, wasm, allow, modules] = await Promise.all([
            super._prepare(config),
            loadEmulatorSource(this.urls.wasmJsUrl),
            loadWasm(this.urls.wasmBinUrl),
            this._allowlist(config),
            collectModules(this.urls.workerUrl),
        ]);
        this._modules = modules;
        this.requests = new RequestPolicy({ allow, maxBytes: this.isolation.maxBytes });
        const wasmBinary = wasm.slice(0);   // a copy to transfer; the cache keeps its own
        transfer.push(wasmBinary);
        cfg.isolated = true;
        cfg.engineSource = engineSource;
        cfg.wasmBinary = wasmBinary;
        await this._openFrame();
        return { config: cfg, transfer };
    }

    /* Make the frame and wait until its relay script runs. */
    _openFrame() {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.style.cssText = 'display:none';
        frame.srcdoc = isolatedFrameHtml();
        this.frame = frame;
        return new Promise((resolve, reject) => {
            const to = setTimeout(() => reject(new Error('the isolated frame did not start')), 10000);
            this._onWindowMessage = (ev) => {
                if (ev.source !== frame.contentWindow || !ev.data || typeof ev.data.type !== 'string') return;
                if (ev.data.type === 'jslab-isolated-ready') { clearTimeout(to); resolve(); }
                else if (ev.data.type === 'jslab-isolated-error') {
                    const err = new Error(String(ev.data.message || 'worker error').slice(0, 1000));
                    this.sink.error(err);
                    this._startReject?.(err);
                    this._startResolve = this._startReject = null;
                }
            };
            window.addEventListener('message', this._onWindowMessage);
            document.body.appendChild(frame);
        });
    }

    /* The page's end of a port whose other end goes to the worker via the frame. */
    _spawn() {
        const { port1, port2 } = new MessageChannel();
        this.frame.contentWindow.postMessage(
            { type: 'jslab-isolated-start', modules: this._modules, entry: new URL(this.urls.workerUrl).href },
            '*', [port2]);
        this._modules = null;
        const host = this;
        const ch = {
            postMessage: (msg, transfer) => port1.postMessage(msg, transfer || []),
            set onmessage(fn) { port1.onmessage = fn; },
            get onmessage() { return port1.onmessage; },
            onerror: null,
            terminate: () => {
                port1.close();
                host._closeFrame();
            },
        };
        port1.onmessageerror = () => this._drop('a message that could not be deserialized');
        return ch;
    }

    _closeFrame() {
        if (this._onWindowMessage) window.removeEventListener('message', this._onWindowMessage);
        this._onWindowMessage = null;
        this.frame?.remove();   // removing the frame ends its worker
        this.frame = null;
    }

    stop() {
        super.stop();
        if (!this._ch) this._closeFrame();
    }
}
