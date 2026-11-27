// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * vm-worker.js — module worker that hosts one TinyEMU instance for WorkerHost.
 *
 * It uses the SAME EmulatorFactory (closure wrapping) and EmulatorEngine as the
 * main-thread InlineHost, so worker and inline modes behave identically. The
 * closure wrapping means the worker isn't limited to one instance either — it
 * could drive several isolated Modules — though WorkerHost uses one per worker.
 *
 * Protocol
 *   main → worker : start{config} | stdin{data} | net-rx{frame}
 *                   resize{cols,rows} | pause | resume | flush | stop
 *                   vol-op{id,op,volName,args} | snapshot{id,options} | stats{id}
 *                   fetch-reply{id,ok,status,statusText,body|error}
 *                   store-reply{id,ok,result|error}
 *                   port (isolated mode: talk over the port it carries from now on)
 *   worker → main : booted | stdout{data} | net-tx{frame} | state{state}
 *                   log{level,text} | flushed | stopped | exit | error{message}
 *                   downloading{flag} | export-file{name,blob}
 *                   vol-reply{id,ok,result|error}
 *                   snapshot-reply{id,ok,buffer,info|error}   (buffer: transferred)
 *                   stats-reply{id,ok,stats|error}
 *                   fetch{id,url,method}          (isolated mode)
 *                   store{id,vol,op,args}         (page-owned storage)
 * start{config} may carry config.snapshot (an ArrayBuffer or Blob) to resume
 * instead of boot. Every worker → main message is checked by the page against
 * workerMessages.js; keep the two in step.
 *
 * Isolated mode (config.isolated, see IsolatedHost.js): the worker runs in a
 * sandboxed frame under `connect-src 'none'`. It gets the engine's source and
 * wasm bytes in the config, and its XMLHttpRequest and fetch are replaced by
 * ones that ask the page (PortXHR.js), which applies its allowlist.
 */

'use strict';

import { EmulatorFactory } from './EmulatorFactory.js';
import { EmulatorEngine } from './EmulatorEngine.js';
import { makePortXHR, makePortFetch } from './PortXHR.js';
import { PortBackend } from '../volumes/PageStorage.js';

let engine = null;
let io = self;            // where messages go: the worker scope, or a port

function post(msg, transfer) {
    try { io.postMessage(msg, transfer || []); } catch { /* worker gone */ }
}

/* ---- requests to the page (fetch, page-owned storage) ------------------ */

let reqSeq = 0;
const pending = new Map();   // id -> { resolve, reject }

function ask(type, payload, transfer) {
    const id = ++reqSeq;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        post({ type, id, ...payload }, transfer);
    });
}

function answer(msg, value) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(value);
    else p.reject(new Error(msg.error || `${msg.type} failed`));
}

const fetchViaPage = (url, method) => ask('fetch', { url: String(url), method });
const storeViaPage = (vol, op, args, transfer) => ask('store', { vol, op, args }, transfer);

/* ---- engine sink ---------------------------------------------------------- */

const sink = {
    console: (b) => post({ type: 'stdout', data: b }, [b.buffer]),
    netTx: (f) => post({ type: 'net-tx', frame: f }, [f.buffer]),
    state: (s) => post({ type: 'state', state: s }),
    log: (level, text) => post({ type: 'log', level, text: String(text).slice(0, 65536) }),
    booted: () => post({ type: 'booted' }),
    exit: () => post({ type: 'exit' }),
    downloading: (flag) => post({ type: 'downloading', flag }),
    // The Blob is structured-cloneable; the object URL is worker-local, so drop
    // it and let the main thread mint its own from the Blob.
    exportFile: (name, file /*, url */) => post({ type: 'export-file', name: String(name).slice(0, 256), blob: file }),
};

self.onmessage = (ev) => {
    const msg = ev.data || {};
    // Isolated mode: the frame hands over the page's port; use only that.
    if (msg.type === 'port' && io === self && ev.ports && ev.ports[0]) {
        io = ev.ports[0];
        io.onmessage = onMessage;
        self.onmessage = null;
        return;
    }
    onMessage(ev);
};

async function onMessage(ev) {
    const msg = ev.data || {};
    switch (msg.type) {
        case 'start':  return onStart(msg.config || {});
        case 'stdin':  return engine?.sendInput(msg.data);
        case 'net-rx': return engine?.deliverFrame(msg.frame);
        case 'resize': return engine?.resize(msg.cols, msg.rows);
        case 'pause':  return void (engine && engine.pause());
        case 'resume': return void (engine && engine.resume());
        case 'fetch-reply':
            return answer(msg, { status: msg.status, statusText: msg.statusText, body: msg.body });
        case 'store-reply':
            return answer(msg, msg.result);
        case 'flush':
            if (engine) await engine.flush();
            return void post({ type: 'flushed' });
        case 'vol-op': {
            if (!engine) return void post({ type: 'vol-reply', id: msg.id, ok: false, error: 'no engine' });
            try {
                const result = await engine.volOp(msg.op, msg.volName, msg.args || {});
                const transfer = (result && result.buffer) ? [result.buffer] : [];
                post({ type: 'vol-reply', id: msg.id, ok: true, result }, transfer);
            } catch (e) {
                post({ type: 'vol-reply', id: msg.id, ok: false, error: String(e && e.message || e) });
            }
            return;
        }
        case 'snapshot': {
            try {
                if (!engine) throw new Error('no engine');
                const { blob, info } = await engine.snapshot(msg.options || {});
                // Move the bytes to the page rather than share a Blob.
                const buffer = await blob.arrayBuffer();
                post({ type: 'snapshot-reply', id: msg.id, ok: true, buffer, info }, [buffer]);
            } catch (e) {
                post({ type: 'snapshot-reply', id: msg.id, ok: false, error: String(e && e.message || e) });
            }
            return;
        }
        case 'stats':
            if (!engine) return void post({ type: 'stats-reply', id: msg.id, ok: false, error: 'no engine' });
            return void post({ type: 'stats-reply', id: msg.id, ok: true, stats: engine.stats() });
        case 'stop':
            if (engine) await engine.stopAndFlush();  // persist volumes before ack
            return void post({ type: 'stopped' });
        default:       return;
    }
}

async function onStart(config) {
    if (engine) return;
    try {
        let factory;
        if (config.isolated) {
            // No network of its own: everything goes through the page.
            globalThis.XMLHttpRequest = makePortXHR(fetchViaPage);
            globalThis.fetch = makePortFetch(fetchViaPage);
            if (typeof config.engineSource !== 'string') throw new Error('isolated mode needs the engine source');
            factory = new EmulatorFactory(config.engineSource);
        } else {
            factory = await EmulatorFactory.fromUrl(config.wasmJsUrl);
        }
        const options = {};
        if (config.storage === 'page') {
            options.makeBackend = (spec) => new PortBackend(spec.name, storeViaPage);
        }
        engine = new EmulatorEngine(factory, sink, options);
        const { engineSource, ...bootConfig } = config;   // eslint-disable-line no-unused-vars
        engine.boot({
            ...bootConfig,
            locateFile: (p) => (p.endsWith('.wasm') ? config.wasmBinUrl : p),
        });
    } catch (e) {
        post({ type: 'error', message: 'worker start failed: ' + String(e && e.message || e).slice(0, 4096) });
    }
}
