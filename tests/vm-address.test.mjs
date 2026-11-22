// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * vm-address.test.mjs — the guest IPv4 address that VMManager reports
 * (vm.ip, vm.onAddress), learned by its network bridge.
 *
 * Run:  node tests/vm-address.test.mjs
 *
 * Covers:
 *   1. The DHCP ACK from the JS router gives the VM its address.
 *   2. A guest's own IPv4 traffic gives it too (a static address), a DHCP
 *      client's 0.0.0.0 doesn't, and a new address replaces the old one.
 */

import { VMManager } from '../lib/vm/index.js';
import {
    EthernetFrame, ETH_P_IP, IPPacket, IP_PROTO_UDP, UDPPacket,
    DHCPPacket, DHCP_MSG_DISCOVER, DHCP_MSG_REQUEST, DHCP_OPT_MSG_TYPE, DHCP_OPT_REQ_ADDR, DHCP_OPT_SERVER_ID,
    IPUtils, MACUtils,
} from '../lib/network/index.js';

let failures = 0;
function check(name, cond, extra = '') {
    if (cond) { console.log(`  ok   ${name}`); }
    else { console.error(`  FAIL ${name} ${extra}`); failures++; }
}

const GUEST_MAC = MACUtils.parse('02:00:00:00:00:42');
const BROADCAST = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

// A UDP/IPv4 frame from the guest, as its kernel would send it.
function udpFrame(srcIP, dstIP, srcPort, dstPort, payload, dstMAC = BROADCAST) {
    const udp = UDPPacket.build(srcPort, dstPort, payload).serialize(IPUtils.parse(srcIP), IPUtils.parse(dstIP));
    const ip = IPPacket.build(IPUtils.parse(srcIP), IPUtils.parse(dstIP), IP_PROTO_UDP, udp).serialize();
    return EthernetFrame.build(dstMAC, GUEST_MAC, ETH_P_IP, ip).serialize();
}

// A client's DHCP message (what udhcpc sends).
function dhcpClient(type, options = {}) {
    const p = new DHCPPacket();
    p.xid = 0x1234;
    p.chaddr.set(GUEST_MAC);
    p.setOption(DHCP_OPT_MSG_TYPE, new Uint8Array([type]));
    for (const [tag, value] of Object.entries(options)) p.setOption(Number(tag), value);
    return p;
}

// A guest's send path, as VMManager wires it: vm.onNetTx → the bridge.
function guestSends(vm, frame) { vm._emit('net-tx', frame); }

async function newVM(mgr, id) {
    const vm = await mgr.create(id, { configUrl: 'http://example.invalid/x.cfg', hasNetwork: true });
    const seen = [];
    vm.onAddress((ip) => seen.push(ip));
    vm.deliverFrame = (frame) => { vm.lastRx = frame; };   // no engine: catch the router's replies
    return { vm, seen };
}

async function testDhcp() {
    console.log('1. DHCP ACK → vm.ip');
    const mgr = new VMManager();
    const { vm, seen } = await newVM(mgr, 'a');
    check('no address before DHCP', vm.ip === null);

    guestSends(vm, udpFrame('0.0.0.0', '255.255.255.255', 68, 67, dhcpClient(DHCP_MSG_DISCOVER).serialize()));
    check('0.0.0.0 (DISCOVER) gives no address', vm.ip === null);

    const offer = new DHCPPacket(new IPPacket(new EthernetFrame(vm.lastRx).payload).payload.subarray(8));
    const offered = IPUtils.toString(offer.yiaddr);
    const request = dhcpClient(DHCP_MSG_REQUEST, {
        [DHCP_OPT_REQ_ADDR]: offer.yiaddr, [DHCP_OPT_SERVER_ID]: IPUtils.parse('10.0.2.2') });
    guestSends(vm, udpFrame('0.0.0.0', '255.255.255.255', 68, 67, request.serialize()));
    check('ACK sets vm.ip to the offered address', vm.ip === offered, `(${vm.ip} vs ${offered})`);
    check('onAddress fired once', seen.length === 1 && seen[0] === offered, JSON.stringify(seen));
    check('the network maps the IP to the VM', mgr.network.getIPTable()[offered] === 'a');
    check('toJSON carries the IP', vm.toJSON().ip === offered);
}

async function testStatic() {
    console.log('2. guest traffic → vm.ip');
    const mgr = new VMManager();
    const { vm, seen } = await newVM(mgr, 'b');
    guestSends(vm, udpFrame('10.0.2.200', '255.255.255.255', 50505, 50505, new Uint8Array(4)));
    check('a static source address is learned', vm.ip === '10.0.2.200');
    guestSends(vm, udpFrame('10.0.2.200', '10.0.2.15', 50505, 50505, new Uint8Array(4)));
    check('the same address again fires nothing', seen.length === 1);
    guestSends(vm, udpFrame('10.0.2.201', '255.255.255.255', 50505, 50505, new Uint8Array(4)));
    check('a new address replaces the old', vm.ip === '10.0.2.201' && seen.length === 2);
    const table = mgr.network.getIPTable();
    check('the old address is unmapped', !('10.0.2.200' in table) && table['10.0.2.201'] === 'b', JSON.stringify(table));
    check('the bridge holds one address', vm.netDevice.ipAddresses.size === 1);
}

(async () => {
    await testDhcp();
    await testStatic();
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})();
