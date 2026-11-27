// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * security.test.mjs — the page's defences against what a VM worker (and the
 * guest inside it) sends.
 *
 * Run:  node --test tests/security.test.mjs
 *
 * Covers:
 *   1. A VM without a NIC gets no bridge and sends no net-tx.
 *   2. Two projects' VMs on separate networks never see each other's frames.
 *   3. Address claims: the bridge pins its guest's MAC and refuses another
 *      device's MAC or IPv4 address (IPv4 source, ARP sender, the router's).
 *   4. Malformed, unknown and unauthorised worker messages are dropped, and
 *      replies are matched to the request they answer.
 *   5. Page-owned storage: the worker's PortBackend reaches only the volumes the
 *      page configured, and the page moves opaque keys and bytes.
 *   6. Isolated mode's requests: the page's allowlist and size cap, and the
 *      worker's XMLHttpRequest stand-in.
 *   7. Snapshots cross the port as transferred ArrayBuffers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VMManager } from '../lib/vm/index.js';
import { WorkerHost } from '../lib/vm/WorkerHost.js';
import { checkWorkerMessage, LIMITS } from '../lib/vm/workerMessages.js';
import { RequestPolicy } from '../lib/vm/RequestPolicy.js';
import { makePortXHR } from '../lib/vm/PortXHR.js';
import { PageStorage, PortBackend } from '../lib/volumes/PageStorage.js';
import { StorageBackend } from '../lib/volumes/backends/StorageBackend.js';
import { Fs9pStore } from '../lib/volumes/Fs9pStore.js';
import { MACUtils } from '../lib/network/index.js';

/* ---- helpers --------------------------------------------------------------- */

const BCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

/* An Ethernet frame: dst, src (MAC strings or byte arrays), type, payload. */
function frame(dst, src, type, payload = []) {
    const mac = (m) => (typeof m === 'string' ? [...MACUtils.parse(m)] : [...m]);
    const out = new Uint8Array(Math.max(14 + payload.length, 60));
    out.set(mac(dst), 0);
    out.set(mac(src), 6);
    out[12] = type >> 8; out[13] = type & 0xff;
    out.set(payload, 14);
    return out;
}

/* An empty UDP datagram from `srcIP` to `dstIP` (port 9, discard). */
function ipv4(srcIP, dstIP) {
    const h = new Uint8Array(28);
    h[0] = 0x45; h[3] = 28; h[8] = 64; h[9] = 17;
    h.set(srcIP.split('.').map(Number), 12);
    h.set(dstIP.split('.').map(Number), 16);
    let sum = 0;
    for (let i = 0; i < 20; i += 2) sum += (h[i] << 8) | h[i + 1];
    while (sum > 0xffff) sum = (sum & 0xffff) + (sum >> 16);
    h[10] = (~sum >> 8) & 0xff; h[11] = ~sum & 0xff;
    h[21] = 9; h[23] = 9; h[25] = 8;   // ports 9 → 9, length 8, no checksum
    return [...h];
}

/* An ARP request: sender MAC/IP, asking for targetIP. */
function arp(senderMac, senderIP, targetIP) {
    const p = new Uint8Array(28);
    p.set([0, 1, 8, 0, 6, 4, 0, 1]);
    p.set(MACUtils.parse(senderMac), 8);
    p.set(senderIP.split('.').map(Number), 14);
    p.set(targetIP.split('.').map(Number), 24);
    return [...p];
}

/* A VM whose guest frames we inject and whose received frames we collect. */
async function guest(mgr, id, config = {}) {
    const vm = await mgr.create(id, { configUrl: 'http://example.invalid/x.cfg', hasNetwork: true, ...config });
    vm.rx = [];
    vm.deliverFrame = (f) => { vm.rx.push(f); };   // no engine: record what arrives
    vm.send = (f) => vm._emit('net-tx', f);        // as the worker's net-tx would
    return vm;
}

/* A WorkerHost with a fake channel in place of a Worker. */
function fakeHost(policy = {}) {
    const calls = { console: [], netTx: [], log: [], state: [], exportFile: [], error: [] };
    const sink = {
        console: (b) => calls.console.push(b),
        netTx: (f) => calls.netTx.push(f),
        log: (l, t) => calls.log.push([l, t]),
        state: (s) => calls.state.push(s),
        error: (e) => calls.error.push(e),
        exportFile: (...a) => calls.exportFile.push(a),
    };
    const host = new WorkerHost({ workerUrl: 'x', wasmJsUrl: 'y', wasmBinUrl: 'z' }, sink, policy);
    const sent = [];
    const ch = { postMessage: (msg, transfer) => sent.push({ msg, transfer }), terminate() {} };
    host.worker = host._ch = ch;
    return { host, calls, sent };
}

/* An in-memory files + block backend. */
class MemBackend extends StorageBackend {
    constructor(name) {
        super(name);
        this.capabilities = { block: true, files: true, persistent: true };
        this.files = new Map();
        this.opened = 0;
    }
    async open() { this.opened++; return this; }
    async getSectorCount() { return 2048; }
    async readFile(p) { return this.files.has(p) ? this.files.get(p) : null; }
    async writeFile(p, d) { this.files.set(p, new Uint8Array(d)); }
    async unlink(p) { this.files.delete(p); }
    async list(prefix = '') { return [...this.files.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })); }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/* ---- 1. no NIC -------------------------------------------------------------- */

test('a VM without a NIC gets no bridge and sends no frames', async () => {
    const mgr = new VMManager();
    const before = mgr.network.getAll().length;
    const vm = await mgr.create('quiet', { configUrl: 'http://example.invalid/x.cfg', hasNetwork: false });
    assert.equal(vm.netDevice, null);
    assert.equal(vm.network, null);
    assert.equal(mgr.network.getAll().length, before, 'no device registered');

    const other = await guest(mgr, 'other');
    const delivered = mgr.network.stats.totalPackets;
    vm._emit('net-tx', frame(BCAST, '02:00:00:00:00:01', 0x0800, ipv4('10.0.2.77', '255.255.255.255')));
    assert.equal(mgr.network.stats.totalPackets, delivered, 'nothing reached the network');
    assert.equal(other.rx.length, 0);
    await mgr.destroy('quiet');   // no bridge to unregister: must not throw
});

test('the worker host drops net-tx for a VM without a NIC', () => {
    const { host, calls } = fakeHost({ hasNetwork: false });
    host._onMessage({ type: 'net-tx', frame: new Uint8Array(60) });
    assert.equal(calls.netTx.length, 0);
    assert.equal(host.dropped, 1);
    host.deliverFrame(new Uint8Array(60));
    assert.equal(host._ch && 0, 0);

    const withNic = fakeHost({ hasNetwork: true });
    withNic.host._onMessage({ type: 'net-tx', frame: new Uint8Array(60) });
    assert.equal(withNic.calls.netTx.length, 1);
});

/* ---- 2. one network per project -------------------------------------------- */

test("two projects' VMs can't see each other's frames", async () => {
    const mgr = new VMManager();
    const a = await guest(mgr, 'a', { network: 'project-1' });
    const c = await guest(mgr, 'c', { network: 'project-1' });
    const b = await guest(mgr, 'b', { network: 'project-2' });
    assert.notEqual(a.network, b.network);
    assert.equal(a.network, c.network);
    assert.equal(mgr.getNetwork('project-1'), a.network);

    // b's guest MAC is learned on its own network only.
    b.send(frame(BCAST, '02:bb:00:00:00:02', 0x0800, ipv4('10.0.2.60', '255.255.255.255')));
    a.send(frame(BCAST, '02:aa:00:00:00:01', 0x0800, ipv4('10.0.2.50', '255.255.255.255')));
    assert.equal(c.rx.length, 1, 'a broadcast reaches a VM of the same project');
    assert.equal(b.rx.length, 0, 'and not one of another project');

    a.send(frame('02:bb:00:00:00:02', '02:aa:00:00:00:01', 0x0800, ipv4('10.0.2.50', '10.0.2.60')));
    assert.equal(b.rx.length, 0, "a unicast to the other project's MAC goes nowhere");
    assert.equal(a.rx.length, 0, "a never saw b's broadcast");

    // Each project's network has its own DHCP server and address table.
    assert.notEqual(a.network.router, b.network.router);
    assert.equal(a.network.getIPTable()['10.0.2.60'], undefined);
    assert.equal(b.network.getIPTable()['10.0.2.60'], 'b');

    assert.equal(mgr.deleteNetwork('project-2'), false, 'in use');
    await mgr.destroy('b');
    assert.equal(mgr.deleteNetwork('project-2'), true);
    assert.ok(mgr.getStatus().networks['project-1']);
});

/* ---- 3. address claims ------------------------------------------------------- */

test("a VM can't claim another VM's MAC or IP, or change its MAC", async () => {
    const mgr = new VMManager();
    const a = await guest(mgr, 'a');
    const b = await guest(mgr, 'b');
    const c = await guest(mgr, 'c');

    a.send(frame(BCAST, '02:aa:00:00:00:01', 0x0800, ipv4('10.0.2.50', '255.255.255.255')));
    b.send(frame(BCAST, '02:bb:00:00:00:02', 0x0800, ipv4('10.0.2.60', '255.255.255.255')));
    assert.equal(c.rx.length, 2);
    assert.equal(a.ip, '10.0.2.50');

    const seen = () => c.rx.length;
    let n = seen();
    b.send(frame(BCAST, '02:aa:00:00:00:01', 0x0800, ipv4('10.0.2.60', '255.255.255.255')));
    assert.equal(seen(), n, "b can't send from a's MAC");
    assert.equal(mgr.network.macTable.get(MACUtils.keyNum(MACUtils.parse('02:aa:00:00:00:01'))), 'a');

    b.send(frame(BCAST, '02:bb:00:00:00:99', 0x0800, ipv4('10.0.2.60', '255.255.255.255')));
    assert.equal(seen(), n, "b can't switch to another MAC once pinned");

    b.send(frame(BCAST, '02:bb:00:00:00:02', 0x0800, ipv4('10.0.2.50', '255.255.255.255')));
    assert.equal(seen(), n, "b can't send from a's IP");
    assert.equal(a.ip, '10.0.2.50');
    assert.equal(mgr.network.getIPTable()['10.0.2.50'], 'a');

    b.send(frame(BCAST, '02:bb:00:00:00:02', 0x0806, arp('02:bb:00:00:00:02', '10.0.2.50', '10.0.2.2')));
    assert.equal(seen(), n, "b can't ARP for a's IP");

    b.send(frame(BCAST, '02:bb:00:00:00:02', 0x0806, arp('02:aa:00:00:00:01', '10.0.2.60', '10.0.2.2')));
    assert.equal(seen(), n, "b can't ARP with a's MAC as the sender");

    b.send(frame(BCAST, '02:bb:00:00:00:02', 0x0800, ipv4('10.0.2.2', '255.255.255.255')));
    assert.equal(seen(), n, "b can't claim the gateway's IP");

    const d = await guest(mgr, 'd');
    d.send(frame(BCAST, MACUtils.toString(mgr.network.router.macAddress), 0x0800, ipv4('10.0.2.70', '255.255.255.255')));
    assert.equal(seen(), n, "a new VM can't take the router's MAC");
    d.send(frame(BCAST, [0x03, 0, 0, 0, 0, 1], 0x0800, ipv4('10.0.2.70', '255.255.255.255')));
    assert.equal(seen(), n, 'a group (multicast) source MAC is refused');
    d.send(new Uint8Array(10));
    assert.equal(seen(), n, 'a runt frame is refused');
    assert.ok(b.netDevice.refused >= 6 && d.netDevice.refused >= 3);

    b.send(frame(BCAST, '02:bb:00:00:00:02', 0x0800, ipv4('10.0.2.60', '255.255.255.255')));
    assert.equal(seen(), n + 1, 'its own addresses still work');
    b.send(frame(BCAST, '02:bb:00:00:00:02', 0x0806, arp('02:bb:00:00:00:02', '0.0.0.0', '10.0.2.60')));
    assert.equal(seen(), n + 2, 'an ARP probe (sender 0.0.0.0) is fine');
    n = seen();

    // A restart is a new NIC with a new MAC: the pin is released.
    b._setState('starting');
    assert.equal(b.ip, '10.0.2.60', 'vm.ip keeps the last address until the guest reports one');
    assert.equal(mgr.network.getIPTable()['10.0.2.60'], undefined, 'the old address is released');
    b.send(frame(BCAST, '02:bb:00:00:00:99', 0x0800, ipv4('10.0.2.61', '255.255.255.255')));
    assert.equal(seen(), n + 1, 'after a restart the new MAC is accepted');
    assert.equal(mgr.network.macTable.get(MACUtils.keyNum(MACUtils.parse('02:bb:00:00:00:02'))), undefined,
        'and the old one forgotten');
});

/* ---- 4. worker messages ----------------------------------------------------------- */

test('malformed worker messages are refused', () => {
    const p = { hasNetwork: true };
    const bad = [
        null, 'booted', 42, [], new Map(),
        {}, { type: 'nope' }, { type: 7 }, { type: '__proto__' }, { type: 'toString' },
        { type: 'booted', extra: 1 },
        { type: 'stdout' }, { type: 'stdout', data: 'text' }, { type: 'stdout', data: new Uint8Array(LIMITS.console + 1) },
        { type: 'net-tx', frame: new Uint8Array(10) }, { type: 'net-tx', frame: new Uint8Array(LIMITS.frame + 1) },
        { type: 'net-tx', frame: [1, 2, 3] },
        { type: 'state', state: 'hacked' },
        { type: 'log', level: 'warn', text: 'x' }, { type: 'log', level: 'log', text: 'x'.repeat(LIMITS.text + 1) },
        { type: 'vol-reply', id: -1, ok: true }, { type: 'vol-reply', id: 1.5, ok: true },
        { type: 'vol-reply', id: 1, ok: 'yes' },
        { type: 'vol-reply', id: 1, ok: true, result: [{ name: 'a', nested: { deep: 1 } }] },
        { type: 'vol-reply', id: 1, ok: true, result: { not: 'a listing' } },
        { type: 'stats-reply', id: 1, ok: true, stats: { cycles: 1, evil: 'x' } },
        { type: 'stats-reply', id: 1, ok: true, stats: { volumes: { v: { reads: 'many' } } } },
        { type: 'snapshot-reply', id: 1, ok: true, buffer: new Uint8Array(4) },
        { type: 'snapshot-reply', id: 1, ok: true, buffer: new ArrayBuffer(4), info: { pausedMs: '1' } },
        { type: 'downloading', flag: 1 },
        { type: 'error', message: { toString() { return 'x'; } } },
        { type: 'store', id: 1, vol: 'v', op: 'readFile', args: { path: 'a' } },          // no page storage
        { type: 'fetch', id: 1, url: 'https://example.org/', method: 'GET' },             // not isolated
        { type: 'export-file', name: 'f', blob: new Uint8Array(3) },                      // not opted in
    ];
    for (const m of bad) assert.notEqual(checkWorkerMessage(m, p), null, `should refuse ${JSON.stringify(m)?.slice(0, 80)}`);

    const good = [
        { type: 'booted' }, { type: 'stdout', data: new Uint8Array(5) },
        { type: 'net-tx', frame: new Uint8Array(60) }, { type: 'state', state: 'paused' },
        { type: 'log', level: 'err', text: 'oops' },
        { type: 'vol-reply', id: 3, ok: true, result: [{ name: 'a', dir: false, size: 1, mtime: 0, ino: 2, gen: 9 }] },
        { type: 'vol-reply', id: 3, ok: true, result: new Uint8Array(3) },
        { type: 'vol-reply', id: 3, ok: false, error: 'no' },
        { type: 'stats-reply', id: 1, ok: true, stats: { cycles: -1, volumes: { v: { reads: 1, readBytes: 2, writes: 0, writeBytes: 0 } }, at: 1.5 } },
        { type: 'snapshot-reply', id: 1, ok: true, buffer: new ArrayBuffer(4), info: { bytes: 4, pausedMs: 1 } },
    ];
    for (const m of good) assert.equal(checkWorkerMessage(m, p), null, `should accept ${m.type}`);

    const all = { hasNetwork: true, exportFiles: true, fetch: true, pageStorage: true };
    assert.equal(checkWorkerMessage({ type: 'export-file', name: 'f', blob: new Uint8Array(3) }, all), null);
    assert.equal(checkWorkerMessage({ type: 'fetch', id: 1, url: 'https://e/', method: 'GET' }, all), null);
    assert.notEqual(checkWorkerMessage({ type: 'fetch', id: 1, url: 'https://e/', method: 'POST' }, all), null);
    assert.equal(checkWorkerMessage({ type: 'store', id: 1, vol: 'v', op: 'list', args: {} }, all), null);
    assert.notEqual(checkWorkerMessage({ type: 'store', id: 1, vol: 'v', op: 'drop', args: {} }, all), null);
    assert.notEqual(checkWorkerMessage({ type: 'store', id: 1, vol: 'v', op: 'readFile', args: { path: 'a', x: 1 } }, all), null);
    assert.notEqual(checkWorkerMessage({ type: 'store', id: 1, vol: 'v', op: 'readSectors', args: { sector: -1, count: 1 } }, all), null);
});

test('the worker host drops bad messages and mismatched replies', async () => {
    const { host, calls } = fakeHost({ hasNetwork: true });
    host._onMessage({ type: 'stdout', data: 'not bytes' });
    host._onMessage({ type: 'stdout', data: new Uint8Array(2), sneaky: true });
    host._onMessage({ type: 'export-file', name: 'x', blob: new Uint8Array(1) });
    assert.equal(calls.console.length, 0);
    assert.equal(calls.exportFile.length, 0, 'export-file needs the embedder to opt in');
    assert.equal(host.dropped, 3);
    host._onMessage({ type: 'stdout', data: new Uint8Array(2) });
    assert.equal(calls.console.length, 1);

    // A reply is matched to the request it answers, by id and by kind.
    const stats = host.stats();
    const id = host._seq;
    host._onMessage({ type: 'vol-reply', id, ok: true, result: 0 });       // wrong kind
    host._onMessage({ type: 'stats-reply', id: id + 100, ok: true, stats: {} });   // unknown id
    assert.equal(host.dropped, 5);
    host._onMessage({ type: 'stats-reply', id, ok: true, stats: { cycles: 5 } });
    assert.deepEqual(await stats, { cycles: 5 });
    host._onMessage({ type: 'stats-reply', id, ok: true, stats: { cycles: 6 } });   // answered already
    assert.equal(host.dropped, 6);

    // Logging is bounded; the count keeps going.
    for (let i = 0; i < 50; i++) host._onMessage({ type: 'bogus' });
    assert.equal(host.dropped, 56);
    assert.ok(calls.log.length <= 10);
});

/* ---- 5. page-owned storage ----------------------------------------------------------- */

test('page-owned storage: the worker reaches only its own volumes', async () => {
    const backends = [];
    const page = new PageStorage(
        [{ name: 'data', type: 'files', backend: 'indexeddb', storageKey: 'project-1-data', mountpoint: '/mnt' }],
        { createBackend: (spec) => { const b = new MemBackend(spec.storageKey); backends.push(b); return b; } });
    const specs = page.workerSpecs();
    assert.deepEqual(specs, [{ name: 'data', type: 'files', backend: 'page', mountpoint: '/mnt' }],
        'the worker learns neither the backend nor the storage key');

    // Wire a worker-side PortBackend to the page through a real MessageChannel,
    // with the page side checking each request as WorkerHost does.
    const { port1, port2 } = new MessageChannel();
    let seq = 0;
    const waiting = new Map();
    port2.onmessage = ({ data }) => { const w = waiting.get(data.id); waiting.delete(data.id); data.ok ? w.resolve(data.result) : w.reject(new Error(data.error)); };
    const request = (vol, op, args, transfer) => new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        port2.postMessage({ type: 'store', id, vol, op, args }, transfer || []);
    });
    port1.onmessage = async ({ data }) => {
        const why = checkWorkerMessage(data, { pageStorage: true });
        if (why) return port1.postMessage({ type: 'store-reply', id: data.id, ok: false, error: why });
        try {
            const { result, transfer } = await page.handle(data.vol, data.op, data.args);
            port1.postMessage({ type: 'store-reply', id: data.id, ok: true, result }, transfer);
        } catch (e) { port1.postMessage({ type: 'store-reply', id: data.id, ok: false, error: e.message }); }
    };

    try {
        const store = await Fs9pStore.fromSpec(specs[0], { backend: new PortBackend('data', request) });
        store.putFile('/hello.txt', new TextEncoder().encode('hi there'));
        await store.flush();
        assert.equal(backends.length, 1);
        assert.equal(backends[0].name, 'project-1-data', 'the page chose the storage');
        assert.ok(backends[0].files.size >= 2, 'the page holds the image and the data, as opaque keys');

        const again = await Fs9pStore.fromSpec(specs[0], { backend: new PortBackend('data', request) });
        assert.equal(new TextDecoder().decode(again.getFile('/hello.txt')), 'hi there');

        await assert.rejects(new PortBackend('other-project', request).open(), /no page-owned volume/);
        await assert.rejects(request('data', 'deleteEverything', {}), /unknown|malformed/);
    } finally {
        port1.close(); port2.close();
    }
});

/* ---- 6. isolated mode's requests ------------------------------------------------------- */

function fakeFetch(responses) {
    const calls = [];
    const f = async (url, init) => {
        calls.push({ url, init });
        const r = responses[url];
        if (!r) return new Response('missing', { status: 404 });
        const res = new Response(r.body, { status: r.status || 200, headers: r.headers || {} });
        if (r.redirectedTo) Object.defineProperty(res, 'url', { value: r.redirectedTo });
        return res;
    };
    f.calls = calls;
    return f;
}

test('the page serves only allowlisted URLs, up to a size cap', async () => {
    const f = fakeFetch({
        'https://distros.example/alpine/kernel.bin': { body: new Uint8Array(100) },
        'https://distros.example/alpine/blk000000001.bin': { body: new Uint8Array(10) },
        'https://distros.example/alpine/big.bin': { body: new Uint8Array(5000) },
        'https://distros.example/alpine/liar.bin': { body: new Uint8Array(5000), headers: { 'content-length': '10' } },
        'https://distros.example/alpine/hop.bin': { body: new Uint8Array(1), redirectedTo: 'https://evil.example/x' },
        'https://distros.example/alpine/x86.cfg': { body: '{}' },
    });
    const policy = new RequestPolicy({
        allow: ['https://distros.example/alpine/', 'https://cdn.example/one-file.bin'],
        maxBytes: 1000, fetch: f,
    });

    assert.equal(policy.allows('https://distros.example/alpine/kernel.bin'), true);
    assert.equal(policy.allows('https://distros.example/alpine/sub/blk.txt'), true);
    assert.equal(policy.allows('https://distros.example/alpine/x86.cfg?v=2'), true);
    assert.equal(policy.allows('https://cdn.example/one-file.bin'), true);
    assert.equal(policy.allows('https://cdn.example/one-file.binx'), false);
    assert.equal(policy.allows('https://cdn.example/other.bin'), false);
    assert.equal(policy.allows('https://distros.example/alpine-evil/kernel.bin'), false);
    assert.equal(policy.allows('https://distros.example/alpine/../secret'), false);
    assert.equal(policy.allows('https://distros.example.evil.example/alpine/x'), false);
    assert.equal(policy.allows('https://user:pw@distros.example/alpine/x'), false);
    assert.equal(policy.allows('http://distros.example/alpine/x'), false, 'another scheme is another origin');
    assert.equal(policy.allows('file:///etc/passwd'), false);
    assert.equal(policy.allows('javascript:alert(1)'), false);
    assert.equal(policy.allows('blob:https://page.example/1234'), false);
    assert.equal(policy.allows('data:text/plain,hello'), true);
    assert.equal(policy.allows('not a url'), false);

    const r = await policy.fetch('https://distros.example/alpine/kernel.bin');
    assert.equal(r.status, 200);
    assert.equal(r.body.byteLength, 100);
    assert.equal(f.calls[0].init.credentials, 'omit');

    await assert.rejects(policy.fetch('https://cdn.example/other.bin'), /refused/);
    await assert.rejects(policy.fetch('https://distros.example/alpine/kernel.bin', 'POST'), /refused/);
    await assert.rejects(policy.fetch('https://distros.example/alpine/big.bin'), /too large/);
    await assert.rejects(policy.fetch('https://distros.example/alpine/liar.bin'), /too large/,
        'the cap holds while reading, whatever Content-Length says');
    await assert.rejects(policy.fetch('https://distros.example/alpine/hop.bin'), /redirected/);
    assert.equal(f.calls.length, 4, 'refused URLs were never fetched');

    const data = await new RequestPolicy({ fetch: globalThis.fetch }).fetch('data:application/json,%7B%22a%22%3A1%7D');
    assert.equal(new TextDecoder().decode(data.body), '{"a":1}');
});

test("the worker's XMLHttpRequest goes through the page", async () => {
    const asked = [];
    const XHR = makePortXHR(async (url, method) => {
        asked.push([url, method]);
        if (url.includes('refused')) throw new Error('request refused');
        return { status: 200, statusText: 'OK', body: new Uint8Array([1, 2, 3]).buffer };
    });

    // As TinyEMU's lib.js uses it.
    const ok = await new Promise((resolve) => {
        const http = new XHR();
        http.open('GET', 'https://distros.example/alpine/kernel.bin', true);
        http.responseType = 'arraybuffer';
        http.setRequestHeader('Authorization', 'Basic eDp5');
        let progress = null;
        http.onprogress = (e) => { progress = [e.loaded, e.total]; };
        http.onload = () => resolve({ status: http.status, bytes: new Uint8Array(http.response), progress });
        http.onerror = () => resolve(null);
        http.send(null);
    });
    assert.deepEqual(ok, { status: 200, bytes: new Uint8Array([1, 2, 3]), progress: [3, 3] });

    const refused = await new Promise((resolve) => {
        const http = new XHR();
        http.open('GET', 'https://refused.example/', true);
        http.onload = () => resolve('load');
        http.onerror = () => resolve(['error', http.status]);
        http.send(null);
    });
    assert.deepEqual(refused, ['error', 0]);

    const post = await new Promise((resolve) => {
        const http = new XHR();
        http.open('POST', 'https://distros.example/alpine/upload', true);
        http.onload = () => resolve('load');
        http.onerror = () => resolve('error');
        http.send(new Uint8Array(4));
    });
    assert.equal(post, 'error');
    assert.equal(asked.length, 2, 'a POST never reaches the page');
});

/* ---- 7. snapshots as transferables ------------------------------------------------------- */

test('snapshots cross the port as transferred buffers', async () => {
    const { host, sent } = fakeHost();
    const blob = new Blob([new Uint8Array(1024).fill(7)]);
    const { config, transfer } = await host._prepare({ configUrl: 'x', snapshot: blob });
    assert.ok(config.snapshot instanceof ArrayBuffer);
    assert.equal(config.snapshot.byteLength, 1024);
    assert.deepEqual(transfer, [config.snapshot], 'the start message moves the snapshot');

    const saving = host.snapshot({});
    const req = sent.at(-1).msg;
    assert.equal(req.type, 'snapshot');
    const buffer = new Uint8Array(2048).fill(9).buffer;
    host._onMessage({ type: 'snapshot-reply', id: req.id, ok: true, buffer, info: { bytes: 2048 } });
    const { blob: out, info } = await saving;
    assert.ok(out instanceof Blob);
    assert.equal(out.size, 2048);
    assert.deepEqual(info, { bytes: 2048 });
});

test('page-owned storage is wired through WorkerHost', async () => {
    const { host, sent } = fakeHost({ pageStorage: true });
    const { config } = await host._prepare({
        configUrl: 'x', volumes: [{ name: 'data', type: 'files', backend: 'opfs', storageKey: 'secret-key' }] });
    assert.equal(config.storage, 'page');
    assert.deepEqual(config.volumes, [{ name: 'data', type: 'files', backend: 'page' }]);
    host.pageStorage._create = () => new MemBackend('mem');

    host._onMessage({ type: 'store', id: 1, vol: 'data', op: 'writeFile', args: { path: 'k', data: new Uint8Array([5]) } });
    host._onMessage({ type: 'store', id: 2, vol: 'elsewhere', op: 'readFile', args: { path: 'k' } });
    await tick();
    host._onMessage({ type: 'store', id: 3, vol: 'data', op: 'readFile', args: { path: 'k' } });
    await tick();
    const replies = sent.filter((s) => s.msg.type === 'store-reply').map((s) => s.msg).sort((x, y) => x.id - y.id);
    assert.deepEqual(replies.map((r) => [r.id, r.ok]), [[1, true], [2, false], [3, true]]);
    assert.deepEqual([...replies[2].result], [5]);

    host._onMessage({ type: 'fetch', id: 4, url: 'https://e/', method: 'GET' });
    assert.equal(host.dropped, 1, 'a worker that is not isolated may not ask the page to fetch');
});
