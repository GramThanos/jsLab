# jsLab runtime — architecture

The JavaScript layer that runs one or more TinyEMU emulator instances (compiled
to WebAssembly) inside a browser, wires them to a virtual network, and gives
them persistent, Docker-like volumes.

> **Status legend:** ✅ done & tested · 🟡 implemented, needs guest assets or
> C-side work to fully exercise · 🔴 planned / needs C-side work.

> 📚 **Component documentation:** [Getting started](./getting-started.md), then
> the per-category guides ([VM](./vm.md) · [Networking](./networking.md) ·
> [Storage](./storage.md) · [WASM runtime](./wasm-runtime.md)). This page is the
> architecture overview + roadmap.

The WASM engine (`x86emu-wasm.js` + `.wasm`) is built by
[TinyEMU](https://github.com/gramthanos/TinyEMU) (`Makefile.js`) and bound to
the browser through TinyEMU's `wasm/lib.js` (the `Module.api` binding). jsLab
ships no copy: it loads a release from TinyEMU's GitHub Pages, the one
`lib/vm/engine.js` pins unless told otherwise (see §7).

---

## 1. High-level architecture

```
┌───────────────────────── Browser main thread ─────────────────────────┐
│                                                                        │
│  VMManager ── owns ──▶ VirtualNetwork (JS L2/L3 stack, DHCP, ARP, ...) │
│      │                                                                 │
│      ├── VM #1 (handle) ──postMessage──▶ Worker #1 ─▶ WASM (global_vm) │
│      ├── VM #2 (handle) ──postMessage──▶ Worker #2 ─▶ WASM (global_vm) │
│      └── VM #N ...                                                     │
│      │                                                                 │
│      └── VolumeManager ─▶ OPFS / IndexedDB / File System Access        │
│                                                                        │
│  Each VM handle bridges: console (xterm) · display (canvas) ·          │
│  net frames (⇄ VirtualNetwork) · volume block/fs requests              │
└────────────────────────────────────────────────────────────────────────┘
```

**Bypassing the singleton.** The emulator is a *singleton*: the C side
(`jsemu.c`) has one `static VirtMachine *global_vm;`, and Emscripten emits one
global `Module`. Naively you cannot run two VMs in one JS realm. Two mechanisms
solve this (see §4):

- **Closure wrapping** (`EmulatorFactory`): the bundle's text is wrapped in
  `(function(Module){ …bundle… ; return Module; })` so every instantiation gets
  its **own isolated `Module`** (and its own `global_vm` inside the wasm). This
  needs no rebuild and works on the main thread and in workers.
- **One Web Worker per VM** (`WorkerHost`): additionally isolates a busy VM's
  CPU loop from the UI thread.

So a VM runs in one of two **modes**: `inline` (main thread, many isolated
Modules via the factory) or `worker` (default; the worker uses the same factory
internally). The main thread holds lightweight *handles* (`VM`) either way.

---

## 2. Directory layout

```
jsLab/
├── index.html                 Landing page (links the demos).
├── demos/
│   ├── demo.html              Multi-VM lab: VMs on one LAN, IPs, lan-chat.py.
│   ├── linux-distro.html      Single-VM lab.
│   ├── terminal.js            xterm.js console shared by the labs (copy/paste).
│   ├── distros.js             Distro list: TinyEMU-distros' published manifest.
│   └── lan-chat.py            Peer-to-peer UDP broadcast chat, typed into guests.
├── lib/
│   ├── linux.js               Simple single-VM bootstrap (xterm + Module.api).
│   ├── vm/                    ✅ VM wrapper / manager.
│   │   ├── index.js
│   │   ├── engine.js           Where the engine loads from (pinned TinyEMU release).
│   │   ├── EmulatorFactory.js  Closure-wraps the bundle → isolated Module per instance.
│   │   ├── EmulatorEngine.js   Drives one Module: boot, console/net I/O, Module.api.
│   │   ├── InlineHost.js       Runs a VM on the main thread (mode: 'inline').
│   │   ├── WorkerHost.js       Runs a VM in a worker (mode: 'worker', default).
│   │   ├── VM.js               Main-thread handle: lifecycle, events, stats.
│   │   ├── VMManager.js        Owns many VMs + shared VirtualNetwork + VolumeManager.
│   │   ├── SnapshotStore.js, snapshot.js   Save / resume a VM.
│   │   └── vm-worker.js        Module worker; hosts a Module via the same factory/engine.
│   ├── volumes/               Docker-like persistent storage.
│   │   ├── index.js, VolumeManager.js, Fs9pStore.js, OverlayBlockStore.js
│   │   └── backends/          StorageBackend, IndexedDB, OPFS, FileSystemAccess
│   └── network/               ✅ Virtual network stack (see §3).
│       ├── index.js
│       ├── devices/  {NetworkDevice, VMDevice, RouterDevice, DummyClientDevice, VirtualNetwork}
│       ├── packets/  {EthernetFrame, IPPacket, ARPPacket, DHCPPacket, UDPPacket, ICMPPacket}
│       ├── transports/ {NetworkTransport, BroadcastChannelTransport, WebSocketRelayTransport}
│       └── utils/    {IPUtils, MACUtils, Checksum}
├── docs/                      this documentation; docs/plans/ holds the original designs
├── scripts/serve.mjs          static server for the demos (npm run serve)
└── tests/                     node tests (npm test)
```

The C-side changes this layer needed are recorded in TinyEMU's `plan-c-changes.md`.

---

## 3. Networking manager — status: ✅ WORKING

A complete, backend-free virtual network implemented in pure JS/OOP. It moves
raw Ethernet frames between devices, so from the guest's point of view it is a
normal LAN with a gateway and DHCP.

**Verified in Node**: two `VMDevice`s each obtain a DHCP lease
(`10.0.2.15`, `10.0.2.16`) and ping each other with 0% loss.

### Devices (`lib/network/devices/`)
- `NetworkDevice` / `DeviceManager` — base class + registry, capabilities, stats, events.
- `VMDevice` — a **software** guest stack: DHCP client (state machine w/ renewal),
  ARP, ICMP echo, `ping()`. This is what a *real* WASM VM's frames get bridged to,
  and also usable standalone for testing without a VM.
- `RouterDevice` — the gateway: embedded `DHCPServer` (leases, static bindings,
  pool mgmt), ARP responder, ICMP echo, inter-device forwarding.
- `DummyClientDevice` — a scriptable peer for tests (auto-reply ARP/ping, packet log).
- `VirtualNetwork` — the switch/coordinator: MAC-learning unicast, broadcast/
  multicast flooding, IP↔device table, packet log, aggregate stats.

### Packets (`lib/network/packets/`)
Full parse/serialize for `EthernetFrame`, `IPPacket` (+checksum), `ARPPacket`,
`DHCPPacket` (all standard options), `UDPPacket`, `ICMPPacket`.

### Utils (`lib/network/utils/`)
`IPUtils` (CIDR, subnet math), `MACUtils` (deterministic per-VM MAC generation),
`Checksum` (internet/UDP/TCP/ICMP).

### How a real VM connects to it
`VMManager` creates one `VMDevice` per VM but **overrides its packet path** so
that:
- frames the guest emits (`net-tx` from the worker) → `VirtualNetwork.deliverPacket()`
- frames the network delivers to that device → `net-rx` into the worker → guest RX queue

The `VMDevice`'s built-in software DHCP/ARP/ICMP is disabled for bridged VMs
(the *guest kernel* does that itself); it is kept only for pure-JS test peers.

### Extending the network with transports — status: ✅
By default a `VirtualNetwork` is a **self-contained in-tab LAN** — create a
`VMManager`, add VMs, and they interconnect with no extra setup. That is the
common case and needs nothing below.

To reach *beyond* the tab, `VirtualNetwork` has a pluggable extension point: a
**transport** is any link that carries Ethernet frames to another segment.
Attach as many as you like:

```js
virtualNetwork.attachTransport(transport);   // one or several
virtualNetwork.detachTransport(transport);   // or detachTransport() for all
```

A transport is just an object with four methods (subclass
`NetworkTransport` for the shared plumbing, or duck-type it):

```
send(frame)      VirtualNetwork → link   (broadcasts + unicast no local device claimed)
onFrame(cb)      link → VirtualNetwork   (call cb with each received Uint8Array)
start() / stop() open / close the link   (called on attach / detach)
```

Delivery rules (enforced by `VirtualNetwork`): broadcasts and unplaceable
unicasts are mirrored to every transport *except the one a frame arrived on* (no
echo); frames arriving from a transport are delivered locally only and are **not**
re-forwarded between transports (no transit bridging → no loops/storms).

Three transports ship in `lib/network/transports/` — each is one implementation
of the same contract, and the pattern to copy for new connection types:

| Transport | Connects VMs to… | Notes |
|-----------|------------------|-------|
| `BroadcastChannelTransport(name)` | other **tabs/windows** (same origin) | one shared LAN across tabs |
| `WebSocketRelayTransport(uri)` | the **internet via a server** | default `wss://relay.widgetry.org/`; auto-reconnect + `ping:`/`pong:` keepalive; de-bugged successor to `reference-websocket-relay.js` |
| *(your `WebRTCTransport`)* | **peer browsers, P2P** | not written yet — implement `send`/`onFrame` over a WebRTC `RTCDataChannel` |

```js
import { BroadcastChannelTransport } from './lib/network/transports/BroadcastChannelTransport.js';
const mgr = new VMManager({
  network: { subnet: '10.0.2.0/24' },
  transports: [ new BroadcastChannelTransport('tinyemu-lan') ],   // or transport: <one>
});
```

**DHCP topology on a shared segment:** each `VirtualNetwork` has its own DHCP
server by default, and two servers on one segment will both answer. When several
networks share a segment (cross-tab, or an external relay), run the router/DHCP
in exactly ONE of them and create the others with `network: { createRouter: false }`
so they get DHCP/ARP for the gateway over the transport. With the external relay,
let the relay's own DHCP assign addresses (`createRouter: false`).

### Known limitations / fixed bugs
- 🟡 **External internet** is now available via `WebSocketRelayTransport` (needs
  a reachable relay). A fetch-based TCP NAT is still not implemented.
- Fixed in this pass: the router **double-processed every broadcast** (it is a
  registered device *and* was delivered to explicitly), producing duplicate DHCP
  OFFER/ACK and ARP replies — the explicit second delivery was removed. Inline
  `stop()` left the guest **emitting net-tx/console** after stop (the C run loop
  can't be halted from JS) — the emit callbacks now honour `running`. Bridge MAC
  learning **leaked the JS-generated placeholder MAC** into the switch table on
  first learn — it is now removed. DHCP ACK now **records the guest IP** onto the
  device and the IP→device table (was left empty, breaking `findDeviceByIP`).
- Earlier pass: `RouterDevice.forwardPacket` referenced an undefined
  `frameBuffer`; `RouterDevice.sendARPReply` called `ARPPacket.DHCPPacket.buildReply`;
  `DummyClientDevice.handleIPv4` used a non-existent `IPPacket.IP_PROTO_UDP`.

Regression tests for these live in `tests/network-fixes.test.mjs`
(`node tests/network-fixes.test.mjs`).

---

## 4. The WASM bundle & the isolation mechanism

The bundle is built from this repo's current C sources with
`--js-library js/lib.js`, so every host call routes through a per-instance
`Module.api` object — no module globals, no DOM assumptions, worker-friendly:

| C import                  | Calls…                              | Wired to |
|---------------------------|-------------------------------------|----------|
| `console_write` / `_size` | `Module.api.terminal.write/getSize` | console  |
| `net_recv_packet`         | `Module.api.net.recvPacket`         | guest → network |
| `fs_wget_update_downloading` | `Module.api.downloading.update`  | download indicator |
| `emscripten_async_wget3_data` | `Module.api.wgetRequests`       | HTTP fetches |
| `fs_export_file`          | `Module.api.export_file`            | file download |
| `fb_refresh`              | `Module.api.display`                | framebuffer (graphics) |
| `file_buffer_*`           | `Module.api.fbuf_table`             | in-memory file buffers |

Exported (cwrap'd) C functions: `vm_start`, `net_write_packet`,
`net_set_carrier`, `console_queue_char`, `fs_import_file`, `display_key_event`,
`display_mouse_event`, `display_wheel_event` (+ `_malloc`/`_free`).

**`vm_start` ABI (7 args):** `(url, ram_size, cmdline, pwd, width, height,
has_network)`. Two gotchas learned the hard way and handled in the code:
- the config `url` **must be absolute** — a relative URL aborts inside the C
  loader (`VM.start` resolves it against `location.href`);
- `Module.api` and `Module.locateFile` (for the `.wasm`) must be set on the
  Module **before** the bundle runs; `onRuntimeInitialized` is the safe point to
  `cwrap`/`vm_start`.

**Isolation.** The bundle is emitted as a classic script (no `MODULARIZE`) that
does `var Module = typeof Module!=="undefined" ? Module : {}`. `EmulatorFactory`
loads its text once and wraps it in `new Function('Module', src + ';return
Module;')`; each call passes a fresh `Module` (with its `api`) and gets back an
isolated instance — the singleton bypass. (Requires the page CSP to allow
`new Function`.) `EmulatorEngine` builds the `Module.api` from a `sink` of
callbacks; `InlineHost`/`WorkerHost`/`vm-worker.js` route that sink to the `VM`
handle (direct calls, or `postMessage` for workers).

**Rebuilding:** `make -f ../Makefile.js` inside the emscripten container — see §7.

---

## 5. VM wrapper / manager — status: ✅

Implements the `plan-vm-wrapper.md` requirements:

| Requirement                                  | Where                              |
|----------------------------------------------|------------------------------------|
| Multiple instances in parallel               | `EmulatorFactory` (isolated Module) + `VMManager` |
| Interconnection with the outside world       | net bridge → `VirtualNetwork`      |
| Consoles wired to terminals                  | `VM.onConsole` / `VM.sendInput`    |
| Init / distro to boot                        | `create(id, { configUrl, ... })`   |
| VM init & params (e.g. custom MACs)          | `VMManager.create({ mac, ... })`   |
| VM stages: start / stop / pause              | `VM.start/stop/pause/resume`       |
| Save a running VM and resume it later        | `VM.saveSnapshot`, `snapshot` option, `SnapshotStore` |
| Container-like volume mapping                | `volumes` option → `VolumeManager` |
| Networking via the network libs              | `VMBridgeDevice` → `VirtualNetwork`|
| Run inline OR on a Web Worker                | `mode: 'inline' \| 'worker'`       |
| Status indicators & runtime attributes       | `VM.state`, `VM.stats`, events     |

### Lifecycle
`start`, `stop`, `pause`, and `resume` are all supported. The emulator drives
itself with a self-rescheduling `emscripten_async_call(virt_machine_run, ...)`
chain that JS cannot suspend from outside, so pause/stop are implemented in C:
`jsemu.c` exports `vm_pause` / `vm_resume` / `vm_stop`, which `EmulatorEngine`
cwraps and calls. `pause()` halts the run loop after the current tick and
`resume()` re-arms it; `stop()` halts it for good (worker mode also terminates the
worker). Emission callbacks remain gated on `running`, so a build lacking these
exports still won't leak console/net after stop. (See `plan-c-changes.md §2`.)

### Snapshots (save and resume)
`vm.saveSnapshot()` returns `{ blob, info }`: the whole running machine,
gzip-compressed. Starting a VM with `snapshot: blob` in its config resumes it
instead of booting, typically in 2-3 s. The Alpine 3.20 image right after boot
gives a 32 MB snapshot, and the VM pauses for about 0.1 s while it is copied.

- **What is saved:** in the browser everything the machine is lives in one WASM
  memory: guest RAM, the CPU, every device, and the run loop's own flags. A
  snapshot is that memory, skipping all-zero 64 KB pages, plus the one piece of
  state `lib.js` keeps outside it: the file buffers where `block_net.c` holds
  downloaded disk blocks and the guest's disk writes. See
  [lib/vm/snapshot.js](lib/vm/snapshot.js) for the format.
- **What is not:** attached JS volumes, which persist on their own, and JS-side
  network state, so connections through the virtual network don't survive.
- **When:** `saveSnapshot` waits until no download or JS disk request is in
  flight, since one would never complete in the restored instance.
- **Restoring** needs the same wasm build, because function pointers are table
  indices, and the same config and disk images. `SnapshotStore` keeps snapshots in
  IndexedDB under a fingerprint of those (`snapshotFingerprint`: the wasm bytes,
  the config text, the `Last-Modified`/`ETag` of the kernel and drive files it
  names, and the VM options). Pass it the VM's `configOverride` too, so it
  fingerprints the config the VM actually boots. `load` returns a snapshot only if its fingerprint
  matches, and deletes a stale one.
- **Time:** the emulated PIT, RTC and TSC all read `host_clock_ns()`
  (`machine.c`), which `vm_restore` shifts so the guest's clocks continue from the
  snapshot instead of jumping by the time it spent saved. The guest's wall-clock
  date stays behind by that time until something sets it; the agent demo runs
  `date -s` when it reconnects.
- **C exports:** `vm_snapshot_clock`, `vm_reserve_memory` and `vm_restore`
  (`jsemu.c`). The run loop records whether a tick is already scheduled, so the
  pause and resume around a capture can't start a second loop.

### Worker message protocol
```
main → worker : start {config} | stdin {data} | net-rx {frame}
                resize {cols,rows} | pause | resume | stop
                snapshot {id,options}
worker → main : booted | stdout {data} | net-tx {frame} | state {state}
                downloading {flag} | export-file {name,blob} | log {level,text}
                error {message} | exit | snapshot-reply {id,ok,blob,info|error}
```

### Minimal usage
```js
import { VMManager } from './lib/vm/index.js';

const mgr = new VMManager({ network: { subnet: '10.0.2.0/24' } });

const vm = await mgr.create('alpine1', {
  configUrl: 'alpine-x86.cfg',      // TinyEMU .cfg (kernel + fs0 + eth0); resolved to absolute
  memoryMB: 256,
  mode: 'worker',                   // or 'inline' (many VMs, one thread)
  hasNetwork: true,
  // mac: '02:11:22:33:44:55',      // optional; else deterministic from id
  // volumes: [{ name:'data', backend:'opfs', mountpoint:'/mnt/data' }],  // guest mount needs C (§6)
});

vm.onConsole(bytes => xterm.write(bytes));   // guest → screen
xterm.onData(data => vm.sendInput(data));     // keyboard → guest
vm.on('downloading', on => showSpinner(on)); // asset fetch indicator

await vm.start();
// vm.stop();  await vm.pause();  await vm.resume();
```

See `demo.html` for a working multi-VM page (inline/worker toggle). Reaching a
shell needs a kernel + rootfs the config points to (not checked in yet).

---

## 6. Volumes — status: ✅ (JS storage + guest mount, in-browser check pending)

Implements `plan-vm-volumes.md`. The guest-mount half is now built too — a
JS-backed 9p `FSDevice` (`files` volumes), a JS virtio-block disk, and a
copy-on-write overlay over an HTTP base — all built and unit-tested (see
`doc/storage.md`; the C bridge is `fs_js.c` / `block_js.c`). The two halves:

1. **JS storage backends** (`lib/volumes/backends/`) — ✅ real, work today:
   - `IndexedDBBackend` — block/kv store in the browser DB. No permissions.
   - `OPFSBackend` — Origin Private File System; fast, sandboxed, persistent.
   - `FileSystemAccessBackend` — 🟡 mount a **real local directory** the user
     picks (`showDirectoryPicker`); needs a user gesture + permission grant, and
     is Chromium-only.
   All expose one async interface (`readBlock/writeBlock/flush` for overlay
   images; `readFile/writeFile/list` for file-level volumes).

2. **Getting that storage *into the guest*** — 🔴 needs C-side work, because the
   shipped emulator only knows two backends, both effectively read-only in the
   browser:
   - virtio-block over **HTTP** (`block_net.c`, `block_device_init_http`) — cached
     writes, **not persisted**.
   - virtio-9p over the **network filesystem** (`fs_net.c`) — remote, read-mostly.

   To satisfy the plan we need a **JS-backed** block device and/or 9p filesystem
   whose `read_async` / `write_async` (block) or `FSDevice` ops (9p) call back
   into JS, which then reads/writes the chosen backend. Concretely:

   - **Overlay mode** (whole-disk persistence): a copy-on-write `BlockDevice`
     whose base is the HTTP image and whose overlay sectors live in a JS backend.
     Best implemented as `block_device_init_js()` in C bridging to the
     `file_buffer_*` style API already in `lib.js`. → `plan-c-changes.md`.
   - **Docker-like volume** (map a path): a second 9p mount (`fs1: {...}` in the
     cfg) backed by a JS `FSDevice`, mounted in-guest at e.g. `/mnt/<name>`.

   The worker protocol already reserves `volume-request` / `volume-reply`
   messages so the async JS backend can serve synchronous-looking guest I/O via
   the Emscripten Asyncify or a request/response queue.

**Bottom line:** the browser-side persistence is ready; wiring it through the
guest is the main remaining C task. Full details and signatures in
`plan-c-changes.md`.

---

## 7. Build & run

The JS (network / vm / volumes) are native ES modules — no bundler needed.
Serve the repository root over HTTP (ES modules + WASM require it; `file://`
won't work):

```bash
npm run serve                         # then open http://localhost:8000/demos/demo.html
```

The engine loads from TinyEMU's GitHub Pages: the release `ENGINE_VERSION` in
`lib/vm/engine.js` pins, or another with `new VMManager({ engine: 'latest' })`
or a release name. To run your own build (`make -f Makefile.js` in TinyEMU, in
the `emscripten/emsdk:3.1.74` image), serve its `dist/wasm/` and pass that folder:
`new VMManager({ engine: '/path/to/wasm/' })`; the demos take it as `?engine=`.

The engine is a classic (non-`MODULARIZE`) script on purpose, so
`EmulatorFactory` can closure-wrap it for isolation.

> After replacing the engine during a live session, **hard-reload** the page
> (Ctrl/Cmd+Shift+R). The JS loader revalidates (`cache:'no-cache'`), but the
> browser may otherwise pair the fresh loader with a stale cached `.wasm`, which
> fails to instantiate (import-module mismatch). Fresh visitors are unaffected.

### Quick network self-test (no browser)
```bash
node --input-type=module -e "
import { VirtualNetwork } from './lib/network/index.js';
const n = new VirtualNetwork(); const a = n.createVM('a'), b = n.createVM('b');
n.waitForDHCP(a).then(()=>n.waitForDHCP(b)).then(async()=>{
  console.log(await a.ping(b.getDHCPLease().ip, 3, 200)); process.exit(0); });"
```

---

## 8. Roadmap (ordered)

1. ✅ Networking manager (DHCP/ARP/ICMP, inter-VM) — done & tested.
2. ✅ Rebuild WASM from current C against TinyEMU's `wasm/lib.js` (`Module.api`, worker-safe).
3. ✅ VM wrapper/manager (closure-isolated Modules, inline+worker, lifecycle,
   console + net bridge) — validated to config-fetch in the browser.
4. ✅ Multi-VM demo page (`demo.html`).
5. ✅ **Ship a kernel + rootfs image** → reaches a shell, in **both** the
   single-VM page (`linux-distro.html`) and the **multi-VM `demo.html`**
   (inline *and* worker verified interactive: `uname -m`→i686,
   `/etc/alpine-release`→3.20.3). Built by the TinyEMU-distros
   pipeline (Alpine 3.20 x86, chunked virtio-block); the demos boot the
   images that repo publishes on its Pages (its `manifest.json` is the
   dropdown source). Guest streams `blk*.bin` (now 512 KB
   `blk*.bin.gz`, gzipped, which `block_net.c` inflates)
   chunks over HTTP. Browser-boot facts learned here:
   - the cfg's kernel + drive URLs must be **absolute** — the browser resolves
     the kernel relative to the .cfg dir but the drive relative to the document
     root, so only absolute satisfies both (a relative/root-relative base 404s
     the drive → the guest exits(1));
   - `eth0: {driver:"user"}` is **fine in the browser**: the WASM build ignores
     the driver field and bridges the NIC to JS (`jsemu.c` create_vm), so the
     same cfg works natively (SLIRP) and in-browser (⇄ `VirtualNetwork`);
   - a real boot to `/bin/sh` takes **~20-25 s** in the browser — don't mistake
     the pre-shell window for a hang.
   (Guest-side networking still needs the guest to bring the interface up, e.g.
   `udhcpc`; with `init=/bin/sh` it won't auto-configure — a recipe/init concern.)
6. ✅ C-side `vm_pause` / `vm_resume` / `vm_stop` exports for true pause/stop
   (`jsemu.c`; wired through `EmulatorEngine`). Interactive guest check pending.
7. ✅ Volumes: JS backends → JS 9p `FSDevice` (docker-like `files` mounts,
   `fs_js.c` + `Fs9pStore`) → JS virtio-block fresh disk (`block_js.c`) →
   copy-on-write overlay over an HTTP base (`OverlayBlockStore`, JS-only). All
   built + unit-tested; in-browser guest verification of the device paths pending.
8. ✅ Pluggable transports (`NetworkTransport` + `VirtualNetwork.attachTransport()`,
   multiple at once): `BroadcastChannelTransport` (cross-tab) and
   `WebSocketRelayTransport` (internet via a server). 🔴 Remaining: a
   `WebRTCTransport` for peer-to-peer across machines without a relay; a
   fetch-based TCP NAT.
