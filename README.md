# jsLab

Virtual machines and networks in the browser, on the
[TinyEMU](https://github.com/gramthanos/TinyEMU) WebAssembly engine. Several
isolated Linux VMs (x86 or RISC-V) run in one page or in workers, share a
virtual LAN with a router and DHCP, keep persistent volumes, and can be saved
and resumed. Nothing runs on a server.

## Layout

| Path | What |
|---|---|
| `lib/vm/` | `VMManager`, `VM`, the engine wrapper (`EmulatorFactory`, `EmulatorEngine`), inline, worker and isolated (sandboxed-frame) hosts, the checks on what a worker sends ([trust boundary](docs/runtime.md#9-trust-boundary-and-isolation)), snapshots (`SnapshotStore`) |
| `lib/volumes/` | `VolumeManager`, 9P file volumes (`Fs9pStore`), copy-on-write block disks (`OverlayBlockStore`), storage backends (IndexedDB, OPFS, File System Access) |
| `lib/network/` | the virtual network: devices, packets (Ethernet, IP, ARP, DHCP, UDP, ICMP), transports (BroadcastChannel, WebSocket relay) |
| `lib/linux.js` | a simple single-VM bootstrap (xterm.js + the engine) |
| `demos/` | the labs: `demo.html` (multi-VM), `linux-distro.html` (single VM); `terminal.js` (their xterm.js console), `distros.js` (the distro list), `lan-chat.py` (a peer-to-peer chat the multi-VM lab installs in its guests) |
| `docs/` | [documentation](docs/README.md); `docs/runtime.md` is the architecture overview |

The modules are plain ES modules with no dependencies and no build step. Import
them directly:

```js
import { VMManager } from './lib/vm/index.js';

const vms = new VMManager({ network: { subnet: '10.0.2.0/24' } });
const vm = await vms.create('vm1', { configUrl: 'https://example.org/alpine-x86/config.cfg', memoryMB: 128 });
vm.on('console', (bytes) => { /* to a terminal */ });
vm.start();
```

jsLab ships no engine. By default it loads the TinyEMU WebAssembly engine
release it pins (`ENGINE_VERSION` in `lib/vm/engine.js`, currently
`v2026-11-22`) from [TinyEMU's GitHub Pages](https://gramthanos.github.io/TinyEMU/).
One engine runs both x86 and RISC-V guests. To use another, pass `engine`: a
release name, `'latest'`, or the URL or path of a folder holding
`x86emu-wasm.js` + `x86emu-wasm.wasm` (your own build, a mirror):

```js
new VMManager({ engine: 'latest' });
new VMManager({ engine: '/vendor/tinyemu/' });   // ./x86emu-wasm.js + .wasm in there
```

`urls: { wasmJsUrl, wasmBinUrl }` sets the two files' URLs one by one.

## Running the demos

```bash
npm run serve               # http://localhost:8000/demos/demo.html
```

The demos load the pinned engine. Add `?engine=` to a demo's URL to choose
another: `latest`, a release such as `?engine=v2026-11-22`, or a folder such as
`?engine=/my-build/` (a TinyEMU build served from the same server). The status
line names the engine in use.

A VM needs a guest image. The demos list the x86 and RISC-V distros that
[TinyEMU-distros](https://github.com/gramthanos/TinyEMU-distros) publishes on
its [Pages](https://gramthanos.github.io/TinyEMU-distros/); the multi-VM lab
also takes the URL of any TinyEMU config.

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

GPL-3.0-or-later, see [LICENSE](LICENSE). The TinyEMU engine it loads is
MIT.
