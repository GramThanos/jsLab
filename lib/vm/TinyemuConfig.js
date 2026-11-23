// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * TinyemuConfig.js — read, change and write TinyEMU machine configs (.cfg).
 *
 * A .cfg is TinyEMU's relaxed JSON: comments, unquoted keys, trailing commas,
 * C-style integers (0x1000, 010 is octal). parseConfig() reads that (and plain
 * JSON); stringifyConfig() writes what TinyEMU's json.c accepts.
 *
 * loadConfig() is what VM.start() uses: it fetches the .cfg (http(s), blob: or
 * data:), makes its file paths absolute, applies an override (an object merged
 * in, or a function that returns the new config) and hands back a data: URL the
 * engine boots from.
 *
 * Paths: a file named in a .cfg fetched from a URL is relative to that .cfg; a
 * .cfg given as blob: or data: has no directory, so its files (and the files an
 * override adds) are relative to the page.
 */

'use strict';

/* ---- parse ------------------------------------------------------------ */

/**
 * Parse a TinyEMU .cfg (or plain JSON) into a JS object.
 * @param {string} text
 * @returns {object}
 */
export function parseConfig(text) {
    let i = 0;
    const n = text.length;

    const fail = (msg) => {
        const line = text.slice(0, i).split('\n').length;
        throw new SyntaxError(`config: ${msg} (line ${line})`);
    };

    const skip = () => {
        for (;;) {
            while (i < n && /\s/.test(text[i])) i++;
            if (text.startsWith('//', i)) {
                while (i < n && text[i] !== '\n') i++;
            } else if (text.startsWith('/*', i)) {
                const end = text.indexOf('*/', i + 2);
                i = end < 0 ? n : end + 2;
            } else {
                return;
            }
        }
    };

    const isIdFirst = (c) => /[A-Za-z_$]/.test(c);
    const ident = () => {
        const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i, i + 256));
        i += m[0].length;
        return m[0];
    };

    const string = () => {
        const q = text[i++];
        let s = '';
        for (;;) {
            if (i >= n || text[i] === '\n') fail('unterminated string');
            const c = text[i++];
            if (c === q) return s;
            if (c !== '\\') { s += c; continue; }
            const e = text[i++];
            switch (e) {
                case 'n': s += '\n'; break;
                case 'r': s += '\r'; break;
                case 't': s += '\t'; break;
                case 'b': s += '\b'; break;
                case 'f': s += '\f'; break;
                case 'x': case 'u': {
                    const len = e === 'x' ? 2 : 4;
                    const h = text.slice(i, i + len);
                    if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(h)) fail('invalid hex escape');
                    s += String.fromCharCode(parseInt(h, 16));
                    i += len;
                    break;
                }
                case '"': case '\'': case '\\': case '/': s += e; break;
                default: fail(`unknown escape \\${e}`);
            }
        }
    };

    const number = () => {
        // json.c reads integers with strtol(p, &end, 0): 0x hex, leading-0 octal.
        // Also take a sign, fractions and exponents, as plain JSON may have them.
        const m = /^-?(0[xX][0-9a-fA-F]+|[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?)/.exec(text.slice(i, i + 64));
        if (!m) fail('invalid number');
        i += m[0].length;
        let t = m[0];
        const neg = t.startsWith('-');
        if (neg) t = t.slice(1);
        let v;
        if (/^0[xX]/.test(t)) v = parseInt(t, 16);
        else if (/^0[0-7]+$/.test(t)) v = parseInt(t, 8);
        else v = Number(t);
        return neg ? -v : v;
    };

    const value = () => {
        skip();
        if (i >= n) fail('unexpected end of file');
        const c = text[i];
        if (c === '{') {
            i++;
            const obj = {};
            for (;;) {
                skip();
                if (text[i] === '}') { i++; return obj; }
                let key;
                if (text[i] === '"' || text[i] === '\'') key = string();
                else if (isIdFirst(text[i])) key = ident();
                else fail('invalid property name');
                skip();
                if (text[i] !== ':') fail("':' expected");
                i++;
                obj[key] = value();
                skip();
                if (text[i] === ',') i++;
                else if (text[i] !== '}') fail("expecting ',' or '}'");
            }
        }
        if (c === '[') {
            i++;
            const arr = [];
            for (;;) {
                skip();
                if (text[i] === ']') { i++; return arr; }
                arr.push(value());
                skip();
                if (text[i] === ',') i++;
                else if (text[i] !== ']') fail("expecting ',' or ']'");
            }
        }
        if (c === '"' || c === '\'') return string();
        if (c === '-' || (c >= '0' && c <= '9')) return number();
        if (isIdFirst(c)) {
            const id = ident();
            if (id === 'true') return true;
            if (id === 'false') return false;
            if (id === 'null') return null;
            fail(`unknown identifier '${id}'`);
        }
        fail('unexpected character');
    };

    const v = value();
    skip();
    if (i < n) fail('unexpected characters at the end');
    return v;
}

/* ---- stringify ---------------------------------------------------------- */

function quote(s) {
    let out = '"';
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if (ch === '"' || ch === '\\') out += '\\' + ch;
        else if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
        else out += ch;   // json.c keeps other bytes as they are: UTF-8 survives
    }
    return out + '"';
}

/**
 * Write a config the way TinyEMU's json.c reads it. It has no negative or
 * fractional numbers and no \u escapes, so those are refused here, by key,
 * rather than failing later inside the engine.
 * @param {object} cfg
 * @returns {string}
 */
export function stringifyConfig(cfg) {
    const write = (v, path, indent) => {
        if (v === null) return 'null';
        if (typeof v === 'boolean') return String(v);
        if (typeof v === 'number') {
            if (!Number.isInteger(v) || v < 0 || v > 0x7fffffff) {
                throw new TypeError(`config: ${path || 'value'} is ${v}; TinyEMU takes integers 0..2^31-1`);
            }
            return String(v);
        }
        if (typeof v === 'string') return quote(v);
        const pad = '    '.repeat(indent + 1);
        const end = '    '.repeat(indent);
        if (Array.isArray(v)) {
            if (!v.length) return '[]';
            return '[\n' + v.map((x, k) => pad + write(x, `${path}[${k}]`, indent + 1)).join(',\n') + '\n' + end + ']';
        }
        if (typeof v === 'object') {
            const keys = Object.keys(v).filter((k) => v[k] !== undefined);
            if (!keys.length) return '{}';
            return '{\n' + keys.map((k) => pad + quote(k) + ': ' +
                write(v[k], path ? `${path}.${k}` : k, indent + 1)).join(',\n') + '\n' + end + '}';
        }
        throw new TypeError(`config: ${path || 'value'} has type ${typeof v}`);
    };
    return write(cfg, '', 0) + '\n';
}

/* ---- merge --------------------------------------------------------------- */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Deep-merge `override` into a copy of `base`: objects merge key by key,
 * anything else (arrays included) replaces, and null deletes the key.
 * @returns {object} a new object; neither argument is changed
 */
export function mergeConfig(base, override) {
    const out = structuredClone(base ?? {});
    const merge = (dst, src) => {
        for (const [k, v] of Object.entries(src)) {
            if (v === undefined) continue;
            if (v === null) delete dst[k];
            else if (isPlainObject(v) && isPlainObject(dst[k])) merge(dst[k], v);
            else dst[k] = structuredClone(v);
        }
    };
    if (override) merge(out, override);
    return out;
}

/* ---- files --------------------------------------------------------------- */

const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;   // http:, blob:, data:, js:, ...

/** Every file the machine loads, as [object, key] pairs (value at object[key]). */
function fileRefs(cfg) {
    const refs = [];
    for (const k of ['bios', 'kernel', 'initrd']) {
        if (typeof cfg[k] === 'string') refs.push([cfg, k]);
    }
    for (const [k, v] of Object.entries(cfg)) {
        if (/^(drive|fs)\d+$/.test(k) && isPlainObject(v) && typeof v.file === 'string') refs.push([v, 'file']);
    }
    return refs;
}

/** The files a config names (as written in it). */
export function configFiles(cfg) {
    return fileRefs(cfg).map(([o, k]) => o[k]);
}

/**
 * Make the config's relative file paths absolute against `baseUrl` (in place).
 * Names with a scheme (http:, js:, blob:, data:, ...) are left alone.
 * @returns {object} cfg
 */
export function resolveConfigFiles(cfg, baseUrl) {
    for (const [o, k] of fileRefs(cfg)) {
        if (!HAS_SCHEME.test(o[k])) o[k] = new URL(o[k], baseUrl).href;
    }
    return cfg;
}

/** Whether a URL is a blob: or data: URL (a config with no directory). */
export function isInlineUrl(url) {
    return /^(blob|data):/i.test(url);
}

/** A data: URL holding `text`. */
export function configDataUrl(text) {
    return 'data:application/json;charset=utf-8,' + encodeURIComponent(text);
}

/* ---- load ------------------------------------------------------------------ */

/**
 * Fetch a config and apply an override.
 *
 * @param {object} o
 * @param {string} o.configUrl        http(s), blob: or data: URL (relative: to the page)
 * @param {object|function} [o.configOverride]
 *        an object deep-merged into the config (see mergeConfig), or a function
 *        `(cfg) => newCfg` (may be async) given the parsed config, with its file
 *        paths already absolute. If the function returns nothing, the config it
 *        was given (and may have changed) is used.
 * @param {string} [o.pageUrl]        what relative URLs are relative to (default: location.href)
 * @returns {Promise<{url: string, text: string, config: object|null}>}
 *        `url` to boot from: configUrl made absolute when there is no override,
 *        else a data: URL of the new config (`text`, `config`).
 */
export async function loadConfig({ configUrl, configOverride, pageUrl } = {}) {
    if (!configUrl) throw new Error('configUrl is required');
    const page = pageUrl || globalThis.location?.href;
    const url = new URL(configUrl, page).href;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`config ${configUrl}: HTTP ${res.status}`);
    const text = await res.text();
    if (configOverride == null) return { url, text, config: null };

    let cfg = parseConfig(text);
    if (!isPlainObject(cfg)) throw new TypeError('config: the top level is not an object');
    // A blob:/data: config has no directory: its files are relative to the page.
    resolveConfigFiles(cfg, isInlineUrl(url) ? page : url);

    if (typeof configOverride === 'function') {
        const arg = cfg;
        const out = await configOverride(arg);
        cfg = out === undefined ? arg : out;
        if (!isPlainObject(cfg)) throw new TypeError('configOverride: the function did not return an object');
    } else if (isPlainObject(configOverride)) {
        cfg = mergeConfig(cfg, configOverride);
    } else {
        throw new TypeError('configOverride must be an object or a function');
    }

    const outText = stringifyConfig(cfg);
    return { url: configDataUrl(outText), text: outText, config: cfg };
}
