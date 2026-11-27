// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * RequestPolicy.js — the page side of isolated mode's network access: which
 * URLs an isolated VM worker may have the page fetch for it, and how much.
 *
 * The worker can't reach the network itself (PortXHR.js); it asks the page.
 * A request is served only when
 *   - it is a GET or HEAD,
 *   - its URL is a data: URL, or matches the allowlist: an http(s) or blob: URL
 *     equal to an entry, or under an entry that ends in '/' (same origin, path
 *     prefix), or accepted by a RegExp or a function entry,
 *   - the body is at most maxBytes (checked on Content-Length and while
 *     reading).
 * It is fetched with no credentials, no referrer and no headers from the
 * worker. The reply is { status, statusText, body: ArrayBuffer }.
 *
 * IsolatedHost builds the default allowlist from the VM's config: the config
 * URL and the folders of the files it names (kernel, disk images: TinyEMU
 * fetches a split disk's chunks from the folder of its blk.txt), plus the
 * base images of block volumes. Pass `isolation.allow` to add to it.
 */

'use strict';

export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;   // one response

/** The folder of a URL: its href up to and including the last '/'. */
export function urlFolder(href) {
    const u = new URL(href);
    u.search = ''; u.hash = '';
    return u.href.slice(0, u.href.lastIndexOf('/') + 1);
}

export class RequestPolicy {
    /**
     * @param {object} [o]
     * @param {Array<string|RegExp|((url:URL)=>boolean)>} [o.allow]
     * @param {number} [o.maxBytes]   per response (default 256 MiB)
     * @param {typeof fetch} [o.fetch]
     */
    constructor({ allow = [], maxBytes = DEFAULT_MAX_BYTES, fetch: f } = {}) {
        this.allow = [];
        this.maxBytes = maxBytes;
        this._fetch = f || globalThis.fetch.bind(globalThis);
        this.served = 0;
        this.refused = 0;
        for (const a of allow) this.add(a);
    }

    /** Allow one more URL, folder ('…/'), RegExp or predicate. */
    add(entry) {
        if (typeof entry === 'string') {
            const u = new URL(entry, globalThis.location?.href);
            if (!/^(https?|blob):$/.test(u.protocol)) throw new Error(`can't allow ${u.protocol} URLs`);
            u.hash = '';
            this.allow.push(u.href);
        } else if (entry instanceof RegExp || typeof entry === 'function') {
            this.allow.push(entry);
        } else {
            throw new TypeError('an allow entry is a URL string, a RegExp or a function');
        }
        return this;
    }

    /** @returns {boolean} whether `url` may be fetched */
    allows(url) {
        let u;
        try { u = new URL(url); } catch { return false; }
        if (u.protocol === 'data:') return true;
        if (!/^(https?|blob):$/.test(u.protocol)) return false;
        if (u.username || u.password) return false;
        u.hash = '';
        const href = u.href;
        const noQuery = href.replace(/\?.*$/, '');
        for (const a of this.allow) {
            if (typeof a === 'string') {
                if (a.endsWith('/') ? noQuery.startsWith(a) && !noQuery.slice(a.length).includes('/..') : href === a || noQuery === a) return true;
            } else if (a instanceof RegExp) {
                a.lastIndex = 0;
                if (a.test(href)) return true;
            } else if (a(u)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Fetch a URL for the worker, or refuse.
     * @returns {Promise<{status:number, statusText:string, body:ArrayBuffer}>}
     */
    async fetch(url, method = 'GET') {
        if ((method !== 'GET' && method !== 'HEAD') || !this.allows(url)) {
            this.refused++;
            throw new Error(`request refused: ${method} ${String(url).slice(0, 200)}`);
        }
        const res = await this._fetch(url, {
            method, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', cache: 'default',
        });
        // A redirect must land somewhere allowed too.
        if (res.url && res.url !== url && !/^(data|blob):/.test(url) && !this.allows(res.url)) {
            this.refused++;
            throw new Error(`request refused: redirected to ${res.url.slice(0, 200)}`);
        }
        const len = Number(res.headers?.get?.('content-length'));
        if (Number.isFinite(len) && len > this.maxBytes) {
            this.refused++;
            try { await res.body?.cancel(); } catch { /* ignore */ }
            throw new Error(`response too large: ${len} bytes`);
        }
        const body = method === 'HEAD' ? new ArrayBuffer(0) : await this._read(res);
        this.served++;
        return { status: res.status, statusText: res.statusText || '', body };
    }

    async _read(res) {
        if (!res.body?.getReader) {
            const buf = await res.arrayBuffer();
            if (buf.byteLength > this.maxBytes) { this.refused++; throw new Error('response too large'); }
            return buf;
        }
        const reader = res.body.getReader();
        const parts = [];
        let n = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            n += value.byteLength;
            if (n > this.maxBytes) {
                this.refused++;
                try { await reader.cancel(); } catch { /* ignore */ }
                throw new Error(`response too large: over ${this.maxBytes} bytes`);
            }
            parts.push(value);
        }
        const out = new Uint8Array(n);
        let off = 0;
        for (const p of parts) { out.set(p, off); off += p.byteLength; }
        return out.buffer;
    }
}
