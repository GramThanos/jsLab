# Networking

Source: `lib/network/` — exported via `lib/network/index.js`.

A complete, backend-free virtual network in pure JS. It moves raw Ethernet frames
between devices, so from a guest's point of view it is a normal LAN with a
gateway and a DHCP server. Everything runs in the browser; no server is required
for VMs within one tab.

```
VM ─virtio-net─▶ VMBridgeDevice ─▶ VirtualNetwork (switch) ─▶ RouterDevice (DHCP/ARP/ICMP)
                                        │
                                        └─ transports ▶ other tabs / internet / peers (optional)
```

## Contents

- [VirtualNetwork](#virtualnetwork) — the switch/coordinator
- [Devices](#devices)
- [Packets](#packets)
- [Utils](#utils)
- [Transports](#transports) — extend the LAN beyond the tab
- [How a real VM connects](#how-a-real-vm-connects)
- [Gotchas](#gotchas)

## VirtualNetwork

The switch and coordinator: MAC-learning unicast, broadcast/multicast flooding,
an IP↔device table, a packet log, and aggregate stats. It also creates a
`RouterDevice` (gateway + DHCP) by default.

```js
import { VirtualNetwork } from './lib/network/index.js';

const net = new VirtualNetwork({
  subnet:    '10.0.2.0/24',
  gatewayIP: '10.0.2.2',
  dnsServer: '10.0.2.3',
  dhcpStart: '10.0.2.15',
  dhcpEnd:   '10.0.2.100',
  leaseTime: 86400,
  staticBindings: { '02:aa:bb:cc:dd:ee': '10.0.2.50' },
  createRouter: true,   // set false to run WITHOUT a local router/DHCP (see transports)
});
```

| Method | Description |
|--------|-------------|
| `register(device)` / `unregister(id)` | Add/remove a device; maintains the MAC and IP tables. |
| `createVM(id, opts)` | Create a **software** `VMDevice` test peer (own DHCP/ARP/ICMP). |
| `createDummyClient(id, opts)` | Create a scriptable test peer. |
| `deliverPacket(fromDevice, frame)` | Entry point: classify + switch/flood a frame. |
| `attachTransport(t)` / `detachTransport([t])` | Extend the segment — see [Transports](#transports). |
| `getTransports()` | Attached transports. |
| `getStats()` / `getMACTable()` / `getIPTable()` / `getPacketLog()` | Introspection. |
| `waitForDHCP(vmDevice)` | Promise that resolves when a software `VMDevice` gets a lease (test helper). |

> `VMManager` creates and owns a `VirtualNetwork` for you. Use the class directly
> for tests or advanced topologies.

## Devices

`lib/network/devices/` — all extend `NetworkDevice` (id, type, MAC, IPs,
capabilities, stats, events; `receivePacket`/`sendPacket`/`handlePacket`).

| Device | Purpose |
|--------|---------|
| `NetworkDevice` / `DeviceManager` | Base class + registry, capabilities, stats, events. |
| `VMBridgeDevice` *(in `lib/vm/VMManager.js`)* | Represents a **real WASM guest**. Forwards frames to/from the VM worker and **learns the guest's MAC** from outbound traffic. This is what real VMs use. |
| `VMDevice` | A pure-JS **software** guest stack (DHCP client state machine, ARP, ICMP echo, `ping()`). For tests without a real VM. |
| `RouterDevice` | The gateway: embedded `DHCPServer` (leases, static bindings, pools), ARP responder, ICMP echo, inter-device forwarding, `ping()`. |
| `DummyClientDevice` | Scriptable peer for tests (auto-reply ARP/ping, packet log). |

Capabilities (`DeviceCapability`): `PACKET_RX`, `PACKET_TX`, `DHCP_CLIENT`,
`DHCP_SERVER`, `ROUTING`, `ARP`, `ICMP`, `DNS_PROXY`, `NAT`.

### DHCP server

Inside `RouterDevice`. Handles DISCOVER/REQUEST/RELEASE/DECLINE/INFORM, dynamic
pools, static bindings, and lease lifetimes. On **ACK it records the assigned IP**
onto the target device and the network's IP→device table, so IP-based lookup and
router forwarding can find bridged guests.

## Packets

`lib/network/packets/` — full parse/serialize for each layer:

| Class | Notes |
|-------|-------|
| `EthernetFrame` | dst/src MAC, ethertype, payload, optional VLAN tag. Helpers `isBroadcast/isMulticast/isARP/isIPv4`. Constants `ETH_P_IP`, `ETH_P_ARP`, … |
| `IPPacket` | IPv4 header + checksum. `IP_PROTO_ICMP/UDP/TCP`. |
| `ARPPacket` | request/reply build + parse. |
| `DHCPPacket` | all standard options; `buildReply`, `getOption*`, message-type constants. |
| `UDPPacket` | build/parse + checksum. |
| `ICMPPacket` | echo request/reply (`buildEchoRequest`, `createEchoReply`). |

```js
import { EthernetFrame, ETH_P_IP } from './lib/network/index.js';
const frame = new EthernetFrame(bytes);       // parse
const bytes2 = frame.serialize();             // build
```

## Utils

`lib/network/utils/`:

- `IPUtils` — `parse`, `toString`, `parseCIDR`, `toNumber`, `numberToIP`,
  `inSubnet`, `broadcast`, `equals`, …
- `MACUtils` — `parse`, `toString`, `generate(id)` (deterministic `02:..`
  per-VM), `isBroadcast`, `isMulticast`, `equals`.
- `Checksum` — `internetChecksum`, `udpChecksum` (internet/UDP/TCP/ICMP).

## Transports

A `VirtualNetwork` is a self-contained **in-tab** LAN by default. To reach
another segment — another tab, the internet, a peer browser — attach a
**transport**. This is the extension point for all "connect to the outside world"
features.

```js
net.attachTransport(transport);     // attach one; call again for more
net.detachTransport(transport);     // detach one
net.detachTransport();              // detach all
```

### The contract

A transport is any object with these methods (subclass `NetworkTransport` for the
shared plumbing, or duck-type them):

```
send(frame: Uint8Array)   VirtualNetwork → link
                          (called for every broadcast and any unicast no local
                           device claimed). Do NOT retain frame; copy if async.
onFrame(cb)               register the sink for link → VirtualNetwork frames;
                          call this._emitFrame(frame) with each received frame.
start()                   open the connection (called on attach).
stop()                    close it, release resources (called on detach).
getStats()                optional; a plain object for dashboards.
```

Frames are complete Ethernet frames (dst MAC | src MAC | ethertype | payload), no
preamble, no FCS — the same bytes the guest NIC produces.

### Delivery rules (handled by VirtualNetwork)

- Broadcasts/multicasts and unplaceable unicasts are mirrored to **every**
  transport **except the one a frame arrived on** (no echo).
- Frames arriving **from** a transport are delivered **locally only** — they are
  not re-forwarded to the other transports. So attaching several transports does
  not by itself bridge them together (that would risk loops/broadcast storms).
  Transit bridging, if ever wanted, would be an explicit opt-in with
  split-horizon + a seen-frame cache.

### Built-in transports (`lib/network/transports/`)

| Transport | Connects VMs to… | Notes |
|-----------|------------------|-------|
| `BroadcastChannelTransport(name, opts?)` | other **tabs/windows** (same origin) | one shared LAN across tabs; per-instance source id avoids self-echo; optional `filter(frame)` |
| `WebSocketRelayTransport(uri?, opts?)` | the **internet via a server** | default `wss://relay.widgetry.org/`; auto-reconnect; `ping:`/`pong:` keepalive; de-bugged successor to `reference-websocket-relay.js` |
| `NetworkTransport` | *(base class)* | subclass to add new kinds — e.g. a `WebRTCTransport` over an `RTCDataChannel` for peer-to-peer (not written yet) |

```js
import { BroadcastChannelTransport, WebSocketRelayTransport } from './lib/network/index.js';

// Cross-tab LAN:
net.attachTransport(new BroadcastChannelTransport('tinyemu-lan'));

// External internet via a relay:
net.attachTransport(new WebSocketRelayTransport());

// Both at once is fine.
```

Or via the manager: `new VMManager({ transports: [ ... ] })` (or `transport: <one>`).

### Writing a new transport

```js
import { NetworkTransport } from './lib/network/index.js';

export class MyTransport extends NetworkTransport {
  constructor(link) { super(); this.link = link; }
  start() { this.link.onmessage = (e) => this._emitFrame(new Uint8Array(e.data)); }
  stop()  { this.link.close(); super.stop(); }
  send(frame) { this.link.send(new Uint8Array(frame)); }  // copy: never retain `frame`
}
```

### DHCP topology on a shared segment

Each `VirtualNetwork` has its **own** DHCP server by default; two servers on one
shared segment will both answer (and can hand out colliding IPs). When several
networks share a segment:

- run the router/DHCP in exactly **one** of them, and create the others with
  `new VirtualNetwork({ createRouter: false })` — they get DHCP/ARP for the
  gateway over the transport;
- with the **external relay**, let the relay's own DHCP assign addresses
  (`createRouter: false`).

## How a real VM connects

`VMManager` creates one `VMBridgeDevice` per VM and overrides its packet path:

- guest emits a frame (`net-tx`) → `learnFromGuest` (MAC learning) →
  `VirtualNetwork.deliverPacket` → switched to the target (or flooded);
- a frame destined for that guest → `vm.deliverFrame` → guest RX queue.

The guest kernel runs its own DHCP/ARP/ICMP; the software `VMDevice` stack is
**not** used for bridged VMs (it exists only for pure-JS test peers).

Guests booted with `init=/bin/sh` won't auto-configure — run `udhcpc -i eth0`
in-guest (the demo's **Net up** button does this) to get a lease from the JS DHCP
server. Then VMs can `ping`/talk.

## Gotchas

- **Bring the guest interface up.** No `udhcpc`/`ip link up` → no lease → the JS
  network sits idle. This is the most common "networking looks broken".
- **No NAT for TCP** without a relay; `WebSocketRelayTransport` needs a reachable
  relay for external internet.
- **`createRouter: false`** whenever a segment already has a DHCP server
  elsewhere (see above).

## Testing

- Node self-test (two software VMs ping): see [getting-started](./getting-started.md#quick-network-self-test-no-browser).
- Regression suite: `node tests/network-fixes.test.mjs` (router single-delivery,
  MAC learning, DHCP IP recording, multi-transport mirror/echo rules).
</content>
