# Storage / volumes

Source: `lib/volumes/` — exported via `lib/volumes/index.js`.

Docker-like persistent storage for VMs, backed by browser storage APIs.

- **`files` volumes (9p) — ✅ working end-to-end.** A named volume is a JS-backed
  9p filesystem the guest can mount; reads/writes hit IndexedDB/OPFS/a local
  folder and persist across reboots. See [File volumes](#file-volumes-9p--working).
- **`block` volumes (persistent disk) — 🟡** both a fresh JS-backed virtio-block
  disk and a copy-on-write *overlay* over an HTTP base image are implemented and
  unit-tested; in-browser verification against a booted guest is pending. See
  [Block volumes](#block-volumes--fresh-disk--overlay-implemented).
- **JS storage backends — ✅** the persistence layer both build on.

## Concepts

A **volume spec** describes one volume for one VM:

```js
{
  name:       'data',                 // unique per VM
  backend:    'opfs',                 // 'indexeddb' | 'opfs' | 'fsaccess'
  type:       'files',                // 'files' (9p mount) | 'block' (overlay disk)
  mountpoint: '/mnt/data',            // guest path (files) — applied at boot by the C bridge
  sizeMB:     256,                    // block images only
  baseUrl:    'distro/rootfs.img',    // overlay base image (block, optional)
  dirHandle:  <FileSystemDirectoryHandle>,  // fsaccess: optional pre-granted handle
  storageKey: 'myapp/data',           // optional storage namespace (defaults to name)
}
```

- **`files`** → a Docker-like volume mapped to a guest path (virtio-9p).
- **`block`** → a whole-disk overlay image (virtio-block); copy-on-write over an
  optional HTTP base.

## VolumeManager

```js
import { VolumeManager } from './lib/volumes/index.js';

const vols = new VolumeManager();
const mounts = await vols.attach('vm1', [
  { name: 'data', backend: 'opfs', mountpoint: '/mnt/data' },
]);
// ... use mounts[i].backend directly for JS-side I/O ...
await vols.detach('vm1');   // flush + close all of a VM's backends
```

| Method | Description |
|--------|-------------|
| `await attach(vmId, specs)` | Build + open a backend per spec; returns `VolumeMount[]`. |
| `get(vmId)` | Current mounts for a VM. |
| `await detach(vmId)` | Flush and close every backend, then forget. |
| `getStatus()` | `{ vmId: [{ name, type, mountpoint, backend, persistent }] }`. |

Via the manager, pass `volumes: [...]` to `mgr.create(id, { volumes })` and
`VMManager` calls `attach` for you; the mount metadata is what the future C
bridge consumes.

A `VolumeMount` exposes `{ vmId, name, type, mountpoint, baseUrl, backend }` and
`toJSON()`.

## Backends

`lib/volumes/backends/` — all extend `StorageBackend` (one async interface, two
access styles; a backend implements whichever it supports).

| Backend | `block` | `files` | Persistent | Notes |
|---------|:------:|:------:|:----------:|-------|
| `IndexedDBBackend` (`indexeddb`/`idb`) | ✅ | ✅ | ✅ | Browser DB. No permissions, works everywhere. |
| `OPFSBackend` (`opfs`) | ✅ *(when `type:'block'`)* | ✅ | ✅ | Origin Private File System; fast, sandboxed. |
| `FileSystemAccessBackend` (`fsaccess`/`filesystem`) | ❌ | ✅ | ✅ | 🟡 Mounts a **real local directory** the user picks (`showDirectoryPicker`). Needs a user gesture + permission; Chromium-only. |

### StorageBackend interface

```
open() / close() / flush()
supports(cap)                         // 'block' | 'files'

// block (overlay / whole-disk, virtio-block):
getSectorCount()                      -> number of `sectorSize` (512) sectors
readSectors(sector, count)            -> Uint8Array
writeSectors(sector, data)

// files (docker-like volume, virtio-9p):
readFile(path)   -> Uint8Array | null
writeFile(path, data)
unlink(path)
list(path)       -> [{ name, dir, size }]
stat(path)       -> { size, dir, mtime } | null
```

All methods are async. `flush()` persists buffered writes; `close()` releases
handles. `capabilities = { block, files, persistent }` lets callers pick a
suitable backend.

## File volumes (9p) — ✅ working

A `files` volume is a JS-backed 9p filesystem. The engine creates it inside the
VM's realm (the worker, in worker mode), loads it from the backend **before
boot**, serves the guest's 9p ops synchronously from an in-memory tree, and
flushes back to the backend (autosave every ~3 s, on `stop`, and via
`vm.flush()`).

**1. Declare the volume** (the engine owns it — don't also open it via
`VolumeManager`):

```js
const vm = await mgr.create('vm1', {
  configUrl: 'alpine-x86.cfg',
  volumes: [{ name: 'data', backend: 'opfs', type: 'files' }],
});
await vm.start();
```

**2. Point the TinyEMU `.cfg` at it** with the `js:` scheme and a mount tag:

```
fs1: { file: "js:data", tag: "data" }
```

(The name after `js:` matches the volume `name`; `fs0` typically remains the
root filesystem.)

**3. Mount it in the guest:**

```
mkdir -p /mnt/data
mount -t 9p data /mnt/data -o trans=virtio,version=9p2000.L
```

Files written under `/mnt/data` persist to the chosen backend across reboots.
Call `await vm.flush()` before a deliberate teardown if you can't rely on the
autosave/stop flush (worker `stop` awaits a final flush automatically).

**Scope & limits.** The whole volume lives in memory during a session (loaded at
boot, flushed as one image), so it suits config/state/data dirs and file
exchange — not multi-GB disks. Ownership (uid/gid), hard links, symlinks, and
device nodes are not modelled (those ops return "not supported"). For
whole-disk persistence, use a block overlay (below) once available.

Store logic is unit-tested: `node tests/fs9p-store.test.mjs`.

### Live hotplug — inject/extract files at runtime ✅

Because a `files` volume is a JS tree the guest reads over 9p (uncached), the
host can add, replace, and remove files **while the VM runs** and the guest sees
them immediately — a `docker cp`-style channel in both directions. Mount an
(initially empty) volume at boot, then from JS:

```js
// host → guest
await vm.volumePutFile('data', '/incoming/config.json', JSON.stringify(cfg));
await vm.volumeMkdir('data', '/incoming/assets');
// guest → host
const bytes = await vm.volumeGetFile('data', '/var/log/app.log');  // Uint8Array | null
const entries = await vm.volumeList('data', '/incoming');          // [{name,dir,size}]
await vm.volumeDelete('data', '/incoming/old');                    // recursive
await vm.volumeFlush('data');                                      // force-persist now
```

These run on the same event loop as the guest's 9p calls (no concurrency
hazard) and route to the volume's store in the VM's realm (worker or inline).
`volumePutFile` accepts a `Uint8Array` or a string and creates parent dirs.

> This is *content* hotplug over a volume mounted at boot. Adding or removing a
> **device** at runtime (a new virtio disk appearing in the guest) is **not**
> supported — x86 uses virtio-PCI and the emulator has no PCI/ACPI hotplug, so
> the guest only enumerates devices at boot. Pre-mount the volumes you'll want,
> then hotplug their contents.

## Block volumes — 🟡 fresh disk + overlay implemented

A `block` volume is a JS-backed virtio-block disk whose sectors persist to
IndexedDB/OPFS. Like `files` volumes, the engine opens the backend in the VM's
realm before boot; block I/O stays asynchronous (the C device returns "pending"
and JS completes it when the backend promise resolves). Both variants below are
implemented and unit-tested; in-browser verification is pending.

**Fresh persistent disk — ✅ builds/links (in-browser check pending):**

```js
const vm = await mgr.create('vm1', {
  configUrl: 'alpine-x86.cfg',
  volumes: [{ name: 'disk', backend: 'indexeddb', type: 'block', sizeMB: 256 }],
});
```

Cfg: `drive0: { file: "js:disk" }` (or `drive1` alongside the HTTP rootfs —
multiple drives are supported). First use in the guest:

```
mkfs.ext4 /dev/vdb          # whichever /dev/vdX this drive is
mount /dev/vdb /mnt/disk
```

Sectors written persist across reboots (autosave every ~3 s + flush on stop).

**Copy-on-write overlay over an HTTP base — ✅ implemented (in-browser check
pending):** boot the normal distro image but keep every write. Reads fall
through to the HTTP base on an overlay miss; writes go only to the overlay.

```js
const vm = await mgr.create('vm1', {
  configUrl: 'alpine-x86.cfg',
  volumes: [{ name: 'root', backend: 'indexeddb', type: 'block',
              baseUrl: 'https://example.org/alpine/root.bin' }],   // TinyEMU split-image descriptor
});
```

Cfg: `drive0: { file: "js:root" }`. On first boot reads come from the HTTP base
(`blk%09u.bin` block files beside the descriptor); every write lands in the
overlay and is remembered by a per-sector dirty bitmap that persists in the
backend, so subsequent boots see your changes. Implemented entirely in JS
([OverlayBlockStore.js](../lib/volumes/OverlayBlockStore.js)) — the C device
(`block_js.c`) and `js_block_*` bindings are reused unchanged. Covered by
`node tests/overlay-block.test.mjs`.

## Page-owned storage

By default a VM's worker opens its volumes' backends itself, from the specs it
is given. That puts the choice of storage in the worker: one that ran other
code could open any IndexedDB database or OPFS file of the origin, every other
project's volumes included. With `storage: 'page'` in the VM config (always so in
[isolated mode](./runtime.md#isolated-mode)) the page owns the storage instead:

```js
const vm = await mgr.create('vm1', {
  configUrl, storage: 'page',
  volumes: [{ name: 'data', backend: 'indexeddb', storageKey: 'project-1/data', mountpoint: '/mnt/data' }],
});
```

- The page opens each volume's backend from **its** copy of the spec
  ([PageStorage.js](../lib/volumes/PageStorage.js)). The worker is told only
  `{ name, type, backend: 'page', mountpoint }`: no backend, no storage key.
- In the worker, each volume's backend is a `PortBackend`: every call
  (`readFile`, `writeFile`, `readSectors`, …) goes to the page as
  `store { id, vol, op, args }` and waits for the reply.
- The page serves a request only for a volume it configured, and only an op
  and arguments on a fixed list (`STORE_OPS` in `lib/vm/workerMessages.js`);
  keys and contents are opaque to it. It never parses the filesystem's records:
  the 9p tree (`Fs9pStore`) is still built and read in the worker.
- Data crosses the port as transferred buffers, so there is no extra copy.

Nothing else changes: the guest's I/O, the hotplug calls and the on-disk layout
are the same, so a volume can move between the two modes.

## See also

- [VM runtime](./vm.md) — passing `volumes` to `create()`.
- Top-level [`docs/runtime.md`](./runtime.md) §6 and `plan-vm-volumes.md`.
</content>
