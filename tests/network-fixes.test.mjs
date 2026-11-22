// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * network-fixes.test.mjs — regression tests for the web VirtualNetwork fixes.
 *
 * Run:  node tests/network-fixes.test.mjs
 *
 * Covers:
 *   1. Router no longer double-processes broadcasts (one DHCP flow = 1 OFFER + 1 ACK).
 *   3. Bridge MAC learning leaves exactly one MAC → bridge in the switch table.
 *   4. Cross-realm trunk: broadcast + unknown-unicast cross a paired transport.
 *   6. DHCP ACK records the guest IP onto the device + the IP→device table.
 */

import {
    VirtualNetwork, NetworkDevice, DeviceType, DeviceCapability,
    EthernetFrame, MACUtils, IPUtils,
} from '../lib/network/index.js';

let failures = 0;
function check(name, cond, extra = '') {
    if (cond) { console.log(`  ok   ${name}`); }
    else { console.error(`  FAIL ${name} ${extra}`); failures++; }
}

/* A minimal stand-in for VMManager's VMBridgeDevice. */
class Bridge extends NetworkDevice {
    constructor(id, mac) {
        super(id, DeviceType.VM, {
            name: id, macAddress: mac,
            capabilities: [DeviceCapability.PACKET_RX, DeviceCapability.PACKET_TX],
        });
        this.rx = [];
        this._learnedMac = null;
        this._learnedKey = null;
    }
    handlePacket(buf) { this.rx.push(new Uint8Array(buf)); return true; }
    learnFromGuest(frame) {
        const eth = new EthernetFrame(frame);
        const key = MACUtils.keyNum(eth.srcMAC);
        if (key !== 0 && key !== this._learnedKey) {
            if (this.network) this.network.forgetMAC(this._learnedMac || this.macAddress);
            this._learnedKey = key;
            this.macAddress = new Uint8Array(eth.srcMAC);
            this._learnedMac = this.macAddress;
            if (this.network) this.network.learnMAC(this.macAddress, this.id);
        }
    }
    tx(frame) { this.learnFromGuest(frame); this.sendPacket(frame); }
}

/* ---- 1 + 6: DHCP flow via the software VMDevice client -------------------- */
async function testDhcpOnce() {
    console.log('DHCP: one flow => one OFFER + one ACK, and IP is recorded');
    const n = new VirtualNetwork();
    const counts = { 2: 0, 5: 0 }; // OFFER=2, ACK=5
    const origSend = n.router.sendDHCPReply.bind(n.router);
    n.router.sendDHCPReply = (reply, dev, orig) => {
        const t = reply.getMessageType();
        if (t in counts) counts[t]++;
        return origSend(reply, dev, orig);
    };
    const vm = n.createVM('a');
    const lease = await n.waitForDHCP(vm);
    check('exactly one OFFER', counts[2] === 1, `(got ${counts[2]})`);
    check('exactly one ACK', counts[5] === 1, `(got ${counts[5]})`);
    check('lease assigned', !!lease?.ip, `(got ${lease?.ip})`);
    const ipStr = lease.ip;
    check('IP recorded in ipToDevice', n.ipToDevice.get(ipStr) === 'a',
        `(got ${n.ipToDevice.get(ipStr)})`);
    check('IP recorded on device', vm.hasIP(ipStr));
}

/* ---- 3: MAC learning leaves a single mapping ----------------------------- */
function testMacLearn() {
    console.log('MAC: learning replaces the generated placeholder (no leak)');
    const n = new VirtualNetwork();
    const gen = MACUtils.generate('vmX');
    const b = new Bridge('vmX', gen);
    n.register(b);
    check('placeholder present after register', n.macTable.get(MACUtils.keyNum(gen)) === 'vmX');

    const guestMac = MACUtils.parse('02:de:ad:be:ef:01');
    b.tx(EthernetFrame.build(new Uint8Array(6).fill(0xff), guestMac, 0x0806, new Uint8Array(28)).serialize());

    const entriesForBridge = [...n.macTable.entries()].filter(([, id]) => id === 'vmX');
    check('exactly one MAC maps to the bridge', entriesForBridge.length === 1,
        `(got ${entriesForBridge.length}: ${entriesForBridge.map(e => e[0])})`);
    check('the mapped MAC is the learned guest MAC',
        entriesForBridge[0]?.[0] === MACUtils.keyNum(guestMac));
}

/* ---- 4: cross-realm trunk ------------------------------------------------ */
function makeTransportPair() {
    // Two fake transports wired directly to each other (stand-in for a
    // BroadcastChannel spanning two tabs). send on one => onFrame on the other.
    const a = { peer: null, _cb: null, sent: 0,
        onFrame(cb) { this._cb = cb; }, start() {}, stop() {},
        send(f) { this.sent++; const c = new Uint8Array(f); queueMicrotask(() => this.peer._cb?.(c)); } };
    const b = { peer: null, _cb: null, sent: 0,
        onFrame(cb) { this._cb = cb; }, start() {}, stop() {},
        send(f) { this.sent++; const c = new Uint8Array(f); queueMicrotask(() => this.peer._cb?.(c)); } };
    a.peer = b; b.peer = a;
    return [a, b];
}

async function testTrunk() {
    console.log('Trunk: broadcast + unknown-unicast cross to the other realm');
    // Tab 1 has the router/DHCP; tab 2 does not (recommended topology).
    const n1 = new VirtualNetwork();
    const n2 = new VirtualNetwork({ createRouter: false });
    const [t1, t2] = makeTransportPair();
    n1.attachTransport(t1);
    n2.attachTransport(t2);

    const macA = MACUtils.parse('02:11:11:11:11:11');
    const macB = MACUtils.parse('02:22:22:22:22:22');
    const A = new Bridge('A', macA); n1.register(A);
    const B = new Bridge('B', macB); n2.register(B);

    // B announces itself with a broadcast; A should see it via the trunk.
    B.tx(EthernetFrame.build(new Uint8Array(6).fill(0xff), macB, 0x0806, new Uint8Array(28)).serialize());
    await new Promise(r => setTimeout(r, 5));
    check('A received B broadcast across the trunk', A.rx.length >= 1, `(A.rx=${A.rx.length})`);

    // A unicasts to B (B's MAC is unknown locally to n1) => trunk => n2 => B.
    const before = B.rx.length;
    A.tx(EthernetFrame.build(macB, macA, 0x0800, new Uint8Array([9, 9, 9])).serialize());
    await new Promise(r => setTimeout(r, 5));
    check('B received A unicast across the trunk', B.rx.length === before + 1,
        `(B.rx=${B.rx.length}, before=${before})`);

    // No loop: the frame injected into n2 must not be mirrored back to n1 again.
    const aRxAfter = A.rx.length;
    await new Promise(r => setTimeout(r, 10));
    check('no trunk echo loop', A.rx.length === aRxAfter, `(A.rx grew to ${A.rx.length})`);
}

/* ---- multiple transports coexist ----------------------------------------- */
function testMultiTransport() {
    console.log('Transports: several attach at once; frames mirror to all but origin');
    const n = new VirtualNetwork();
    const mk = () => ({ sent: [], _cb: null, onFrame(cb){this._cb=cb;}, start(){}, stop(){},
                        send(f){ this.sent.push(new Uint8Array(f)); } });
    const t1 = mk(), t2 = mk(), t3 = mk();
    n.attachTransport(t1); n.attachTransport(t2); n.attachTransport(t3);
    check('all three attached', n.getTransports().length === 3);

    // A local broadcast should be mirrored to every transport.
    const mac = MACUtils.parse('02:33:33:33:33:33');
    const A = new Bridge('A', mac); n.register(A);
    A.tx(EthernetFrame.build(new Uint8Array(6).fill(0xff), mac, 0x0806, new Uint8Array(28)).serialize());
    check('broadcast mirrored to t1', t1.sent.length === 1);
    check('broadcast mirrored to t2', t2.sent.length === 1);
    check('broadcast mirrored to t3', t3.sent.length === 1);

    // A frame arriving on t2 is injected locally but NOT echoed to t1/t3.
    const before = [t1.sent.length, t2.sent.length, t3.sent.length];
    t2._cb(EthernetFrame.build(new Uint8Array(6).fill(0xff), MACUtils.parse('02:44:44:44:44:44'), 0x0806, new Uint8Array(28)).serialize());
    check('inbound frame not re-forwarded to other transports',
        t1.sent.length === before[0] && t3.sent.length === before[2] && t2.sent.length === before[1]);

    n.detachTransport(t2);
    check('detach one leaves the rest', n.getTransports().length === 2);
    n.detachTransport();
    check('detach all clears the set', n.getTransports().length === 0);
}

(async () => {
    await testDhcpOnce();
    testMacLearn();
    await testTrunk();
    testMultiTransport();
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})();
