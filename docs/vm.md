# VM runtime

Source: `lib/vm/` — exported via `lib/vm/index.js`.

Manages one or more TinyEMU instances, their lifecycle, console/network I/O, and
the bridge onto a virtual network and volumes. What the page trusts from a VM's
worker, and the isolated mode, are in [runtime § 9](./runtime.md#9-trust-boundary-and-isolation).

## Classes at a glance

| Class | Role |
|-------|------|
| `VMManager` | Owns many VMs, their `VirtualNetwork`s (a default one, or one per name) and a `VolumeManager`. Your main entry point. |
| `VM` | Main-thread **handle** for one instance: lifecycle, events, stats, I/O routing. |
| `InlineHost` | Runs a VM on the current thread (`mode: 'inline'`). |
| `WorkerHost` | Runs a VM in its own Web Worker (`mode: 'worker'`, default). Checks every message from the worker. |
| `IsolatedHost` | Runs the worker in a sandboxed frame with no network or storage of its own (`mode: 'isolated'`). |
| `EmulatorEngine` | Drives one isolated `Module`: boot, cwrap'd exports, the `Module.api` bridge. Shared by both hosts. |
| `EmulatorFactory` | Produces isolated `Module`s from one bundle (see [WASM runtime](./wasm-runtime.md)). |

The main thread always holds a lightweight `VM` handle; the actual emulator runs
either inline or in a worker behind it, but both use the same `EmulatorEngine`,
so behaviour is identical — only isolation and threading differ.

## VMManager

```js
import { VMManager } from './lib/vm/index.js';

const mgr = new VMManager({
  network:   { subnet: '10.0.2.0/24' },   // VirtualNetwork options (see networking.md)
  volumes:   { /* VolumeManager options */ },
  transports: [ /* optional NetworkTransport instances */ ],  // or transport: <one>
  urls:      { /* override worker/wasm URLs; usually omit */ },
});
```

| Method | Description |
|--------|-------------|
| `await create(id, config)` | Create (don't start) a VM; provisions volumes and wires the net bridge (none with `hasNetwork: false`). Returns the `VM`. |
| `getNetwork(name = 'default', options?)` | The `VirtualNetwork` called `name`, made on first use. `mgr.network` is the default one. |
| `deleteNetwork(name)` | Drop a named network once no VM is on it. |
| `get(id)` / `getAll()` | Look up handles. |
| `await start(id)` / `await stop(id)` | Start / stop by id. |
| `await destroy(id)` | Stop, unregister from the network, detach volumes, forget. |
| `await destroyAll()` | Destroy every VM. |
| `getStatus()` | Snapshot `{ vms, network, macTable, networks }` for a dashboard (`network`/`macTable`: the default network; `networks`: each by name). |

Every VM with a NIC gets a deterministic placeholder MAC from its id (or pass
`mac`) and a `VMBridgeDevice` on its `VirtualNetwork`; if you pass `volumes`,
it gets provisioned browser storage. The bridge **pins the guest's real MAC**
from its first outbound frame (TinyEMU picks the NIC's MAC at random at boot), so
unicast from other VMs finds it, and from then on drops frames from any other
source MAC, or with a source MAC or IPv4 address that belongs to another device
on the network. A new boot releases the pin.

**One network per project.** A `VirtualNetwork` is one segment: a broadcast
reaches every VM on it. VMs that must not see each other's traffic (different
projects, users or tenants) belong on different networks:

```js
await mgr.create('a1', { configUrl, hasNetwork: true, network: 'project-a' });
await mgr.create('b1', { configUrl, hasNetwork: true, network: 'project-b' });
// or pass a VirtualNetwork you made: { network: myNetwork }
```

Each named network has its own router and DHCP server, made with the manager's
`network` options. VMs without a `network` share the default one.

## VM config

Passed to `mgr.create(id, config)`:

| Field | Default | Notes |
|-------|---------|-------|
| `configUrl` | — | TinyEMU `.cfg` (kernel + fs0 + eth0): an `http(s)` URL (relative to the page), or a `blob:` or `data:` URL. Files the `.cfg` names are relative to it; a `blob:`/`data:` config has no directory, so its files are relative to the page (in worker mode too). |
| `configOverride` | — | Changes the `.cfg` before boot: an **object** deep-merged into it, or a **function** `(cfg) => newCfg` (may be async). See [config overrides](#config-overrides). |
| `mode` | `'worker'` | `'worker'` (off the UI thread, clean stop), `'inline'` (many VMs, one thread, no worker needed) or `'isolated'` (a worker in a sandboxed frame with no network or storage of its own; see [isolated mode](./runtime.md#isolated-mode)). |
| `network` | `'default'` | The network to join: a name (see `mgr.getNetwork`) or a `VirtualNetwork`. Ignored with `hasNetwork: false`. |
| `storage` | `'worker'` | `'page'`: the page opens the volumes' backends and the worker only asks it for keys and bytes ([storage § page-owned](./storage.md#page-owned-storage)). Always so in isolated mode. |
| `exportFiles` | `false` | `true` passes the engine's exported files on as `export-file` events. Off, the page drops them. |
| `isolation` | — | Isolated mode only: `{ allow, maxBytes }`: URLs (strings, `'…/'` folders, RegExps or predicates) added to the files the worker may have the page fetch, and the per-response cap (default 256 MiB). |
| `memoryMB` | the `.cfg`'s `memory_size` | Guest RAM in MiB. Given, it replaces the `.cfg`'s `memory_size` (also one set by `configOverride`). |
| `cmdline` | `''` | Extra kernel cmdline, appended to the `.cfg`'s. |
| `napiTxFix` | `true` | With `hasNetwork`, appends `virtio_net.napi_tx=0` to the kernel cmdline. TinyEMU's virtio rings hold 16 buffers, fewer than the 19 free slots Linux's NAPI transmit path waits for, so without it the guest sends one frame and then nothing. `false` leaves the cmdline alone. |
| `hasNetwork` | `true` | `false`: the machine has no NIC, the VM gets no bridge and no network, and the page drops any `net-tx` from its worker. |
| `cols`, `rows` | `80×24` | Console size reported to the guest. |
| `width`, `height` | `0` | Framebuffer size (graphics builds). |
| `mac` | derived from id | `'02:..'` string or `Uint8Array`. |
| `volumes` | `[]` | Array of volume specs — see [storage](./storage.md). |

### Config overrides

With `configOverride`, `vm.start()` fetches `configUrl`, parses it (TinyEMU's
relaxed JSON: comments, unquoted keys, `0x` numbers) and makes its file paths
(`bios`, `kernel`, `initrd`, `driveN.file`, `fsN.file`) absolute. Then:

- an **object** is merged in: objects merge key by key, anything else (arrays
  too) replaces, and `null` deletes a key;
- a **function** gets that config as a JS object and returns the one to boot.
  It may be async, and if it returns nothing, the object it was given (and may
  have changed) is used.

The result is written back in TinyEMU's format and booted as a `data:` URL. It's
on `vm.resolvedConfig` once the VM starts. This runs on the main thread, so a
function works in worker mode too.

```js
// more memory, no network card, another kernel (relative to the page)
await mgr.create('a', { configUrl: 'alpine-x86.cfg',
    configOverride: { memory_size: 512, eth0: null, kernel: 'my/kernel.bin' } });

// anything else: a function
await mgr.create('b', { configUrl: 'alpine-x86.cfg',
    configOverride: (cfg) => ({ ...cfg, cmdline: cfg.cmdline + ' quiet' }) });

// a config made on the page
const text = JSON.stringify({ version: 1, machine: 'pc', memory_size: 256,
    kernel: 'https://example.org/kernel-x86.bin', fs0: { file: 'https://example.org/rootfs' } });
await mgr.create('c', { configUrl: URL.createObjectURL(new Blob([text])) });
```

Notes: an override of `memory_size` takes effect only without `memoryMB`. TinyEMU reads only non-negative integers, so a fractional or negative
number is refused with the key's name. Drives and filesystems are numbered from 0
without gaps (`drive0`, `drive1`, ...): deleting `drive0` hides `drive1` too.
`parseConfig`, `stringifyConfig`, `mergeConfig` and `loadConfig` are exported
from `lib/vm/index.js` for pages that want to work on a config themselves.

## VM handle

### Lifecycle

```js
await vm.start();     // NEW|STOPPED → STARTING → RUNNING; resolves when booted
vm.stop();            // → STOPPED (worker: terminates; inline: best-effort, see caveat)
await vm.pause();     // resolves true only if the C vm_pause export exists (else no-op)
await vm.resume();
```

`VMState`: `new · starting · running · paused · stopped · error`.

**Pause/stop.** The emulator drives itself with a self-rescheduling C run loop.
Suspending it from outside needs C-side `vm_pause`/`vm_resume`/`vm_stop` exports —
these are now implemented (`jsemu.c`) and wired through `EmulatorEngine`, so
`pause()`/`resume()` work in both inline and worker modes and `stop()` truly
halts the loop. (Emission callbacks are still gated on `running`, so even a build
without these exports won't leak console/net after stop.) Rebuild the WASM if you
are on an older bundle — see [WASM runtime § Rebuilding](./wasm-runtime.md#rebuilding-the-wasm).

### I/O

```js
vm.sendInput('ls -la\n');       // string (sent as UTF-8) or Uint8Array → guest stdin
vm.resize(cols, rows);          // update reported console size
vm.deliverFrame(frame);         // inject a net frame INTO the guest (used by the bridge)
vm.ip;                          // the guest's IPv4 address once seen, else null
```

TinyEMU's console input buffer holds 1 KiB and drops the rest, so `sendInput`
queues its bytes and hands them over 128 at a time every 20 ms: a long paste or
a file typed into the guest arrives whole, at about 6 KB/s.

`vm.ip` comes from the VM's network bridge: the DHCP ACK the JS router sends the
guest, or the source address of the guest's own IPv4 traffic (a static address).
A new address replaces the old one.

### Events

Register with `vm.on(event, cb)` (returns an unsubscribe fn) or the shorthands:

| Shorthand | Event | Payload |
|-----------|-------|---------|
| `onConsole(cb)` | `console` | `Uint8Array` (guest console output) |
| `onState(cb)` | `state` | `VMState` string |
| `onNetTx(cb)` | `net-tx` | `Uint8Array` (frame the guest transmitted) |
| `onLog(cb)` | `log` | `{ level, text }` |
| `onError(cb)` | `error` | `Error` |
| `onAddress(cb)` | `address` | `string`: the guest's IPv4 address, when first seen or changed |
| — | `downloading` | `boolean` (asset-fetch indicator) |
| — | `export-file` | `{ name, file, url }` (guest wrote a file out; only with `exportFiles: true`) |

### Live volume hotplug

Inject or extract files from a mounted `files` (9p) volume **while the VM runs**
(the guest sees changes immediately — 9p is uncached). See
[Storage § Live hotplug](./storage.md#live-hotplug--injectextract-files-at-runtime).

```js
await vm.volumePutFile('data', '/incoming/x.json', bytesOrString);
const bytes   = await vm.volumeGetFile('data', '/var/log/app.log'); // Uint8Array|null
const entries = await vm.volumeList('data', '/incoming');           // [{name,dir,size}]
await vm.volumeMkdir('data', '/incoming/assets');
await vm.volumeDelete('data', '/incoming/old');                     // recursive
await vm.volumeFlush('data');
```

> Only volume **contents** hotplug this way. Adding/removing a **device** at
> runtime, and **USB passthrough** (WebUSB → guest), are not supported — the
> emulator has no PCI/ACPI hotplug and no USB host controller.

### Stats & introspection

```js
vm.getStats();  // { rxFrames, txFrames, rxBytes, txBytes, bootedAt, state, mac, mode }
vm.toJSON();    // id, state, mac, mode, config summary, stats, volume names
vm.state;       // current VMState
```

## Inline vs worker vs isolated

| | inline | worker (default) | isolated |
|--|--------|------------------|----------|
| Thread | current (UI) | dedicated Web Worker | dedicated Web Worker, in a sandboxed frame |
| Isolation | own `Module` via closure wrap | own `Module` **and** own thread | also an opaque origin under `connect-src 'none'`: no network, storage, cookies or page DOM |
| Best for | light/console VMs, pages that can't spawn workers, all-in-one-thread debugging | heavy guests — keeps the CPU loop off the UI thread | configs or guests you don't trust; several users' or projects' VMs on one page |
| `stop()` | best-effort (needs C `vm_stop` to fully halt) | clean (worker terminated) | clean (frame removed) |

All are driven by the same `EmulatorEngine`. Switching is just `mode` in the
config.

### Worker message protocol

`WorkerHost` ⇄ `vm-worker.js`:

```
main → worker : start{config} | stdin{data} | net-rx{frame}
                resize{cols,rows} | pause | resume | flush | stop
                vol-op{id,op,volName,args} | snapshot{id,options} | stats{id}
                fetch-reply{id,ok,status,statusText,body|error}
                store-reply{id,ok,result|error}
worker → main : booted | stdout{data} | net-tx{frame} | state{state}
                downloading{flag} | export-file{name,blob} | log{level,text}
                error{message} | exit | flushed | stopped
                vol-reply{id,ok,result|error} | stats-reply{id,ok,stats|error}
                snapshot-reply{id,ok,buffer,info|error}
                fetch{id,url,method}     (isolated mode)
                store{id,vol,op,args}    (page-owned storage)
```

Frames and snapshots are transferred (zero-copy) where possible; the manager
copies per-VM on fan-out so a broadcast to several workers is safe. Every
worker → main message is checked against a fixed table of fields, types and
sizes (`lib/vm/workerMessages.js`) and dropped if it doesn't fit; a reply must
answer a request the page made, of the same kind.

## The network & volume bridge

`VMManager.create` wires each VM automatically:

- guest `net-tx` → `VMBridgeDevice.acceptFromGuest` (MAC pinning, address
  checks; a refused frame is dropped) → `VirtualNetwork.deliverPacket` →
  switched/flooded to peers on the same network;
- frames the network delivers to that device → `vm.deliverFrame` → guest RX.

You normally don't touch this — just create VMs on one manager and they
interconnect (per network). Details in [networking](./networking.md).

## See also

- [Getting started](./getting-started.md)
- [WASM runtime & isolation](./wasm-runtime.md) — how many VMs share one bundle.
</content>
