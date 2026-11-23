// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * tinyemu-config.test.mjs — reading, merging and writing TinyEMU .cfg files
 * (lib/vm/TinyemuConfig.js) and loadConfig()'s overrides.
 *
 * Run:  node --test tests/tinyemu-config.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, stringifyConfig, mergeConfig, loadConfig } from '../lib/vm/TinyemuConfig.js';

const CFG = `/* Alpine */
{
    version: 1,
    machine: "pc",   // the PC
    memory_size: 0x100,
    kernel: "kernel-x86.bin",
    cmdline: "console=hvc0 \\"q\\"",
    fs0: { file: "https://example.org/rootfs" },
    drive0: { file: "blk.txt", device: "virtio" },
    fs1: { file: "js:data", tag: "data" },
    eth0: { driver: "user" },
}
`;

const PAGE = 'https://page.example/app/index.html';
const dataUrl = (s) => 'data:text/plain,' + encodeURIComponent(s);

test('parses the relaxed .cfg dialect', () => {
    const c = parseConfig(CFG);
    assert.equal(c.memory_size, 256);
    assert.equal(c.cmdline, 'console=hvc0 "q"');
    assert.deepEqual(c.drive0, { file: 'blk.txt', device: 'virtio' });
    assert.equal(parseConfig('{a: 010, b: -1, c: "\\x41"}').a, 8);
    assert.throws(() => parseConfig('{a: 1} x'), /unexpected characters/);
    assert.throws(() => parseConfig('{a: foo}'), /unknown identifier/);
});

test('stringify round-trips and refuses what json.c cannot read', () => {
    const c = parseConfig(CFG);
    assert.deepEqual(parseConfig(stringifyConfig(c)), c);
    assert.match(stringifyConfig({ s: 'a\u0001b' }), /a\\x01b/);
    assert.throws(() => stringifyConfig({ memory_size: 1.5 }), /memory_size/);
    assert.throws(() => stringifyConfig({ x: { y: -1 } }), /x\.y/);
});

test('merge: deep, arrays replace, null deletes, inputs unchanged', () => {
    const base = { a: 1, o: { x: 1, y: 2 }, arr: [1, 2], gone: 5 };
    const out = mergeConfig(base, { o: { y: 3 }, arr: [9], gone: null, n: { k: 1 } });
    assert.deepEqual(out, { a: 1, o: { x: 1, y: 3 }, arr: [9], n: { k: 1 } });
    assert.deepEqual(base, { a: 1, o: { x: 1, y: 2 }, arr: [1, 2], gone: 5 });
});

test('loadConfig without an override passes the URL through', async () => {
    const url = dataUrl(CFG);
    const r = await loadConfig({ configUrl: url, pageUrl: PAGE });
    assert.equal(r.url, url);
    assert.equal(r.config, null);
});

test('loadConfig: object override, paths of a data: config relative to the page', async () => {
    const r = await loadConfig({
        configUrl: dataUrl(CFG), pageUrl: PAGE,
        configOverride: { memory_size: 512, drive0: { device: null }, eth0: null, initrd: 'extra/initrd' },
    });
    assert.match(r.url, /^data:application\/json/);
    const c = parseConfig(decodeURIComponent(r.url.slice(r.url.indexOf(',') + 1)));
    assert.deepEqual(c, r.config);
    assert.equal(c.memory_size, 512);
    assert.equal(c.kernel, 'https://page.example/app/kernel-x86.bin');
    assert.deepEqual(c.drive0, { file: 'https://page.example/app/blk.txt' });
    assert.equal(c.fs0.file, 'https://example.org/rootfs');
    assert.equal(c.fs1.file, 'js:data');
    assert.equal(c.eth0, undefined);
    assert.equal(c.initrd, 'extra/initrd');   // an override's own paths stay page-relative
});

test('loadConfig: function override, paths relative to an http .cfg', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u) => {
        assert.equal(u, 'https://cdn.example/distros/alpine/config.cfg');
        return new Response(CFG);
    };
    try {
        let seen;
        const r = await loadConfig({
            configUrl: '../distros/alpine/config.cfg', pageUrl: 'https://cdn.example/app/',
            configOverride: async (cfg) => { seen = cfg; return { ...cfg, memory_size: 128 }; },
        });
        assert.equal(seen.kernel, 'https://cdn.example/distros/alpine/kernel-x86.bin');
        assert.equal(r.config.memory_size, 128);
        assert.equal(r.config.drive0.file, 'https://cdn.example/distros/alpine/blk.txt');

        // a function that changes its argument and returns nothing
        const r2 = await loadConfig({
            configUrl: 'https://cdn.example/distros/alpine/config.cfg',
            configOverride: (cfg) => { cfg.cmdline += ' quiet'; },
        });
        assert.equal(r2.config.cmdline, 'console=hvc0 "q" quiet');

        await assert.rejects(loadConfig({
            configUrl: 'https://cdn.example/distros/alpine/config.cfg', configOverride: () => 42,
        }), /did not return an object/);
    } finally {
        globalThis.fetch = realFetch;
    }
});
