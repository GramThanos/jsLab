// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * reference-websocket-relay.js — REFERENCE ONLY, NOT WIRED IN.
 *
 * Harvested from the old TinyEMU-distros frontend (tinyemu.ethernet.js). It
 * shows the shape of an external-internet path: bridge guest Ethernet frames to
 * a WebSocket relay (Benjamin's `wss://relay.widgetry.org/`, the same relay
 * JSLinux uses), which NATs them onto the real internet.
 *
 * This is roadmap item #8 in docs/runtime.md — the JS VirtualNetwork today is a
 * self-contained browser LAN with no external connectivity. When we implement
 * it, this is the reference for the relay protocol (binary frames + a `ping:`/
 * `pong:` keepalive). Wiring it means feeding received frames into
 * VirtualNetwork.deliverPacket() and sending guest net-tx frames to the socket,
 * replacing (or complementing) the RouterDevice for outbound traffic.
 *
 * KNOWN BUGS in this old code (left as-is so the reference stays honest — fix on
 * adoption, do not import verbatim):
 *   - connect() references bare `uri` instead of `this.uri`.
 *   - several handlers are defined on TinyEmuEthernet.prototype but should be on
 *     TinyEmuEthernetWebSocket.prototype (openHandler/closeHandler/... /messageHandler).
 *   - messageHandler calls this.writePacket, which lives on TinyEmuEthernet.
 *
 * Do NOT `import` this module into the live runtime. It is documentation.
 */

/* eslint-disable */

export const RELAY_DEFAULT_URI = 'wss://relay.widgetry.org/';

/*
 * Guest <-> relay adapter. `vm` is the per-instance binding:
 *   { _malloc, _free, HEAPU8, net_write_packet(addr,len), net_set_carrier(0|1) }
 * In the new runtime the equivalent surface is Module.api.net / the VMDevice
 * bridge, so an adopted version would talk to VirtualNetwork instead of calling
 * net_write_packet directly.
 */
export function TinyEmuEthernet(uri, vm = null) {
    if (vm) this.bindVM(vm);
    this.uri = uri || RELAY_DEFAULT_URI;

    const protocol = this.uri.substring(0, this.uri.indexOf('://'));
    if (protocol === 'wss' || protocol === 'ws') {
        this.connection = new TinyEmuEthernetWebSocket(this.uri, this);
    } else {
        this.connection = null;
    }
}

TinyEmuEthernet.prototype.bindVM = function (vm) {
    this.vm = vm;
};

TinyEmuEthernet.prototype.setStatus = function (up) {
    if (this.vm) this.vm.net_set_carrier(up ? 1 : 0);
};

// Relay -> guest: copy the frame into wasm memory and hand it to the NIC.
TinyEmuEthernet.prototype.writePacket = function (data) {
    if (!this.vm) return;
    const buf = new Uint8Array(data);
    const addr = this.vm._malloc(buf.length);
    this.vm.HEAPU8.set(buf, addr);
    this.vm.net_write_packet(addr, buf.length);
    this.vm._free(addr);
};

// Guest -> relay: forward an outbound frame onto the socket.
TinyEmuEthernet.prototype.sendPacket = function (data) {
    this.connection && this.connection.send(data);
};

TinyEmuEthernet.prototype.log = function (...args) {
    console.log('[TinyEmuEthernet]', ...args);
};

/* WebSocket transport with the relay's ping/pong keepalive. */
export function TinyEmuEthernetWebSocket(uri, eth) {
    this.uri = uri;
    this.eth = eth;
    this.connect();
}

TinyEmuEthernetWebSocket.prototype.connect = function () {
    try {
        this.socket = new WebSocket(this.uri);
        this.socket.binaryType = 'arraybuffer';
        this.socket.onopen = () => this.eth.setStatus(true);
        this.socket.onclose = () => this.eth.setStatus(false);
        this.socket.onerror = (err) => this.eth.log('[ws] error', err);
        this.socket.onmessage = (e) => this.onMessage(e);
    } catch (err) {
        this.socket = null;
        this.eth.log('[ws] could not open', this.uri, err);
    }
};

TinyEmuEthernetWebSocket.prototype.onMessage = function (e) {
    if (e.data instanceof ArrayBuffer) {
        this.eth.writePacket(e.data);           // binary frame -> guest
        return;
    }
    const str = String(e.data);
    if (str.startsWith('ping:')) {              // relay keepalive
        try { this.socket.send('pong:' + str.substring(5)); } catch (_) {}
    } else {
        this.eth.log('[ws] unhandled text message', str);
    }
};

TinyEmuEthernetWebSocket.prototype.send = function (data) {
    if (!this.socket) return;
    try { this.socket.send(data); } catch (err) { this.eth.log('[ws] send failed', err); }
};
