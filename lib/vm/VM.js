// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * VM.js — main-thread handle for a single TinyEMU instance.
 *
 * Delegates execution to a "host":
 *   - InlineHost  (config.mode === 'inline')  runs in this realm via the
 *                 EmulatorFactory closure wrapping (many VMs, one thread, no rebuild)
 *   - WorkerHost  (config.mode === 'worker', DEFAULT) runs in its own Web Worker
 *
 * Both hosts share EmulatorEngine, so behaviour is identical; only isolation and
 * threading differ. VM owns lifecycle state, events, stats, and I/O routing.
 * Networking and volumes are wired by VMManager.
 */

'use strict';

import { InlineHost } from './InlineHost.js';
import { WorkerHost } from './WorkerHost.js';
import { loadConfig, parseConfig } from './TinyemuConfig.js';

export const VMState = {
    NEW: 'new',
    STARTING: 'starting',
    RUNNING: 'running',
    PAUSED: 'paused',
    STOPPED: 'stopped',
    ERROR: 'error',
};

export class VM {
    /**
     * @param {string} id
     * @param {object} config  { configUrl, configOverride?, memoryMB, cmdline, hasNetwork,
     *                           width, height, cols, rows, mac, volumes,
     *                           mode: 'worker'|'inline', snapshot?: Blob,
     *                           x86jit?: boolean, x86jitThreshold?: number,
     *                           x86jitTailcalls?: boolean }
     * @param {object} urls    { workerUrl, wasmJsUrl, wasmBinUrl } (absolute)
     */
    constructor(id, config = {}, urls = {}) {
        this.id = id;
        this.config = config;
        this.mode = config.mode === 'inline' ? 'inline' : 'worker';
        this.mac = config.mac || null;          // filled by VMManager if absent
        this.ip = null;                         // the guest's IPv4 address, once seen
        this.state = VMState.NEW;

        this._urls = urls;
        this._host = null;
        this._handlers = new Map();

        this.netDevice = null;                  // set by VMManager
        this.volumes = [];                      // set by VMManager

        this.stats = { rxFrames: 0, txFrames: 0, rxBytes: 0, txBytes: 0, bootedAt: null };
    }

    /* ---- event emitter ------------------------------------------------ */

    on(event, cb) {
        if (!this._handlers.has(event)) this._handlers.set(event, new Set());
        this._handlers.get(event).add(cb);
        return () => this.off(event, cb);
    }
    off(event, cb) { this._handlers.get(event)?.delete(cb); }
    _emit(event, ...args) {
        this._handlers.get(event)?.forEach(cb => {
            try { cb(...args); } catch (e) { console.error(`VM ${this.id} handler`, e); }
        });
    }

    onConsole(cb) { return this.on('console', cb); }   // (Uint8Array)
    onState(cb)   { return this.on('state', cb); }     // (VMState)
    onNetTx(cb)   { return this.on('net-tx', cb); }    // (Uint8Array) guest→net
    onLog(cb)     { return this.on('log', cb); }       // ({level,text})
    onError(cb)   { return this.on('error', cb); }     // (Error)
    onAddress(cb) { return this.on('address', cb); }   // (string) guest IPv4, from VMManager

    /* ---- lifecycle ---------------------------------------------------- */

    start() {
        if (this.state !== VMState.NEW && this.state !== VMState.STOPPED) {
            return Promise.reject(new Error(`VM ${this.id} already ${this.state}`));
        }
        this._setState(VMState.STARTING);

        const sink = {
            console: (b) => this._emit('console', b),
            netTx: (f) => {
                this.stats.txFrames++; this.stats.txBytes += (f?.length || 0);
                this._emit('net-tx', f);
            },
            state: (s) => this._setState(s),
            log: (level, text) => this._emit('log', { level, text }),
            error: (err) => { this._setState(VMState.ERROR); this._emit('error', err); },
            downloading: (flag) => this._emit('downloading', flag),
            exportFile: (name, file, url) => this._emit('export-file', { name, file, url }),
        };

        const HostCtor = this.mode === 'inline' ? InlineHost : WorkerHost;
        this._host = new HostCtor(this._urls, sink);

        // configUrl: http(s), blob: or data:, relative to the page.
        const configUrl = new URL(this.config.configUrl, location.href).href;
        // TinyEMU's virtio rings hold 16 buffers, but Linux's virtio-net (with
        // NAPI transmit, the default) only wakes its stopped TX queue once
        // 2 + MAX_SKB_FRAGS (19) are free: the guest sends one frame and then
        // nothing. napi_tx=0 wakes the queue on every TX interrupt instead.
        // Added to the distro's own kernel command line (TinyEMU appends it).
        const netFix = this.config.hasNetwork !== false && this.config.napiTxFix !== false
            ? 'virtio_net.napi_tx=0' : '';
        const cfg = {
            configUrl,
            // Relative file URLs are relative to the page, also in a worker.
            pageUrl: location.href,
            memoryMB: this.config.memoryMB,
            cmdline: [this.config.cmdline, netFix].filter(Boolean).join(' '),
            hasNetwork: this.config.hasNetwork,
            width: this.config.width,
            height: this.config.height,
            cols: this.config.cols,
            rows: this.config.rows,
            driveUrl: this.config.driveUrl,
            volumes: this.config.volumes,
            snapshot: this.config.snapshot,
            // x86 WebAssembly JIT (TinyEMU's wasm/x86jit.js); on unless false
            x86jit: this.config.x86jit,
            x86jitThreshold: this.config.x86jitThreshold,
            x86jitTailcalls: this.config.x86jitTailcalls,
        };

        // With a configOverride the .cfg is fetched and changed here, on the
        // main thread (a function can't be posted to a worker), and the engine
        // boots a data: URL of the result. A snapshot resume reads no config.
        // Without memoryMB the guest gets the .cfg's memory_size, so the config
        // is read here too. It is passed on as memoryMB, since an engine before
        // 2026-11-23 takes vm_start's RAM size even when it is 0.
        const override = this.config.configOverride;
        const memoryMB = this.config.memoryMB | 0;
        const read = !this.config.snapshot && (override != null || !memoryMB);
        const resolved = read
            ? loadConfig({ configUrl, configOverride: override, pageUrl: location.href })
            : Promise.resolve({ url: configUrl, config: null });

        return resolved.then((r) => {
            cfg.configUrl = r.url;
            this.resolvedConfig = r.config;   // the config booted, when overridden
            if (!memoryMB && read) {
                let size;
                try { size = (r.config || parseConfig(r.text)).memory_size; } catch { /* the engine reports it */ }
                if (Number.isInteger(size) && size > 0) cfg.memoryMB = size;
            }
            return this._host.start(cfg);
        }).then(() => {
            this.stats.bootedAt = Date.now();
            return this;
        }).catch((e) => {
            this._setState(VMState.ERROR);
            throw e;
        });
    }

    stop() { this._host?.stop(); this._host = null; this._setState(VMState.STOPPED); }

    /** Persist attached JS volumes to their backends. Resolves when durable. */
    async flush() { return this._host?.flush?.(); }

    /* ---- live volume "hotplug": inject/extract files at runtime ---------
     * Operate on a mounted JS `files` (9p) volume while the guest runs. Changes
     * are visible to the guest immediately (9p is uncached). `volName` is the
     * volume's `name` (the `js:<name>` in the cfg). */

    /** Write/overwrite a file in a live volume. @param {Uint8Array|string} data */
    volumePutFile(volName, path, data) {
        const u8 = typeof data === 'string' ? new TextEncoder().encode(data)
                 : (data instanceof Uint8Array ? data
                 : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                 : new Uint8Array(data));   // ArrayBuffer or array-like
        const copy = new Uint8Array(u8);    // compact, owns its buffer; safe to transfer
        return this._host?.volOp('put', volName, { path, data: copy }, [copy.buffer]);
    }
    /** Read a whole file from a live volume → Uint8Array (or null if missing). */
    volumeGetFile(volName, path) { return this._host?.volOp('get', volName, { path }); }
    /** List a directory → [{ name, dir, size }] (or null). */
    volumeList(volName, path = '/') { return this._host?.volOp('list', volName, { path }); }
    /** Recursively remove a path from a live volume. */
    volumeDelete(volName, path) { return this._host?.volOp('delete', volName, { path }); }
    /** Ensure a directory (and parents) exists in a live volume. */
    volumeMkdir(volName, path) { return this._host?.volOp('mkdir', volName, { path }); }
    /** Move a file or folder within a volume: 0, or a negative errno. */
    volumeRename(volName, from, to) { return this._host?.volOp('rename', volName, { from, to }); }
    /** Force-persist one volume to its backend now. */
    volumeFlush(volName) { return this._host?.volOp('flush', volName, {}); }

    /**
     * The engine's counters: { cycles (instructions run, -1 if the build can't
     * say), diskChunks, diskBytes (disk chunks downloaded), volumes: { name:
     * { reads, readBytes, writes, writeBytes } } } (the guest's 9p traffic).
     */
    engineStats() { return this._host?.stats?.() ?? Promise.reject(new Error('VM not running')); }

    /**
     * Save the running machine: memory, CPU, devices and the disk changes held in
     * memory (not attached JS volumes, which persist on their own). Start a VM with
     * config.snapshot set to the Blob to resume it, with the same wasm build and
     * config: see lib/vm/snapshot.js and SnapshotStore.js.
     * @returns {Promise<{blob: Blob, info: object}>}
     */
    saveSnapshot(options = {}) {
        if (!this._host) return Promise.reject(new Error(`VM ${this.id} is not running`));
        return this._host.snapshot(options);
    }

    /**
     * Best-effort pause. Resolves true only if the WASM actually suspended
     * (requires the C-side vm_pause export — see plan-c-changes.md §2).
     */
    async pause() {
        if (this.state !== VMState.RUNNING || !this._host) return false;
        return this._host.pause();
    }

    async resume() {
        if (this.state !== VMState.PAUSED || !this._host) return false;
        return this._host.resume();
    }

    /* ---- I/O ---------------------------------------------------------- */

    /** @param {string|Uint8Array} data */
    sendInput(data) { this._host?.sendInput(data); }

    /** Deliver a frame from the virtual network INTO the guest. */
    deliverFrame(frame) {
        if (!this._host) return;
        this.stats.rxFrames++; this.stats.rxBytes += (frame?.length || 0);
        this._host.deliverFrame(frame);
    }

    resize(cols, rows) {
        this.config.cols = cols; this.config.rows = rows;
        this._host?.resize(cols, rows);
    }

    /* ---- misc --------------------------------------------------------- */

    _setAddress(ip) {
        if (this.ip === ip) return;
        this.ip = ip;
        this._emit('address', ip);
    }

    _setState(state) {
        if (this.state === state) return;
        this.state = state;
        this._emit('state', state);
    }

    getStats() { return { ...this.stats, state: this.state, mac: this.mac, ip: this.ip, mode: this.mode }; }

    toJSON() {
        return {
            id: this.id, state: this.state, mac: this.mac, ip: this.ip, mode: this.mode,
            config: { configUrl: this.config.configUrl, memoryMB: this.config.memoryMB },
            stats: this.getStats(),
            volumes: this.volumes.map(v => v.name),
        };
    }
}
