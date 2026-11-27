// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * PortXHR.js — the worker side of isolated mode's network access.
 *
 * In isolated mode the worker runs under `connect-src 'none'`: it can't fetch
 * or XHR anything, data: and blob: URLs included. TinyEMU's wasm/lib.js loads
 * every file (the config, kernel, disk chunks) with `new XMLHttpRequest()`, so
 * the worker installs this class as its global XMLHttpRequest before the engine
 * runs: each request goes to the page as { type: 'fetch', id, url, method },
 * and the page (RequestPolicy) checks the URL against its allowlist and size
 * cap, fetches it, and replies with the bytes. TinyEMU needs no change.
 *
 * It implements the part of XMLHttpRequest lib.js uses: open, send, abort,
 * setRequestHeader (ignored: the page sends no headers it is given), status,
 * statusText, response (an ArrayBuffer), readyState, and the onload, onerror,
 * onprogress, onabort, onreadystatechange handlers.
 */

'use strict';

/**
 * @param {(url:string, method:string) => Promise<{status:number, statusText:string, body:ArrayBuffer}>} request
 * @returns {typeof XMLHttpRequest}  a stand-in class
 */
export function makePortXHR(request) {
    return class PortXHR {
        static UNSENT = 0; static OPENED = 1; static HEADERS_RECEIVED = 2; static LOADING = 3; static DONE = 4;

        constructor() {
            this.readyState = 0;
            this.status = 0;
            this.statusText = '';
            this.response = null;
            this.responseType = '';
            this.responseURL = '';
            this.withCredentials = false;
            this.timeout = 0;
            this.onload = this.onerror = this.onprogress = this.onabort = null;
            this.onreadystatechange = this.onloadend = this.ontimeout = null;
            this._method = 'GET';
            this._url = '';
            this._aborted = false;
        }

        open(method, url /*, async, user, password */) {
            this._method = String(method || 'GET').toUpperCase();
            this._url = String(url);
            this._aborted = false;
            this._state(1);
        }

        setRequestHeader() { /* no request headers cross to the page */ }
        getResponseHeader() { return null; }
        getAllResponseHeaders() { return ''; }
        overrideMimeType() {}

        send(/* body */) {
            const ev = (extra = {}) => ({ target: this, currentTarget: this, ...extra });
            const fail = () => {
                if (this._aborted) return;
                this.status = 0; this.statusText = '';
                this._state(4);
                this.onerror?.(ev());
                this.onloadend?.(ev());
            };
            if (this._method !== 'GET' && this._method !== 'HEAD') { queueMicrotask(fail); return; }
            request(this._url, this._method).then((r) => {
                if (this._aborted) return;
                this.status = r.status | 0;
                this.statusText = String(r.statusText || '');
                this.responseURL = this._url;
                const body = r.body instanceof ArrayBuffer ? r.body : new ArrayBuffer(0);
                this.response = this.responseType === 'text' || this.responseType === ''
                    ? new TextDecoder().decode(body) : body;
                this._state(4);
                const n = body.byteLength;
                this.onprogress?.(ev({ loaded: n, total: n, lengthComputable: true }));
                this.onload?.(ev());
                this.onloadend?.(ev());
            }, fail);
        }

        get responseText() { return typeof this.response === 'string' ? this.response : ''; }

        abort() {
            if (this._aborted || this.readyState === 4) return;
            this._aborted = true;
            this._state(4);
            this.onabort?.({ target: this });
        }

        _state(s) { this.readyState = s; this.onreadystatechange?.({ target: this }); }
    };
}

/**
 * A fetch() over the same request channel, for the jsLab code in the worker
 * that fetches (the HTTP base of an overlay disk). GET/HEAD only.
 */
export function makePortFetch(request) {
    return async function portFetch(input, init = {}) {
        const url = typeof input === 'string' ? input : String(input?.url ?? input);
        const method = String(init.method || 'GET').toUpperCase();
        const r = await request(url, method);
        const status = r.status >= 200 && r.status <= 599 ? r.status : 502;
        const empty = method === 'HEAD' || [204, 205, 304].includes(status);
        return new Response(empty ? null : r.body, { status, statusText: r.statusText || '' });
    };
}
