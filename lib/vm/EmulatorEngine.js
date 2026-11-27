// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * EmulatorEngine.js — drives ONE isolated Module produced by EmulatorFactory.
 *
 * This is the single place that knows the emulator's JS<->C contract (the
 * `term` / `net_state` bridge objects and the cwrap'd exports). It is used both
 * on the main thread (InlineHost) and inside a worker (vm-worker.js), so the two
 * execution modes share identical boot and I/O behaviour.
 *
 * The caller supplies a `sink` of callbacks:
 *   console(bytes:Uint8Array)   guest console output
 *   netTx(frame:Uint8Array)     frame the guest transmitted (→ virtual network)
 *   state(s:string)             'running' | 'paused' | 'stopped'
 *   log(level:string, text)     print / printErr / diagnostics
 *   booted()                    runtime up and vm_start issued
 *   exit()                      engine stopped
 */

'use strict';

import { Fs9pStore } from '../volumes/Fs9pStore.js';
import { OverlayBlockStore, makeHttpBase } from '../volumes/OverlayBlockStore.js';
import { IndexedDBBackend } from '../volumes/backends/IndexedDBBackend.js';
import { OPFSBackend } from '../volumes/backends/OPFSBackend.js';
import { FileSystemAccessBackend } from '../volumes/backends/FileSystemAccessBackend.js';
import { applySnapshot, captureSnapshot, decodeSnapshot, encodeSnapshot, ioPending } from './snapshot.js';

const VOL_BACKENDS = {
    indexeddb: IndexedDBBackend, idb: IndexedDBBackend,
    opfs: OPFSBackend,
    fsaccess: FileSystemAccessBackend, filesystem: FileSystemAccessBackend,
};

const INPUT_SLICE = 128;   // console bytes per tick (the C FIFO holds 1024)
const INPUT_TICK = 20;     // ms

export class EmulatorEngine {
    /**
     * @param {import('./EmulatorFactory.js').EmulatorFactory} factory
     * @param {object} sink
     * @param {object} [options]
     * @param {(spec:object, type:string) => object} [options.makeBackend]
     *        the StorageBackend for a volume, instead of the one its spec names
     *        (page-owned storage: a PortBackend that asks the page)
     */
    constructor(factory, sink, options = {}) {
        this.factory = factory;
        this.sink = sink;
        this._backendFor = options.makeBackend || null;
        this.Module = null;
        this.running = false;

        this._cols = 80;
        this._rows = 30;

        this._c_queue = null;      // console_queue_char
        this._inQueue = [];        // console input not yet handed to the C FIFO
        this._inTimer = null;
        this._c_netWrite = null;   // net_write_packet
        this._c_carrier = null;    // net_set_carrier
        this._c_pause = null;      // vm_pause   (only after C rebuild)
        this._c_resume = null;     // vm_resume  (only after C rebuild)
        this._c_stop = null;       // vm_stop    (only after C rebuild)

        this._stores = [];         // Fs9pStore[] for js: 9p volumes
        this._blkBackends = [];    // StorageBackend[] for js: block disks
        this._autosave = null;     // periodic flush timer
        this._paused = false;      // paused by pause(), so a snapshot leaves it paused
    }

    /** Start the machine. `config` mirrors VM config plus `locateFile`. */
    boot(config) {
        this._cols = config.cols | 0 || 80;
        this._rows = config.rows | 0 || 30;
        this._config = config;

        const sink = this.sink;

        // The Module.api surface lib.js calls into (see TinyEMU's wasm/lib.js).
        //
        // The emulator's run loop self-reschedules in C and cannot be stopped
        // from JS without a C-side vm_stop export. In inline mode a "stopped" VM
        // therefore keeps ticking, so these emit-side callbacks must honour
        // `this.running` — otherwise a stopped/destroyed VM keeps pumping frames
        // into the shared VirtualNetwork and console bytes to a detached UI.
        const api = {
            terminal: {
                // `data` is a Uint8Array (HEAP view) from the current lib.js, or a
                // string from an older prebuilt wasm — handle both. Either way copy
                // out of the HEAP before it can move/change.
                write: (data) => {
                    if (!this.running) return;
                    let b;
                    if (typeof data === 'string') {
                        b = new Uint8Array(data.length);
                        for (let i = 0; i < data.length; i++) b[i] = data.charCodeAt(i) & 0xff;
                    } else {
                        b = new Uint8Array(data);   // copy out of HEAPU8 view
                    }
                    sink.console(b);
                },
                getSize: () => [this._cols, this._rows],
            },
            net: {
                recvPacket: (u8) => { if (this.running) sink.netTx(new Uint8Array(u8)); },  // copy out of HEAP
            },
            downloading: {
                update: (flag) => sink.downloading && sink.downloading(!!flag),
            },
            // wget request handle table used by emscripten_async_wget3_data
            wgetRequests: (() => {
                const table = {}; let next = 1;
                return {
                    new(http) { const h = next++; table[h] = http; return h; },
                    remove(h) { delete table[h]; },
                    instance: table,
                };
            })(),
            export_file: (name, file, url) => sink.exportFile && sink.exportFile(name, file, url),
            display: null,
            // JS-backed 9p volumes: handle->store and name->store, populated in
            // _onReady BEFORE vm_start (js_fs_mount resolves names from here).
            fs9p: { list: [], byName: {} },
            // JS-backed block disks: handle->{backend,sectorCount} (js_block_*).
            blk: { list: [], byName: {} },
        };

        this._api = api;
        this.Module = this.factory.create({
            locateFile: config.locateFile,
            wasmBinary: config.wasmBinary,   // isolated mode: the page fetched it
            pageUrl: config.pageUrl,
            x86jit: config.x86jit,
            x86jitThreshold: config.x86jitThreshold,
            x86jitTailcalls: config.x86jitTailcalls,
            api,
            print:    (t) => sink.log('log', String(t)),
            printErr: (t) => sink.log('err', String(t)),
            onReady:  (M) => { this._onReady(M); },
        });
    }

    /** Build + open volumes and register them so js_fs_mount / js_block_mount
     *  resolve them during vm_start. Must finish before boot. `files` volumes
     *  become in-memory 9p stores; `block` volumes wrap a backend's sector I/O. */
    async _setupVolumes() {
        for (const spec of (this._config.volumes || [])) {
            const type = spec.type || 'files';
            try {
                if (type === 'files') {
                    const store = await Fs9pStore.fromSpec(spec,
                        this._backendFor ? { backend: this._backendFor(spec, 'files') } : {});
                    store.vol = this._api.fs9p.list.length;
                    this._countIO(spec.name, store);
                    this._api.fs9p.list.push(store);
                    this._api.fs9p.byName[spec.name] = store;
                    this._stores.push(store);
                } else if (type === 'block') {
                    // baseUrl => copy-on-write overlay over an HTTP base image;
                    // otherwise a plain fresh persistent disk (sized by sizeMB).
                    let backend, sectorCount;
                    if (spec.baseUrl) {
                        // Relative to the page (in a worker, location is the script).
                        const page = this._config.pageUrl || location.href;
                        const base = await makeHttpBase(new URL(spec.baseUrl, page).href);
                        const overlay = this._makeBackend(spec, 'block');
                        await overlay.open();
                        backend = new OverlayBlockStore({ sectorCount: base.sectorCount,
                                                          readBase: base.readBase, overlay });
                        await backend.open();
                        sectorCount = base.sectorCount;
                    } else {
                        backend = this._makeBackend(spec, 'block');
                        await backend.open();
                        sectorCount = await backend.getSectorCount();
                    }
                    const entry = { vol: this._api.blk.list.length, name: spec.name,
                                    backend, sectorCount };
                    this._api.blk.list.push(entry);
                    this._api.blk.byName[spec.name] = entry;
                    this._blkBackends.push(backend);
                }
            } catch (e) {
                this.sink.log('err', `volume '${spec.name}' setup failed: ` + (e && e.message || e));
            }
        }
    }

    /* Count the guest's 9p reads and writes on a volume, for stats(). */
    _countIO(name, store) {
        const c = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 };
        (this._io ||= {})[name] = c;
        const read = store.read.bind(store);
        const write = store.write.bind(store);
        store.read = (...a) => {
            const r = read(...a);
            c.reads++;
            if (r && Number.isFinite(r.length)) c.readBytes += r.length;
            return r;
        };
        store.write = (path, offset, src) => {
            const r = write(path, offset, src);
            c.writes++;
            c.writeBytes += src?.length || 0;
            return r;
        };
    }

    /** Counters for the page (see VM.engineStats). Cheap: no C state is copied. */
    stats() {
        const M = this.Module;
        const num = (sym) => (M && this._has(M, sym) ? M[sym]() : -1);
        return {
            cycles: this.running ? num('_vm_cycles') : -1,
            diskChunks: num('_vm_disk_chunks'),
            diskBytes: num('_vm_disk_bytes'),
            jitBlocks: num('_vm_jit_blocks'),   // x86 JIT blocks compiled (recompiles count again); -1: off
            volumes: JSON.parse(JSON.stringify(this._io || {})),
            at: performance.now(),
        };
    }

    _makeBackend(spec, type) {
        if (this._backendFor) return this._backendFor(spec, type);
        const Ctor = VOL_BACKENDS[(spec.backend || 'indexeddb').toLowerCase()];
        if (!Ctor) throw new Error(`unknown volume backend ${spec.backend}`);
        return new Ctor(spec.storageKey || spec.name, { ...spec, type });
    }

    async _onReady(M) {
        try {
            await this._setupVolumes();
        } catch (e) {
            this.sink.log('err', 'volume setup failed: ' + (e && e.message || e));
        }
        try {
            const cfg = this._config;
            this._c_queue    = M.cwrap('console_queue_char', null, ['number']);
            this._c_netWrite = M.cwrap('net_write_packet',   null, ['number', 'number']);
            this._c_carrier  = M.cwrap('net_set_carrier',    null, ['number']);
            if (this._has(M, '_vm_pause'))  this._c_pause  = M.cwrap('vm_pause',  null, []);
            if (this._has(M, '_vm_resume')) this._c_resume = M.cwrap('vm_resume', null, []);
            if (this._has(M, '_vm_stop'))   this._c_stop   = M.cwrap('vm_stop',   null, []);

            const hasNetwork = cfg.hasNetwork === false ? 0 : 1;
            if (cfg.snapshot) {
                // Resume a saved machine instead of booting one: its memory
                // already holds the configured devices and the carrier state.
                if (!this._has(M, '_vm_restore')) throw new Error('this build cannot restore snapshots');
                applySnapshot(M, this._api, await decodeSnapshot(cfg.snapshot));
                this.sink.log('log', 'resumed from a snapshot');
            } else {
                // vm_start(url, ram_size, cmdline, pwd, width, height, has_network)
                M.ccall('vm_start', null,
                    ['string', 'number', 'string', 'string', 'number', 'number', 'number'],
                    [cfg.configUrl, cfg.memoryMB | 0 || 256, cfg.cmdline || '', null,
                     cfg.width | 0 || 0, cfg.height | 0 || 0, hasNetwork]);
                if (hasNetwork) this._c_carrier(1);
            }

            this.running = true;
            this._startAutosave();
            this.sink.state('running');
            this.sink.booted();
        } catch (e) {
            this.sink.log('err', 'vm_start failed: ' + (e && e.message || e));
        }
    }

    _has(M, sym) { return typeof M[sym] === 'function'; }

    /**
     * Save the running machine (see snapshot.js). Waits up to `waitMs` for
     * downloads and disk requests in flight to finish, then pauses the run loop
     * only while the state is copied out.
     * @returns {Promise<{blob: Blob, info: object}>}
     */
    async snapshot({ waitMs = 15000 } = {}) {
        const M = this.Module;
        if (!this.running || !M || !this._has(M, '_vm_snapshot_clock')) {
            throw new Error(this.running ? 'this build cannot take snapshots' : 'the VM is not running');
        }
        const deadline = Date.now() + waitMs;
        while (ioPending(this._api)) {
            if (Date.now() > deadline) throw new Error('the VM kept I/O in flight; try again');
            await new Promise((r) => setTimeout(r, 50));
        }
        const t0 = performance.now();
        let capture;
        M._vm_pause();
        try {
            capture = captureSnapshot(M, this._api, M._vm_snapshot_clock());
        } finally {
            if (!this._paused) M._vm_resume();
        }
        const pausedMs = performance.now() - t0;
        const blob = await encodeSnapshot(capture);
        const { header } = capture;
        return {
            blob,
            info: {
                memoryBytes: header.memSize,
                savedPages: header.pages,
                diskBuffers: header.fbuf.length,
                bytes: blob.size,
                pausedMs: Math.round(pausedMs),
            },
        };
    }

    /* Periodically persist dirty volume stores so an abrupt stop (e.g. worker
     * terminate) loses at most the last interval of writes. */
    _startAutosave() {
        if (this._autosave) return;
        if (this._stores.length === 0 && this._blkBackends.length === 0) return;
        this._autosave = setInterval(() => { this.flush(); }, 3000);
    }

    /**
     * Live volume operation from the host (JS "hotplug" of files into/out of a
     * mounted 9p volume). Runs on the same event loop as the guest's js_fs_*
     * calls, so there's no concurrency hazard. Returns a value for `get`/`list`.
     */
    async volOp(op, volName, args = {}) {
        const store = this._api && this._api.fs9p && this._api.fs9p.byName[volName];
        if (!store) throw new Error(`no files volume '${volName}'`);
        switch (op) {
            case 'put':    return store.putFile(args.path, args.data || new Uint8Array(0));
            case 'get':    return store.getFile(args.path);
            case 'list':   return store.listDir(args.path);
            case 'delete': return store.removePath(args.path);
            case 'mkdir':  store._mkdirp(args.path); return 0;
            case 'rename': return store.rename(args.from, args.to);
            case 'flush':  await store.flush(); return 0;
            default: throw new Error(`unknown volume op '${op}'`);
        }
    }

    /** Names of the mounted JS files volumes. */
    volumeNames() {
        return this._api && this._api.fs9p ? Object.keys(this._api.fs9p.byName) : [];
    }

    /** Persist all volumes (9p stores + block backends). Resolves when durable. */
    async flush() {
        const jobs = [];
        for (const s of this._stores)
            jobs.push(s.flush().catch(e => this.sink.log('err', `volume '${s.name}' flush failed: ` + (e && e.message || e))));
        for (const b of this._blkBackends)
            if (b.flush) jobs.push(b.flush().catch(e => this.sink.log('err', `block '${b.name}' flush failed: ` + (e && e.message || e))));
        await Promise.all(jobs);
    }

    // TinyEMU's console input FIFO holds 1 KiB and drops what doesn't fit, so a
    // paste or a typed-in file is handed over a slice at a time: up to
    // INPUT_SLICE bytes every INPUT_TICK ms, which the guest keeps up with. In a
    // background tab both these ticks and the emulator slow down, so a late tick
    // must not try to catch up: the guest isn't reading any faster.
    sendInput(data) {
        if (!this.running || !this._c_queue) return;
        // The console takes bytes: send text as UTF-8, so non-ASCII input
        // (pasted text, accented keys) reaches the guest intact.
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
        if (!bytes.length) return;
        this._inQueue.push(bytes);
        if (!this._inTimer) this._drainInput();
    }

    _drainInput() {
        this._inTimer = null;
        if (!this.running) { this._inQueue.length = 0; return; }
        let budget = INPUT_SLICE;
        while (budget > 0 && this._inQueue.length) {
            const head = this._inQueue[0];
            const n = Math.min(budget, head.length);
            for (let i = 0; i < n; i++) this._c_queue(head[i]);
            budget -= n;
            if (n === head.length) this._inQueue.shift();
            else this._inQueue[0] = head.subarray(n);
        }
        if (this._inQueue.length) this._inTimer = setTimeout(() => this._drainInput(), INPUT_TICK);
    }

    _clearInput() {
        if (this._inTimer) { clearTimeout(this._inTimer); this._inTimer = null; }
        this._inQueue.length = 0;
    }

    deliverFrame(frame) {
        if (!this.running || !this._c_netWrite || !frame || !frame.length) return;
        const M = this.Module;
        const len = frame.length;
        const ptr = M._malloc(len);
        M.HEAPU8.set(frame, ptr);        // read HEAPU8 fresh: it moves on growth
        this._c_netWrite(ptr, len);
        M._free(ptr);
    }

    resize(cols, rows) {
        if (cols) this._cols = cols | 0;
        if (rows) this._rows = rows | 0;
    }

    pause() {
        if (!this.running) return false;
        if (this._c_pause) { this._c_pause(); this._paused = true; this.sink.state('paused'); return true; }
        this.sink.log('err', 'pause unsupported: rebuild C with vm_pause/vm_resume (plan-c-changes.md §2)');
        return false;
    }

    resume() {
        if (this._c_resume) { this._c_resume(); this._paused = false; this.sink.state('running'); return true; }
        return false;
    }

    stop() {
        if (this._c_stop) { try { this._c_stop(); } catch {} }
        this.running = false;
        this._clearInput();
        if (this._autosave) { clearInterval(this._autosave); this._autosave = null; }
        // Best-effort persist. Callers that must guarantee durability before
        // tearing down the realm should use stopAndFlush() instead.
        this.flush();
        this.sink.state('stopped');
        this.sink.exit();
    }

    /** Stop and await a final flush, so volume data is durable before the
     *  caller tears down the realm (e.g. terminates the worker). */
    async stopAndFlush() {
        if (this._c_stop) { try { this._c_stop(); } catch {} }
        this.running = false;
        this._clearInput();
        if (this._autosave) { clearInterval(this._autosave); this._autosave = null; }
        await this.flush();
        this.sink.state('stopped');
        this.sink.exit();
    }
}
