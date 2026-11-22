// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * fs9p-store.test.mjs — unit tests for the JS-backed 9p volume store.
 * Run: node tests/fs9p-store.test.mjs
 *
 * Exercises the synchronous op surface lib.js calls (create/read/write/readdir/
 * stat/truncate/unlink/rename) and persistence round-trips through a fake
 * StorageBackend (no browser needed).
 */

import { Fs9pStore } from '../lib/volumes/Fs9pStore.js';

let failures = 0;
function check(name, cond, extra = '') {
    if (cond) console.log(`  ok   ${name}`);
    else { console.error(`  FAIL ${name} ${extra}`); failures++; }
}

const S_IFDIR = 0x4000, S_IFREG = 0x8000, S_IFMT = 0xF000;
const enc = (s) => new TextEncoder().encode(s);
const dec = (u) => new TextDecoder().decode(u);

class MemBackend {
    constructor() { this.files = new Map(); }
    async open() {}
    async readFile(k) { return this.files.has(k) ? this.files.get(k) : null; }
    async writeFile(k, d) { this.files.set(k, new Uint8Array(d)); this.writes = (this.writes || 0) + 1; }
    async unlink(k) { this.files.delete(k); }
    async list(prefix = '') { return [...this.files.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })); }
    async flush() {}
}
const IMAGE = '__fs9p_image__';
const dataKeys = (b) => [...b.files.keys()].filter((k) => k !== IMAGE);

function newStore(backend = new MemBackend()) {
    const s = new Fs9pStore('data', backend);
    return s;
}

async function testBasicFileOps() {
    console.log('Basic file ops');
    const s = newStore();

    check('mkdir /sub', s.create('/sub', 0o755, true) === 0);
    check('create /sub/f', s.create('/sub/f', 0o644, false) === 0);
    check('create existing => EEXIST', s.create('/sub/f', 0o644, false) === -17);
    check('create in missing dir => ENOENT', s.create('/nope/x', 0o644, false) === -2);

    const data = enc('hello world');
    check('write returns len', s.write('/sub/f', 0, data) === data.length);
    const r = s.read('/sub/f', 0, 100);
    check('read back matches', dec(r) === 'hello world', `(got '${dec(r)}')`);

    check('write at offset grows', s.write('/sub/f', 11, enc('!!!')) === 3);
    check('size is 14', s.stat('/sub/f').size === 14);
    check('read slice offset', dec(s.read('/sub/f', 6, 5)) === 'world');

    const st = s.stat('/sub/f');
    check('file mode has S_IFREG', (st.mode & S_IFMT) === S_IFREG);
    check('dir mode has S_IFDIR', (s.stat('/sub').mode & S_IFMT) === S_IFDIR);
    check('stat missing => null', s.stat('/sub/missing') === null);
}

function testReaddir() {
    console.log('readdir (incl . and ..)');
    const s = newStore();
    s.create('/a', 0o644, false);
    s.create('/b', 0o644, false);
    s.create('/d', 0o755, true);

    const names = [];
    for (let i = 0; ; i++) {
        const e = s.readdir('/', i);
        if (!e) break;
        names.push(e.name);
    }
    check('has . and ..', names[0] === '.' && names[1] === '..');
    check('lists children sorted', JSON.stringify(names.slice(2)) === JSON.stringify(['a', 'b', 'd']),
        `(got ${JSON.stringify(names.slice(2))})`);
    check('readdir on file => null', s.readdir('/a', 0) === null);
}

function testTruncateUnlinkRename() {
    console.log('truncate / unlink / rename');
    const s = newStore();
    s.create('/f', 0o644, false);
    s.write('/f', 0, enc('abcdefgh'));

    check('truncate shrink', s.truncate('/f', 3) === 0 && s.stat('/f').size === 3);
    check('content after shrink', dec(s.read('/f', 0, 10)) === 'abc');
    check('truncate grow zero-fills', s.truncate('/f', 5) === 0 && s.read('/f', 0, 10).length === 5);

    s.create('/dir', 0o755, true);
    s.create('/dir/inner', 0o644, false);
    check('unlink non-empty dir => ENOTEMPTY', s.unlink('/dir') === -39);
    check('unlink file in dir', s.unlink('/dir/inner') === 0);
    check('unlink now-empty dir', s.unlink('/dir') === 0);
    check('stat removed => null', s.stat('/dir') === null);

    check('rename file', s.rename('/f', '/g') === 0 && s.stat('/f') === null && s.stat('/g') !== null);

    // rename a directory subtree
    s.create('/x', 0o755, true);
    s.create('/x/y', 0o755, true);
    s.create('/x/y/z', 0o644, false);
    s.write('/x/y/z', 0, enc('deep'));
    check('rename dir', s.rename('/x', '/x2') === 0);
    check('subtree moved', s.stat('/x2/y/z') !== null && s.stat('/x/y/z') === null);
    check('subtree data intact', dec(s.read('/x2/y/z', 0, 10)) === 'deep');
    check('parent lists renamed dir', (() => {
        for (let i = 0; ; i++) { const e = s.readdir('/', i); if (!e) return false; if (e.name === 'x2') return true; }
    })());
}

async function testPersistence() {
    console.log('persistence: flush -> reload');
    const backend = new MemBackend();
    const s1 = newStore(backend);
    s1.create('/cfg', 0o755, true);
    s1.create('/cfg/app.conf', 0o644, false);
    s1.write('/cfg/app.conf', 0, enc('key=value\n'));
    s1.create('/notes.txt', 0o600, false);
    s1.write('/notes.txt', 0, enc('remember'));
    await s1.flush();

    check('backend holds the tree and one key per non-empty file',
        backend.files.has(IMAGE) && dataKeys(backend).length === 2, `(got ${[...backend.files.keys()]})`);

    const s2 = newStore(backend);
    await s2.load();
    check('reloaded file content', dec(s2.read('/cfg/app.conf', 0, 100)) === 'key=value\n');
    check('reloaded second file', dec(s2.read('/notes.txt', 0, 100)) === 'remember');
    check('reloaded dir is a dir', (s2.stat('/cfg').mode & S_IFMT) === S_IFDIR);
    check('reloaded file mode preserved', (s2.stat('/notes.txt').mode & 0o777) === 0o600);
    // readdir works after reload (children sets rebuilt)
    const kids = [];
    for (let i = 2; ; i++) { const e = s2.readdir('/cfg', i); if (!e) break; kids.push(e.name); }
    check('reloaded dir lists children', JSON.stringify(kids) === JSON.stringify(['app.conf']),
        `(got ${JSON.stringify(kids)})`);

    // mutate + reflush + reload keeps changes
    s2.write('/notes.txt', 8, enc(' more'));
    await s2.flush();
    const s3 = newStore(backend);
    await s3.load();
    check('mutation persisted', dec(s3.read('/notes.txt', 0, 100)) === 'remember more');
}

function testGrowth() {
    console.log('growth: appends, shrink then grow');
    const s = newStore();
    s.create('/g', 0o644, false);
    const chunk = new Uint8Array(1000);
    let ok = true;
    for (let i = 0; i < 300; i++) {
        chunk.fill(i & 0xff);
        s.write('/g', i * 1000, chunk);
    }
    check('appended size', s.stat('/g').size === 300000);
    const all = s.getFile('/g');
    for (let i = 0; i < 300 && ok; i++) ok = all[i * 1000] === (i & 0xff) && all[i * 1000 + 999] === (i & 0xff);
    check('appended bytes in place', ok);
    // Shrinking keeps the buffer; growing again must not resurrect the old bytes.
    s.truncate('/g', 10);
    s.write('/g', 20, new Uint8Array([9]));
    const back = s.getFile('/g');
    check('grow after shrink zero-fills the gap', back.length === 21 && back.subarray(10, 20).every((b) => b === 0) && back[20] === 9);
    s.truncate('/g', 50);
    check('truncate up zero-fills', s.getFile('/g').subarray(21).every((b) => b === 0));
    check('getFile is a copy', (() => { const c = s.getFile('/g'); c[0] = 77; return s.getFile('/g')[0] !== 77; })());
}

async function testIncrementalFlush() {
    console.log('incremental flush: only changed files, removed data dropped, no lost writes');
    const backend = new MemBackend();
    const s = newStore(backend);
    for (let i = 0; i < 20; i++) s.putFile(`/f${i}`, enc(`file ${i}`));
    await s.flush();
    check('first flush writes every file and the tree', backend.writes === 21);
    backend.writes = 0;
    s.write('/f3', 0, enc('FILE'));
    await s.flush();
    check('second flush writes one file and the tree', backend.writes === 2);
    backend.writes = 0;
    await s.flush();
    check('a clean store writes nothing', backend.writes === 0);

    s.removePath('/f4');
    s.rename('/f5', '/f5b');
    await s.flush();
    check('a removed file\'s data goes', dataKeys(backend).length === 19);
    const r = newStore(backend);
    await r.load();
    check('rename kept its data', dec(r.getFile('/f5b')) === 'file 5' && r.stat('/f5') === null);
    check('edited file reloads', dec(r.getFile('/f3')) === 'FILE 3');

    // A write while a flush awaits is kept for the next flush, not lost.
    let release;
    const slow = new MemBackend();
    const t = newStore(slow);
    t.putFile('/a', enc('one'));
    const gate = new Promise((res) => { release = res; });
    const orig = slow.writeFile.bind(slow);
    slow.writeFile = async (k, d) => { await gate; return orig(k, d); };
    const pending = t.flush();
    t.putFile('/b', enc('two'));
    release();
    await pending;
    slow.writeFile = orig;
    await t.flush();
    const u = newStore(slow);
    await u.load();
    check('a write during a flush lands at the next one', dec(u.getFile('/b')) === 'two' && dec(u.getFile('/a')) === 'one');

    // Data the tree doesn't name (a flush that died before writing it) is removed at load.
    backend.files.set('__fs9p_data__/9999', enc('orphan'));
    const v = newStore(backend);
    await v.load();
    check('orphaned data removed at load', !backend.files.has('__fs9p_data__/9999'));
}

async function testVersion1Image() {
    console.log('version 1 image: loads, then rewritten as version 2');
    // Build a version 1 image by hand: header, then the file bytes.
    const body = enc('legacy bytes');
    const header = enc(JSON.stringify({ version: 1, nextIno: 4, entries: [
        { p: '/', m: S_IFDIR | 0o755, i: 1, t: 1, d: 1, o: 0, l: 0 },
        { p: '/d', m: S_IFDIR | 0o755, i: 2, t: 1, d: 1, o: 0, l: 0 },
        { p: '/d/old.txt', m: S_IFREG | 0o644, i: 3, t: 1, d: 0, o: 0, l: body.length },
    ] }));
    const img = new Uint8Array(4 + header.length + body.length);
    new DataView(img.buffer).setUint32(0, header.length, true);
    img.set(header, 4);
    img.set(body, 4 + header.length);
    const backend = new MemBackend();
    backend.files.set(IMAGE, img);
    const s = newStore(backend);
    await s.load();
    check('version 1 content loads', dec(s.getFile('/d/old.txt')) === 'legacy bytes');
    await s.flush();
    check('next flush writes version 2', dataKeys(backend).length === 1
        && JSON.parse(dec(backend.files.get(IMAGE).subarray(4))).version === 2);
    const t = newStore(backend);
    await t.load();
    check('version 2 reload', dec(t.getFile('/d/old.txt')) === 'legacy bytes');
}

function testHotplugHelpers() {
    console.log('live hotplug helpers (putFile/getFile/listDir/removePath)');
    const s = newStore();

    // putFile creates parent dirs automatically.
    check('putFile deep path returns 0', s.putFile('/incoming/logs/app.log', enc('line1\n')) === 0);
    check('parent dir auto-created', (s.stat('/incoming').mode & S_IFMT) === S_IFDIR);
    check('getFile round-trips', dec(s.getFile('/incoming/logs/app.log')) === 'line1\n');

    // overwrite
    check('putFile overwrite', s.putFile('/incoming/logs/app.log', enc('replaced')) === 0);
    check('overwrite content', dec(s.getFile('/incoming/logs/app.log')) === 'replaced');
    check('getFile missing => null', s.getFile('/nope') === null);

    // listDir
    s.putFile('/incoming/a.txt', enc('a'));
    const l = s.listDir('/incoming');
    check('listDir names', JSON.stringify(l.map(e => e.name)) === JSON.stringify(['a.txt', 'logs']),
        `(got ${JSON.stringify(l)})`);
    check('listDir marks dir', l.find(e => e.name === 'logs').dir === true);
    check('listDir marks file size', l.find(e => e.name === 'a.txt').size === 1);
    check('listDir on file => null', s.listDir('/incoming/a.txt') === null);

    // removePath (recursive)
    check('removePath recursive', s.removePath('/incoming') === 0);
    check('subtree gone', s.stat('/incoming') === null && s.stat('/incoming/logs/app.log') === null);
    check('removePath missing => ENOENT', s.removePath('/incoming') === -2);
}

(async () => {
    await testBasicFileOps();
    testReaddir();
    testTruncateUnlinkRename();
    testHotplugHelpers();
    await testPersistence();
    testGrowth();
    await testIncrementalFlush();
    await testVersion1Image();
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})();
