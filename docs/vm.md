# VM runtime

Source: `lib/vm/` — exported via `lib/vm/index.js`.

Manages one or more TinyEMU instances, their lifecycle, console/network I/O, and
the bridge onto the shared virtual network and volumes.

## Classes at a glance

| Class | Role |
|-------|------|
| `VMManager` | Owns many VMs + one shared `VirtualNetwork` + a `VolumeManager`. Your main entry point. |
| `VM` | Main-thread **handle** for one instance: lifecycle, events, stats, I/O routing. |
| `InlineHost` | Runs a VM on the current thread (`mode: 'inline'`). |
| `WorkerHost` | Runs a VM in its own Web Worker (`mode: 'worker'`, default). |
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
| `await create(id, config)` | Create (don't start) a VM; provisions volumes and wires the net bridge. Returns the `VM`. |
| `get(id)` / `getAll()` | Look up handles. |
| `await start(id)` / `await stop(id)` | Start / stop by id. |
| `await destroy(id)` | Stop, unregister from the network, detach volumes, forget. |
| `await destroyAll()` | Destroy every VM. |
| `getStatus()` | Snapshot `{ vms, network, macTable }` for a dashboard. |

Every VM gets a deterministic MAC from its id (or pass `mac`), a `VMBridgeDevice`
on the shared `VirtualNetwork`, and — if you pass `volumes` — provisioned browser
storage. The bridge **learns the guest's real MAC** from outbound frames, so
unicast from other VMs finds it.

## VM config

Passed to `mgr.create(id, config)`:

| Field | Default | Notes |
|-------|---------|-------|
| `configUrl` | — | TinyEMU `.cfg` (kernel + fs0 + eth0). Resolved to **absolute** (a relative URL aborts in the C loader). |
| `mode` | `'worker'` | `'worker'` (off the UI thread, clean stop) or `'inline'` (many VMs, one thread, no worker needed). |
| `memoryMB` | `256` | Guest RAM. |
| `cmdline` | `''` | Extra kernel cmdline. |
| `hasNetwork` | — | `true` bridges the NIC to the `VirtualNetwork` and raises carrier. |
| `cols`, `rows` | `80×24` | Console size reported to the guest. |
| `width`, `height` | `0` | Framebuffer size (graphics builds). |
| `mac` | derived from id | `'02:..'` string or `Uint8Array`. |
| `volumes` | `[]` | Array of volume specs — see [storage](./storage.md). |

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
vm.sendInput('ls -la\n');       // string or Uint8Array → guest stdin
vm.resize(cols, rows);          // update reported console size
vm.deliverFrame(frame);         // inject a net frame INTO the guest (used by the bridge)
```

### Events

Register with `vm.on(event, cb)` (returns an unsubscribe fn) or the shorthands:

| Shorthand | Event | Payload |
|-----------|-------|---------|
| `onConsole(cb)` | `console` | `Uint8Array` (guest console output) |
| `onState(cb)` | `state` | `VMState` string |
| `onNetTx(cb)` | `net-tx` | `Uint8Array` (frame the guest transmitted) |
| `onLog(cb)` | `log` | `{ level, text }` |
| `onError(cb)` | `error` | `Error` |
| — | `downloading` | `boolean` (asset-fetch indicator) |
| — | `export-file` | `{ name, file, url }` (guest wrote a file out) |

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

## Inline vs worker

| | inline | worker (default) |
|--|--------|------------------|
| Thread | current (UI) | dedicated Web Worker |
| Isolation | own `Module` via closure wrap | own `Module` **and** own thread |
| Best for | light/console VMs, pages that can't spawn workers, all-in-one-thread debugging | heavy guests — keeps the CPU loop off the UI thread |
| `stop()` | best-effort (needs C `vm_stop` to fully halt) | clean (worker terminated) |

Both are driven by the same `EmulatorEngine`. Switching is just `mode` in the
config.

### Worker message protocol

`WorkerHost` ⇄ `vm-worker.js`:

```
main → worker : start{config} | stdin{data} | net-rx{frame}
                resize{cols,rows} | pause | resume | stop
worker → main : booted | stdout{data} | net-tx{frame} | state{state}
                downloading{flag} | export-file{name,blob} | log{level,text}
                error{message} | exit
```

Frames are transferred (zero-copy) where possible; the manager copies per-VM on
fan-out so a broadcast to several workers is safe.

## The network & volume bridge

`VMManager.create` wires each VM automatically:

- guest `net-tx` → `VMBridgeDevice.learnFromGuest` (MAC learning) →
  `VirtualNetwork.deliverPacket` → switched/flooded to peers;
- frames the network delivers to that device → `vm.deliverFrame` → guest RX.

You normally don't touch this — just create VMs on one manager and they
interconnect. Details in [networking](./networking.md).

## See also

- [Getting started](./getting-started.md)
- [WASM runtime & isolation](./wasm-runtime.md) — how many VMs share one bundle.
</content>
