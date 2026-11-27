// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * VMManager.js — owns multiple VMs, their VirtualNetworks, and volumes.
 *
 * Each VM runs in its own Web Worker (see VM.js / vm-worker.js). The manager
 * bridges each VM's virtio-net traffic onto a JS VirtualNetwork (DHCP/ARP/
 * routing all handled in JS — see lib/network): the default one, or a separate
 * one per name (`create(id, { network: 'project-a' })`), so VMs of different
 * projects never share a segment. A VM without a NIC (`hasNetwork: false`) gets
 * no bridge at all. Volumes are attached via the VolumeManager.
 */

'use strict';

import { VM, VMState } from './VM.js';
import {
    VirtualNetwork, NetworkDevice, DeviceType, DeviceCapability,
    MACUtils, IPUtils,
} from '../network/index.js';
import { VolumeManager } from '../volumes/index.js';
import { engineUrls } from './engine.js';

/**
 * A network device that represents a real (WASM) guest. It forwards frames
 * between the VirtualNetwork and the VM worker, and learns the guest's MAC from
 * outbound traffic (the guest kernel chooses its own MAC, unknown to JS up
 * front), so unicast delivery from other VMs can find it. It also tracks the
 * guest's IPv4 address, from the DHCP server's ACK (the router calls addIP) or
 * from the source address of the guest's own IPv4 traffic (a static address),
 * and reports it to the VM (vm.ip, vm.onAddress).
 *
 * Address claims are checked (acceptFromGuest): the bridge is pinned to the
 * first source MAC its guest uses (TinyEMU picks the NIC's MAC at random when
 * the machine starts, so it can't be the one registered up front) and drops
 * frames from any other MAC, and it drops frames whose source MAC or IPv4
 * address (IPv4 source, ARP sender) belongs to another device on the network.
 * The pin is released when the VM starts again (a new NIC, a new MAC).
 */
export class VMBridgeDevice extends NetworkDevice {
    constructor(id, mac, vm) {
        super(id, DeviceType.VM, {
            name: `VM-${id}`,
            macAddress: mac,
            capabilities: [DeviceCapability.PACKET_RX, DeviceCapability.PACKET_TX],
        });
        this.vm = vm;
        this._placeholderMac = mac; // registered before the guest's MAC is known
        this._learnedMac = null;   // bytes of the pinned guest MAC
        this._learnedKey = null;   // packed-int key of the pinned guest MAC
        this.guestIP = null;       // the guest's current IPv4 address (string)
        this.refused = 0;          // guest frames dropped for a bad address claim
    }

    /** A new boot: forget the pinned MAC and the address, keep the registration. */
    resetGuest() {
        if (this.network) {
            if (this._learnedMac) this.network.forgetMAC(this._learnedMac);
            if (this.guestIP && this.network.ipToDevice.get(this.guestIP) === this.id) this.network.ipToDevice.delete(this.guestIP);
        }
        if (this.guestIP) this.ipAddresses.delete(this.guestIP);
        this.guestIP = null;
        this._learnedMac = this._learnedKey = null;
        this.macAddress = this._placeholderMac;
        if (this.network) this.network.learnMAC(this.macAddress, this.id);
    }

    /* Another device on the network answers to this MAC (key) or IPv4 address. */
    _macTaken(key) {
        const owner = this.network?.macTable.get(key);
        if (owner !== undefined && owner !== this.id) return true;
        const router = this.network?.router;
        return !!(router?.macAddress && MACUtils.keyNum(router.macAddress) === key);
    }
    _ipTaken(ip) {
        const net = this.network;
        if (!net) return false;
        const owner = net.ipToDevice.get(ip);
        if (owner !== undefined && owner !== this.id) return true;
        // The router's own addresses, whether or not they are in the table.
        return ip === IPUtils.toString(net.gatewayIP) || ip === IPUtils.toString(net.dnsServer);
    }

    // The guest has one NIC and one address: a new one replaces the old.
    addIP(ip) {
        if (ip === this.guestIP) return this;
        if (this.guestIP) {
            this.ipAddresses.delete(this.guestIP);
            if (this.network?.ipToDevice.get(this.guestIP) === this.id) this.network.ipToDevice.delete(this.guestIP);
        }
        this.guestIP = ip;
        super.addIP(ip);
        if (this.network) this.network.ipToDevice.set(ip, this.id);
        this.vm._setAddress(ip);
        return this;
    }

    // An IPv4 frame from the guest names its address as the source (bytes 26-29).
    // 0.0.0.0 (a DHCP client before its lease) and broadcast/multicast don't count.
    _learnIP(frame) {
        if (frame.length < 34 || frame[12] !== 0x08 || frame[13] !== 0x00) return;
        const a = frame[26];
        if (a === 0 || a >= 224) return;
        this.addIP(`${a}.${frame[27]}.${frame[28]}.${frame[29]}`);
    }

    // Network → guest.
    handlePacket(frameBuffer /*, fromDevice */) {
        this.vm.deliverFrame(frameBuffer);
        return true;
    }

    /**
     * Check a guest → network frame before it is switched, and learn the
     * guest's MAC (the first time) and IPv4 address from it.
     * @returns {boolean} false: drop the frame (a bad or stolen address)
     */
    acceptFromGuest(frame) {
        if (!(frame instanceof Uint8Array) || frame.length < 14) return this._refuse();
        // Source MAC, bytes 6-11: never a group address, never all-zero.
        if (frame[6] & 0x01) return this._refuse();
        const key = MACUtils.keyNum(frame, 6);
        if (key === 0) return this._refuse();
        if (this._learnedKey === null) {
            if (this._macTaken(key)) return this._refuse();
            // Pin: replace the JS-generated placeholder MAC that register()
            // inserted with the guest's own, so one MAC maps to this bridge.
            if (this.network) this.network.forgetMAC(this.macAddress);
            this._learnedKey = key;
            this.macAddress = new Uint8Array(frame.subarray(6, 12));
            this._learnedMac = this.macAddress;
            if (this.network) this.network.learnMAC(this.macAddress, this.id);
        } else if (key !== this._learnedKey) {
            return this._refuse();
        }

        const type = (frame[12] << 8) | frame[13];
        if (type === 0x0806) {
            // ARP: the sender hardware address (22-27) must be the pinned MAC and
            // the sender protocol address (28-31) not another device's.
            if (frame.length < 42) return this._refuse();
            if (MACUtils.keyNum(frame, 22) !== this._learnedKey) return this._refuse();
            const a = frame[28];
            if (a !== 0 && this._ipTaken(`${a}.${frame[29]}.${frame[30]}.${frame[31]}`)) return this._refuse();
        } else if (type === 0x0800 && frame.length >= 34) {
            const a = frame[26];
            if (a !== 0 && a < 224 && this._ipTaken(`${a}.${frame[27]}.${frame[28]}.${frame[29]}`)) return this._refuse();
            this._learnIP(frame);
        }
        return true;
    }

    _refuse() { this.refused++; return false; }

    /** @deprecated use acceptFromGuest, which also says whether to send the frame */
    learnFromGuest(frame) { return this.acceptFromGuest(frame); }
}

export class VMManager {
    constructor(options = {}) {
        this._netOptions = options.network || {};
        this.networks = new Map();   // name -> VirtualNetwork
        this.network = this.getNetwork('default');
        this.volumes = new VolumeManager(options.volumes || {});
        this.vms = new Map();

        // Optional transport(s) that extend the default LAN beyond this tab:
        // cross-tab (BroadcastChannel), internet via a server (WebSocket relay),
        // P2P (WebRTC), etc. Pass one transport or an array as options.transport(s),
        // or attach later via mgr.network.attachTransport() (on a named network,
        // mgr.getNetwork(name).attachTransport()). Omit for a self-contained
        // in-tab LAN (the common case).
        const transports = options.transports
            || (options.transport ? [options.transport] : []);
        for (const t of transports) this.network.attachTransport(t);

        // The worker resolves relative to this module, so it works wherever the
        // app is served from. The engine (engine.js): options.engine names a
        // TinyEMU release or a folder holding x86emu-wasm.js + .wasm, default
        // the pinned release on TinyEMU's GitHub Pages; options.urls sets the
        // two files' URLs one by one.
        this._urls = {
            workerUrl: new URL('./vm-worker.js', import.meta.url).href,
            ...engineUrls(options.engine),
            ...(options.urls || {}),
        };
    }

    /**
     * The VirtualNetwork called `name`, made (with the manager's network
     * options, then `options`) the first time it is asked for. Each network is
     * its own segment with its own router and DHCP server: no frame crosses from
     * one to another, so give each project its own name.
     */
    getNetwork(name = 'default', options = {}) {
        let net = this.networks.get(name);
        if (!net) {
            net = new VirtualNetwork({ ...this._netOptions, ...options });
            this.networks.set(name, net);
        }
        return net;
    }

    /**
     * Create (but do not start) a VM. Await it so volumes can be provisioned;
     * subscribe to events, then call vm.start().
     *
     * @param {string} id
     * @param {object} config  see VM.js; plus `volumes: [{name, backend, mountpoint, size}]`
     *        and `network`: the name of the VirtualNetwork to join (getNetwork;
     *        default 'default') or a VirtualNetwork. With `hasNetwork: false`
     *        the VM has no NIC, and gets no bridge and no network.
     */
    async create(id, config = {}) {
        if (this.vms.has(id)) throw new Error(`VM ${id} already exists`);

        const mac = config.mac
            ? (typeof config.mac === 'string' ? MACUtils.parse(config.mac) : config.mac)
            : MACUtils.generate(id);

        const vm = new VM(id, config, this._urls);
        vm.mac = MACUtils.toString(mac);

        // --- network bridge (only for a VM with a NIC) ---
        let network = null;
        if (config.hasNetwork !== false) {
            network = config.network instanceof VirtualNetwork
                ? config.network
                : this.getNetwork(config.network == null ? 'default' : String(config.network));
            const bridge = new VMBridgeDevice(id, mac, vm);
            network.register(bridge);
            vm.netDevice = bridge;
            vm.network = network;

            vm.onNetTx((frame) => {
                // A frame that claims another device's address is dropped.
                if (bridge.acceptFromGuest(frame)) bridge.sendPacket(frame);   // → VirtualNetwork.deliverPacket
            });
            // A fresh boot is a fresh NIC with a new random MAC: release the pin.
            // (A snapshot resume keeps its MAC; its first frame pins it again.)
            vm.onState((s) => { if (s === VMState.STARTING) bridge.resetGuest(); });
        }

        // --- volumes ---
        // Volumes (`files` 9p and `block` disks) are owned by the emulator
        // engine: it creates the backend inside the VM's realm (the worker, in
        // worker mode) so guest I/O is served there — a main-thread backend
        // can't serve a worker's synchronous C calls. We only pass the specs
        // through (already on vm.config.volumes) and record them for status.
        // With `storage: 'page'` (always, in isolated mode) the page opens the
        // backends instead, and the worker reaches them over its port.
        if (Array.isArray(config.volumes) && config.volumes.length) {
            vm.volumeSpecs = config.volumes;
        }

        this.vms.set(id, vm);
        (network || this.network).emit?.('vmCreated', vm);
        return vm;
    }

    /**
     * Drop a named network (not 'default') once no VM uses it: detaches its
     * transports. @returns {boolean} whether it was removed
     */
    deleteNetwork(name) {
        const net = this.networks.get(name);
        if (!net || name === 'default') return false;
        for (const vm of this.vms.values()) if (vm.network === net) return false;
        net.detachTransport();
        this.networks.delete(name);
        return true;
    }

    get(id) { return this.vms.get(id); }
    getAll() { return Array.from(this.vms.values()); }

    async start(id) {
        const vm = this.vms.get(id);
        if (!vm) throw new Error(`no VM ${id}`);
        return vm.start();
    }

    async stop(id) { this.vms.get(id)?.stop(); }

    async destroy(id) {
        const vm = this.vms.get(id);
        if (!vm) return;
        vm.stop();
        if (vm.netDevice) (vm.network || this.network).unregister(vm.netDevice.id);
        await this.volumes.detach(id);
        this.vms.delete(id);
    }

    async destroyAll() {
        for (const id of [...this.vms.keys()]) await this.destroy(id);
    }

    /** Snapshot for a status/dashboard UI. */
    getStatus() {
        const networks = {};
        for (const [name, net] of this.networks) {
            networks[name] = { ...net.getStats(), macTable: net.getMACTable() };
        }
        return {
            vms: this.getAll().map(v => v.toJSON()),
            network: this.network.getStats(),        // the default network
            macTable: this.network.getMACTable(),
            networks,
        };
    }
}

export { VMState };
