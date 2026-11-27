// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * workerMessages.js — what a VM worker may send to the page, checked before the
 * page acts on it (WorkerHost._onMessage).
 *
 * The worker runs the emulator, which runs guest-controlled code paths, so the
 * page treats every message from it as untrusted input: a message must be a
 * plain object whose `type` is listed below, with exactly the fields listed for
 * that type (a missing required field, an extra field, a wrong type or an
 * oversized value drops it), and some types are only allowed when the VM's
 * policy permits them:
 *
 *   net-tx       only when the VM has a NIC        (policy.hasNetwork)
 *   export-file  only when the embedder opts in    (policy.exportFiles)
 *   fetch        only in isolated mode             (policy.fetch)
 *   store        only with page-owned storage      (policy.pageStorage)
 */

'use strict';

export const LIMITS = {
    console: 1 << 20,            // one stdout chunk
    text: 64 * 1024,             // a log line / an error message
    frame: 65550,                // an Ethernet frame (virtio-net's largest)
    frameMin: 14,                // an Ethernet header
    file: 1 << 30,               // one file read from a volume / exported
    list: 100000,                // directory entries in one listing
    snapshot: 4 * 1024 ** 3,     // the whole wasm memory, at most
    url: 64 * 1024,              // a requested URL (data: URLs can be long)
    key: 4096,                   // a storage key
    name: 256,                   // a volume name
};

/* ---- field checks ----------------------------------------------------- */

const isPlain = (v) => v !== null && typeof v === 'object'
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const int = (v) => Number.isSafeInteger(v) && v >= 0;
const num = (v) => typeof v === 'number' && !Number.isNaN(v);
const bool = (v) => typeof v === 'boolean';
const str = (max) => (v) => typeof v === 'string' && v.length <= max;
const oneOf = (...vals) => (v) => vals.includes(v);
const bytes = (max, min = 0) => (v) => v instanceof Uint8Array && v.length >= min && v.length <= max;
const buffer = (max) => (v) => v instanceof ArrayBuffer && v.byteLength <= max;
const blob = (max) => (v) => typeof Blob !== 'undefined' && v instanceof Blob && v.size <= max;
const any = (...checks) => (v) => checks.some((c) => c(v));
const opt = (check) => Object.assign((v) => v === undefined || check(v), { optional: true });

/* A flat object of numbers whose keys are among `keys` (or any, if null). */
const numbers = (keys) => (v) => isPlain(v) && Object.entries(v).every(
    ([k, x]) => (!keys || keys.includes(k)) && num(x));

const VOL_COUNTERS = ['reads', 'readBytes', 'writes', 'writeBytes'];
const STATS = (v) => {
    if (!isPlain(v)) return false;
    for (const [k, x] of Object.entries(v)) {
        if (k === 'volumes') {
            if (!isPlain(x) || Object.keys(x).length > 256) return false;
            for (const [name, c] of Object.entries(x)) {
                if (name.length > LIMITS.name || !numbers(VOL_COUNTERS)(c)) return false;
            }
        } else if (!['cycles', 'diskChunks', 'diskBytes', 'jitBlocks', 'at'].includes(k) || !num(x)) {
            return false;
        }
    }
    return true;
};
const SNAPSHOT_INFO = numbers(['memoryBytes', 'savedPages', 'diskBuffers', 'bytes', 'pausedMs']);

/* A volume op's result: a file's bytes, a number (0 / -errno), null, or a
 * directory listing of flat objects with primitive values. */
const primitive = (x) => x === null || typeof x === 'string' && x.length <= LIMITS.key
    || num(x) || bool(x);
const VOL_RESULT = (v) => v === null || v === undefined || num(v) || bytes(LIMITS.file)(v)
    || (Array.isArray(v) && v.length <= LIMITS.list
        && v.every((e) => isPlain(e) && Object.keys(e).length <= 16 && Object.values(e).every(primitive)));

/* ---- storage requests (page-owned storage) ----------------------------- */

const SECTOR = { sector: int, count: int };
export const STORE_OPS = {
    open:           {},
    flush:          {},
    close:          {},
    getSectorCount: {},
    readSectors:    SECTOR,
    writeSectors:   { sector: int, data: bytes(LIMITS.file) },
    readFile:       { path: str(LIMITS.key) },
    writeFile:      { path: str(LIMITS.key), data: bytes(LIMITS.file) },
    unlink:         { path: str(LIMITS.key) },
    stat:           { path: str(LIMITS.key) },
    list:           { path: opt(str(LIMITS.key)) },
};
const STORE_ARGS = (v, msg) => {
    const shape = STORE_OPS[msg.op];
    return !!shape && fields(v, shape, null);
};

/* ---- the message table -------------------------------------------------- */

const ID = int;
const ERROR = opt(str(LIMITS.text));

export const WORKER_MESSAGES = {
    booted:           {},
    stdout:           { data: bytes(LIMITS.console) },
    'net-tx':         { frame: bytes(LIMITS.frame, LIMITS.frameMin) },
    state:            { state: oneOf('running', 'paused', 'stopped') },
    log:              { level: oneOf('log', 'err'), text: str(LIMITS.text) },
    flushed:          {},
    'vol-reply':      { id: ID, ok: bool, result: opt(VOL_RESULT), error: ERROR },
    'stats-reply':    { id: ID, ok: bool, stats: opt(STATS), error: ERROR },
    'snapshot-reply': { id: ID, ok: bool, buffer: opt(buffer(LIMITS.snapshot)),
                        info: opt(SNAPSHOT_INFO), error: ERROR },
    stopped:          {},
    downloading:      { flag: bool },
    'export-file':    { name: str(LIMITS.name), blob: any(blob(LIMITS.file), bytes(LIMITS.file)) },
    error:            { message: str(LIMITS.text) },
    exit:             {},
    // isolated mode: the worker asks the page to fetch a URL for the engine
    fetch:            { id: ID, url: str(LIMITS.url), method: oneOf('GET', 'HEAD') },
    // page-owned storage: the worker asks the page to read / write its volume
    store:            { id: ID, vol: str(LIMITS.name), op: oneOf(...Object.keys(STORE_OPS)),
                        args: STORE_ARGS },
};

/** The policy flag a message type needs, beyond a valid shape. */
const NEEDS = {
    'net-tx': 'hasNetwork',
    'export-file': 'exportFiles',
    fetch: 'fetch',
    store: 'pageStorage',
};

/* `v` has exactly the fields of `shape`, each passing its check. */
function fields(v, shape, msg = v) {
    if (!isPlain(v)) return false;
    for (const k of Object.keys(v)) {
        if (k === 'type' && v === msg) continue;
        if (!Object.prototype.hasOwnProperty.call(shape, k)) return false;
    }
    for (const [k, check] of Object.entries(shape)) {
        const x = v[k];
        if (x === undefined && !check.optional) return false;
        if (!check(x, msg)) return false;
    }
    return true;
}

/**
 * Check one message from a VM worker.
 * @param {*} msg  the message's data
 * @param {object} [policy]  { hasNetwork, exportFiles, fetch, pageStorage } (booleans)
 * @returns {string|null} null when the message is allowed, else why it is not
 */
export function checkWorkerMessage(msg, policy = {}) {
    if (!isPlain(msg)) return 'not a plain object';
    const { type } = msg;
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(WORKER_MESSAGES, type)) {
        return `unknown type ${typeof type === 'string' ? JSON.stringify(type.slice(0, 40)) : typeof type}`;
    }
    const need = NEEDS[type];
    if (need && !policy[need]) return `${type} is not allowed for this VM`;
    if (!fields(msg, WORKER_MESSAGES[type], msg)) return `malformed ${type}`;
    return null;
}
