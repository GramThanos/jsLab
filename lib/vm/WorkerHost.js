// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * WorkerHost.js — run a VM in its own Web Worker (module worker). Keeps a busy
 * guest's CPU loop off the UI thread and makes `stop` clean (terminate the
 * worker). The worker (vm-worker.js) uses the SAME EmulatorFactory/Engine, so
 * behaviour matches InlineHost exactly.
 *
 * Every message from the worker is checked against a fixed table of types and
 * fields (workerMessages.js) before it is acted on, and dropped if it doesn't
 * fit or isn't allowed for this VM (net-tx without a NIC, export-file unless
 * the embedder opted in, storage requests unless the page owns the storage).
 *
 * With policy.pageStorage the page opens the VM's volume backends itself
 * (PageStorage.js) and serves the worker's requests for them; the worker is
 * told only the volume names. IsolatedHost (isolated mode) builds on this.
 */

'use strict';

import { checkWorkerMessage } from './workerMessages.js';
import { PageStorage } from '../volumes/PageStorage.js';

const MAX_DROP_LOGS = 10;     // log the first few dropped messages, then count
const MAX_IN_FLIGHT = 256;    // fetch / storage requests from the worker at once

export class WorkerHost {
    /**
     * @param {object} urls    { workerUrl, wasmJsUrl, wasmBinUrl }
     * @param {object} sink    the VM's callbacks (see VM.start)
     * @param {object} [policy]
     * @param {boolean} [policy.hasNetwork=true]   the VM has a NIC: accept net-tx
     * @param {boolean} [policy.exportFiles=false] accept export-file (an object URL per file)
     * @param {boolean} [policy.pageStorage=false] the page owns the volumes' storage
     */
    constructor(urls, sink, policy = {}) {
        this.urls = urls;
        this.sink = sink;
        this.policy = {
            hasNetwork: policy.hasNetwork !== false,
            exportFiles: !!policy.exportFiles,
            pageStorage: !!policy.pageStorage,
            fetch: false,                  // IsolatedHost: requests through the page
        };
        this.worker = null;   // the channel to the worker, while it takes new work
        this._ch = null;      // the channel, until it is torn down (replies during stop)
        this._stopped = false;
        this._startResolve = null;
        this._startReject = null;
        this._pauseWaiter = null;
        this._flushWaiter = null;
        this._stoppedWaiter = null;
        this._seq = 0;
        this._waiters = new Map();   // id -> { kind, resolve, reject }
        this._inFlight = 0;
        this.pageStorage = null;     // PageStorage, with policy.pageStorage
        this.requests = null;        // RequestPolicy, in isolated mode
        this.dropped = 0;            // messages from the worker refused
    }

    /** Make the channel to the worker: { postMessage, terminate, onmessage, onerror }. */
    _spawn() {
        return new Worker(this.urls.workerUrl, { type: 'module' });
    }

    /**
     * The config the worker gets, and what to transfer with it.
     * @returns {Promise<{ config: object, transfer: Transferable[] }>}
     */
    async _prepare(config) {
        const cfg = { ...config, wasmJsUrl: this.urls.wasmJsUrl, wasmBinUrl: this.urls.wasmBinUrl };
        const transfer = [];
        if (this.policy.pageStorage) {
            this.pageStorage = new PageStorage(config.volumes || []);
            cfg.volumes = this.pageStorage.workerSpecs();
            cfg.storage = 'page';
        }
        // A snapshot (~32 MB) moves to the worker instead of being copied.
        if (cfg.snapshot && typeof cfg.snapshot.arrayBuffer === 'function') {
            cfg.snapshot = await cfg.snapshot.arrayBuffer();
        }
        if (cfg.snapshot instanceof ArrayBuffer) transfer.push(cfg.snapshot);
        return { config: cfg, transfer };
    }

    start(config) {
        this._stopped = false;
        return new Promise((resolve, reject) => {
            this._startResolve = resolve;
            this._startReject = reject;
            this._prepare(config).then(({ config: cfg, transfer }) => {
                if (this._stopped) throw new Error('stopped before it started');
                const ch = this._spawn();
                this.worker = this._ch = ch;
                ch.onmessage = (ev) => this._onMessage(ev.data);
                ch.onerror = (e) => {
                    const err = new Error(e?.message || 'worker error');
                    this.sink.error(err);
                    this._startReject?.(err);
                    this._startResolve = this._startReject = null;
                };
                ch.postMessage({ type: 'start', config: cfg }, transfer);
            }).catch((e) => {
                this._startReject?.(e);
                this._startResolve = this._startReject = null;
            });
        });
    }

    _drop(why) {
        this.dropped++;
        if (this.dropped <= MAX_DROP_LOGS) {
            this.sink.log('err', `dropped a message from the VM worker: ${why}`
                + (this.dropped === MAX_DROP_LOGS ? ' (further drops are only counted)' : ''));
        }
    }

    _reply(msg, transfer) {
        try { this._ch?.postMessage(msg, transfer || []); } catch { /* worker gone */ }
    }

    /* A reply to one of our requests: only for an id we issued, of its kind. */
    _settle(kind, msg, value, fallback) {
        const w = this._waiters.get(msg.id);
        if (!w || w.kind !== kind) return this._drop(`${kind} reply for an unknown request`);
        this._waiters.delete(msg.id);
        if (msg.ok) w.resolve(value);
        else w.reject(new Error(msg.error || fallback));
    }

    _onMessage(msg) {
        const why = checkWorkerMessage(msg, this.policy);
        if (why) return this._drop(why);
        switch (msg.type) {
            case 'booted':
                this._startResolve?.(); this._startResolve = this._startReject = null; break;
            case 'stdout': this.sink.console(msg.data); break;
            case 'net-tx': this.sink.netTx(msg.frame); break;
            case 'state':
                this.sink.state(msg.state);
                if (msg.state === 'paused' && this._pauseWaiter) this._pauseWaiter(true);
                break;
            case 'log': this.sink.log(msg.level, msg.text); break;
            case 'flushed': if (this._flushWaiter) this._flushWaiter(); break;
            case 'vol-reply': this._settle('vol', msg, msg.result, 'volume op failed'); break;
            case 'stats-reply': this._settle('stats', msg, msg.stats, 'no statistics'); break;
            case 'snapshot-reply':
                if (msg.ok && !msg.buffer) return this._drop('snapshot-reply without its buffer');
                this._settle('snapshot', msg, msg.ok ? { blob: new Blob([msg.buffer]), info: msg.info || {} } : null,
                             'snapshot failed');
                break;
            case 'stopped':
                if (this._stoppedWaiter) this._stoppedWaiter();
                this.sink.state('stopped');
                break;
            case 'downloading': this.sink.downloading && this.sink.downloading(msg.flag); break;
            case 'export-file': {
                if (this.sink.exportFile) {
                    const blob = msg.blob instanceof Blob ? msg.blob
                        : new Blob([msg.blob], { type: 'application/octet-stream' });
                    this.sink.exportFile(msg.name, blob, URL.createObjectURL(blob));
                }
                break;
            }
            case 'error': {
                const err = new Error(msg.message);
                this.sink.error(err);
                this._startReject?.(err); this._startResolve = this._startReject = null;
                break;
            }
            case 'exit': this.sink.state('stopped'); break;
            case 'fetch': this._serve('fetch-reply', msg.id, () => this._fetchFor(msg)); break;
            case 'store': this._serve('store-reply', msg.id, () => this._storeFor(msg)); break;
        }
    }

    /* Run a request from the worker and post its reply ({ id, ok, ... }). */
    _serve(type, id, run) {
        if (this._inFlight >= MAX_IN_FLIGHT) {
            return this._reply({ type, id, ok: false, error: 'too many requests at once' });
        }
        this._inFlight++;
        Promise.resolve().then(run).then(({ reply, transfer }) => {
            this._reply({ type, id, ok: true, ...reply }, transfer);
        }, (e) => {
            this._reply({ type, id, ok: false, error: String(e && e.message || e).slice(0, 500) });
        }).finally(() => { this._inFlight--; });
    }

    async _fetchFor(msg) {
        if (!this.requests) throw new Error('requests are not served for this VM');
        const r = await this.requests.fetch(msg.url, msg.method);
        return { reply: { status: r.status, statusText: r.statusText, body: r.body }, transfer: [r.body] };
    }

    async _storeFor(msg) {
        if (!this.pageStorage) throw new Error('no page-owned storage');
        const { result, transfer } = await this.pageStorage.handle(msg.vol, msg.op, msg.args);
        return { reply: { result }, transfer };
    }

    /* Post a request that the worker answers by id. */
    _request(kind, msg, transfer) {
        if (!this.worker) return Promise.reject(new Error('VM not running'));
        const id = ++this._seq;
        return new Promise((resolve, reject) => {
            this._waiters.set(id, { kind, resolve, reject });
            this.worker.postMessage({ ...msg, id }, transfer || []);
        });
    }

    sendInput(data) { this.worker?.postMessage({ type: 'stdin', data }); }

    deliverFrame(frame) {
        if (!this.worker || !this.policy.hasNetwork) return;
        const copy = new Uint8Array(frame);
        this.worker.postMessage({ type: 'net-rx', frame: copy }, [copy.buffer]);
    }

    resize(cols, rows) { this.worker?.postMessage({ type: 'resize', cols, rows }); }

    pause() {
        if (!this.worker) return Promise.resolve(false);
        this.worker.postMessage({ type: 'pause' });
        return new Promise((resolve) => {
            const to = setTimeout(() => { this._pauseWaiter = null; resolve(false); }, 1000);
            this._pauseWaiter = (ok) => { clearTimeout(to); this._pauseWaiter = null; resolve(ok); };
        });
    }

    resume() { this.worker?.postMessage({ type: 'resume' }); return Promise.resolve(true); }

    flush() {
        if (!this.worker) return Promise.resolve();
        this.worker.postMessage({ type: 'flush' });
        return new Promise((resolve) => {
            const to = setTimeout(() => { this._flushWaiter = null; resolve(); }, 5000);
            this._flushWaiter = () => { clearTimeout(to); this._flushWaiter = null; resolve(); };
        });
    }

    volOp(op, volName, args, transfer) {
        return this._request('vol', { type: 'vol-op', op, volName, args }, transfer);
    }

    snapshot(options) { return this._request('snapshot', { type: 'snapshot', options }); }

    /** The engine's counters (EmulatorEngine.stats). */
    stats() { return this._request('stats', { type: 'stats' }); }

    stop() {
        this._stopped = true;
        const ch = this._ch;
        if (!ch) { this.sink.state('stopped'); return; }
        this.worker = null;   // stop routing new work; keep `_ch` for teardown
        // Ask the worker to flush volumes, then terminate. Bounded so a wedged
        // worker can't hang teardown. Volume writes also autosave every ~3 s.
        // Page-owned storage keeps serving the worker until then.
        let done = false;
        const finish = () => {
            if (done) return; done = true;
            try { ch.terminate(); } catch {}
            if (this._ch === ch) this._ch = null;
            this._stoppedWaiter = null;
            for (const w of this._waiters.values()) w.reject(new Error('VM stopped'));
            this._waiters.clear();
            this.pageStorage?.close();
            this.sink.state('stopped');
        };
        this._stoppedWaiter = finish;
        try { ch.postMessage({ type: 'stop' }); } catch { finish(); return; }
        setTimeout(finish, 5000);
    }
}
