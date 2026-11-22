# jsLab

Virtual machines and networks in the browser, on the
[TinyEMU](https://github.com/gramthanos/TinyEMU) WebAssembly engine. Several
isolated Linux VMs (x86 or RISC-V) run in one page or in workers, share a
virtual LAN with a router and DHCP, keep persistent volumes, and can be saved
and resumed. Nothing runs on a server.

## Layout

| Path | What |
|---|---|
| `lib/vm/` | `VMManager`, `VM`, the engine wrapper (`EmulatorFactory`, `EmulatorEngine`), inline and worker hosts, snapshots (`SnapshotStore`) |
| `lib/volumes/` | `VolumeManager`, 9P file volumes (`Fs9pStore`), copy-on-write block disks (`OverlayBlockStore`), storage backends (IndexedDB, OPFS, File System Access) |
| `lib/network/` | the virtual network: devices, packets (Ethernet, IP, ARP, DHCP, UDP, ICMP), transports (BroadcastChannel, WebSocket relay) |
| `lib/linux.js` | a simple single-VM bootstrap (xterm.js + the engine) |
| `demos/` | `demo.html` (multi-VM), `linux-distro.html` (single VM), `jslinux.html` (legacy UI) |
| `docs/` | [documentation](docs/README.md); `docs/runtime.md` is the architecture overview |
| `engine/` | the TinyEMU engine, downloaded by `npm run fetch-engine` (not committed) |
| `_distro/` | guest images staged by TinyEMU-distros (not committed) |

The modules are plain ES modules with no dependencies and no build step. Import
them directly:

```js
import { VMManager } from './lib/vm/index.js';

const vms = new VMManager({ network: { subnet: '10.0.2.0/24' } });
const vm = await vms.create('vm1', { configUrl: 'https://example.org/alpine-x86/config.cfg', memoryMB: 128 });
vm.on('console', (bytes) => { /* to a terminal */ });
vm.start();
```

By default the engine is loaded from `engine/`. To use TinyEMU's published
build instead, pass its URLs (pin a version):

```js
new VMManager({ urls: {
    wasmJsUrl:  'https://gramthanos.github.io/TinyEMU/engine/<version>/x86emu-wasm.js',
    wasmBinUrl: 'https://gramthanos.github.io/TinyEMU/engine/<version>/x86emu-wasm.wasm',
} });
```

## Running the demos

```bash
npm run fetch-engine        # latest engine from TinyEMU's GitHub Pages (checksummed)
npm run serve               # http://localhost:8000/demos/demo.html
```

`node scripts/fetch-engine.mjs <version>` pins a release, and `--from
<TinyEMU>/dist/wasm` copies a local engine build instead.

A VM needs a guest image. Build one with
[TinyEMU-distros](https://github.com/gramthanos/TinyEMU-distros) and stage it
here with that repository's `scripts/stage-web.sh <name> <path to jsLab>`; the
demos list the staged images.

## Tests

```bash
npm test
```

They run under Node 22 or later (the virtual network, the 9P store and the
copy-on-write block store); CI runs them on every push.

## Related projects

- [TinyEMU](https://github.com/gramthanos/TinyEMU) — the emulator and its
  WebAssembly engine (MIT).
- [TinyEMU-distros](https://github.com/gramthanos/TinyEMU-distros) — guest image
  recipes (MIT).
- [tinyemu-agent](https://github.com/gramthanos/tinyemu-agent) — a browser AI
  agent built on jsLab (GPL-3.0-or-later).

## Licence

GPL-3.0-or-later, see [LICENSE](LICENSE). The TinyEMU engine that `engine/`
holds is MIT.
