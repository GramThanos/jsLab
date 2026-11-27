// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * PageStorage.js — volumes whose storage the page owns (`storage: 'page'`, and
 * always in isolated mode).
 *
 * By default a VM worker opens its volumes' backends itself, from the specs it
 * is given (backend, storageKey), so a worker could open any storage of the
 * origin: every project's IndexedDB databases, the whole OPFS. With page-owned
 * storage the page opens the backends, from ITS copy of the VM's config, and
 * the worker gets only a PortBackend per volume: a StorageBackend that sends
 * each call over the worker's port as { vol, op, args } and awaits the reply.
 *
 * The page side (PageStorage) checks the volume name against the ones it
 * configured and the op and arguments against a fixed list
 * (workerMessages.js STORE_OPS), then calls the backend. Keys and contents are
 * opaque to it: it moves strings and bytes and never parses the filesystem's
 * records (the 9p tree is still built and parsed in the worker, by Fs9pStore).
 */

'use strict';

import { StorageBackend } from './backends/StorageBackend.js';
import { IndexedDBBackend } from './backends/IndexedDBBackend.js';
import { OPFSBackend } from './backends/OPFSBackend.js';
import { FileSystemAccessBackend } from './backends/FileSystemAccessBackend.js';
import { STORE_OPS } from '../vm/workerMessages.js';

const BACKENDS = {
    indexeddb: IndexedDBBackend, idb: IndexedDBBackend,
    opfs: OPFSBackend,
    fsaccess: FileSystemAccessBackend, filesystem: FileSystemAccessBackend,
};

/** Make the StorageBackend a volume spec names (not opened). */
export function createBackend(spec, type = spec.type || 'files') {
    const Ctor = BACKENDS[String(spec.backend || 'indexeddb').toLowerCase()];
    if (!Ctor) throw new Error(`unknown volume backend ${spec.backend}`);
    return new Ctor(spec.storageKey || spec.name, { ...spec, type });
}

/** What the worker is told about a page-owned volume: no backend, no key. */
export function workerVolumeSpec(spec) {
    const out = { name: spec.name, type: spec.type || 'files', backend: 'page' };
    for (const k of ['mountpoint', 'baseUrl', 'readonly']) if (spec[k] !== undefined) out[k] = spec[k];
    return out;
}

/* ---- worker side --------------------------------------------------------- */

/**
 * A StorageBackend in the worker that forwards every call to the page.
 * @param {string} name  the volume name (all the page needs to find its backend)
 * @param {(vol:string, op:string, args:object, transfer?:Transferable[]) => Promise<*>} request
 */
export class PortBackend extends StorageBackend {
    constructor(name, request) {
        super(name);
        this.capabilities = { block: true, files: true, persistent: true };
        this._request = request;
        this.sectorCount = 0;
    }

    _call(op, args = {}, transfer) { return this._request(this.name, op, args, transfer); }

    async open() {
        const info = await this._call('open');
        if (info && Number.isSafeInteger(info.sectorCount)) this.sectorCount = info.sectorCount;
        if (info && Number.isSafeInteger(info.sectorSize) && info.sectorSize > 0) this.sectorSize = info.sectorSize;
        return this;
    }
    async close() { await this._call('close'); }
    async flush() { await this._call('flush'); }

    async getSectorCount() { return (this.sectorCount = await this._call('getSectorCount')); }
    async readSectors(sector, count) { return this._call('readSectors', { sector, count }); }
    async writeSectors(sector, data) {
        const copy = new Uint8Array(data);
        return this._call('writeSectors', { sector, data: copy }, [copy.buffer]);
    }

    async readFile(path) { return this._call('readFile', { path }); }
    async writeFile(path, data) {
        const copy = new Uint8Array(data);
        return this._call('writeFile', { path, data: copy }, [copy.buffer]);
    }
    async unlink(path) { return this._call('unlink', { path }); }
    async stat(path) { return this._call('stat', { path }); }
    async list(path = '') { return this._call('list', { path }); }
}

/* ---- page side ------------------------------------------------------------ */

export class PageStorage {
    /**
     * @param {object[]} specs  the VM's volume specs, as the page configured them
     * @param {object} [options]
     * @param {(spec:object, type:string) => StorageBackend} [options.createBackend]
     */
    constructor(specs = [], options = {}) {
        this._create = options.createBackend || createBackend;
        this._vols = new Map();   // name -> { spec, backend, opened: Promise|null }
        for (const spec of specs) {
            if (!spec || typeof spec.name !== 'string') continue;
            this._vols.set(spec.name, { spec, backend: null, opened: null });
        }
    }

    /** The specs to give the worker in place of the page's own. */
    workerSpecs() { return [...this._vols.values()].map((v) => workerVolumeSpec(v.spec)); }

    _open(v) {
        if (!v.opened) {
            v.backend = this._create(v.spec, v.spec.type || 'files');
            v.opened = Promise.resolve(v.backend.open()).catch((e) => { v.opened = null; throw e; });
        }
        return v.opened;
    }

    /**
     * Serve one request from the worker (already shape-checked by
     * checkWorkerMessage). @returns {Promise<{result: *, transfer: Transferable[]}>}
     */
    async handle(vol, op, args = {}) {
        const v = this._vols.get(vol);
        if (!v) throw new Error(`no page-owned volume '${vol}'`);
        if (!Object.prototype.hasOwnProperty.call(STORE_OPS, op)) throw new Error(`unknown storage op '${op}'`);
        if (op === 'close') {
            if (v.opened) { await v.opened; await v.backend.close?.(); v.opened = null; }
            return { result: null, transfer: [] };
        }
        await this._open(v);
        const b = v.backend;
        let result;
        switch (op) {
            case 'open':           result = { sectorCount: (await b.getSectorCount?.().catch(() => 0)) || 0,
                                              sectorSize: b.sectorSize }; break;
            case 'flush':          await b.flush?.(); result = null; break;
            case 'getSectorCount': result = await b.getSectorCount(); break;
            case 'readSectors':    result = await b.readSectors(args.sector, args.count); break;
            case 'writeSectors':   await b.writeSectors(args.sector, args.data); result = null; break;
            case 'readFile':       result = await b.readFile(args.path); break;
            case 'writeFile':      await b.writeFile(args.path, args.data); result = null; break;
            case 'unlink':         await b.unlink(args.path); result = null; break;
            case 'stat':           result = await b.stat(args.path); break;
            case 'list':           result = await b.list(args.path ?? ''); break;
        }
        // Hand over a copy, so a backend's own buffers are never detached.
        if (ArrayBuffer.isView(result)) {
            const copy = new Uint8Array(result.buffer, result.byteOffset, result.byteLength).slice();
            return { result: copy, transfer: [copy.buffer] };
        }
        return { result: result ?? null, transfer: [] };
    }

    /** Flush and close every opened backend. */
    async close() {
        for (const v of this._vols.values()) {
            if (!v.opened) continue;
            try { await v.opened; await v.backend.flush?.(); await v.backend.close?.(); } catch { /* best effort */ }
            v.opened = null;
        }
    }
}
