# Getting started

This walks you from an empty page to two interconnected VMs. The JS is plain ES
modules — no bundler or build step for the JS side.

## 1. Serve the folder over HTTP

ES modules and WASM require `http://` (a `file://` page will not work):

```bash
npm run fetch-engine          # the WASM engine, from TinyEMU's GitHub Pages
python3 -m http.server 8000   # from the jsLab root
# open http://localhost:8000/demos/demo.html
```

`demo.html` is the multi-VM lab: add and remove VMs (in workers or on the main
thread), each with an xterm.js console, its IP address, and buttons to bring its
network up and to install and start `lan-chat.py`, a peer-to-peer chat between
the VMs. `linux-distro.html` is the single-VM lab. Both are in `demos/` and use
Bootstrap 6, Bootstrap Icons and xterm.js from jsDelivr.

In the consoles, Ctrl+Shift+C (or Ctrl+C with text selected) copies,
Ctrl+Shift+V or Shift+Insert pastes, and a right-click copies the selection or
pastes. Ctrl+C with nothing selected goes to the guest.

> **Assets:** the WASM engine (`engine/x86emu-wasm.js` + `.wasm`) comes from
> `npm run fetch-engine`, but reaching a shell needs a kernel + rootfs image the
> `.cfg` points to. Stage a distro under `_distro/` with TinyEMU-distros'
> `scripts/stage-web.sh <name> <jsLab dir>` (see [runtime.md](./runtime.md) §8),
> or point the config at your own. A browser boot to `/bin/sh` takes ~20-25 s —
> that pre-shell window is not a hang.

## 2. Boot a single VM

```js
import { VMManager } from './lib/vm/index.js';

const mgr = new VMManager({ network: { subnet: '10.0.2.0/24' } });

const vm = await mgr.create('vm1', {
  configUrl: 'alpine-x86.cfg',   // TinyEMU .cfg (kernel + fs0 + eth0); resolved to absolute
  memoryMB: 256,
  mode: 'worker',                // 'worker' (default, off the UI thread) or 'inline'
  hasNetwork: true,
  cols: 80, rows: 24,
});

vm.onConsole(bytes => term.write(bytes));   // guest → screen (Uint8Array)
term.onData(data => vm.sendInput(data));     // keyboard → guest (string|Uint8Array)
vm.onState(s => console.log('state:', s));   // 'starting'|'running'|'stopped'|...

await vm.start();
```

`create()` is async so volumes can be provisioned; `start()` resolves once the
runtime is up and `vm_start` has been issued. See the [VM guide](./vm.md).

## 3. Connect two VMs (one tab)

VMs created by the same `VMManager` share one `VirtualNetwork` automatically —
they are on the same LAN with a JS DHCP server, ARP, and a gateway. Nothing extra
to wire:

```js
const a = await mgr.create('a', { configUrl: 'alpine-x86.cfg', hasNetwork: true });
const b = await mgr.create('b', { configUrl: 'alpine-x86.cfg', hasNetwork: true });
await a.start();
await b.start();
```

Guests booted with `init=/bin/sh` don't auto-configure the NIC, so bring it up
inside each guest to get a DHCP lease from the JS network:

```
udhcpc -i eth0
```

(The demo page has a **Net up** button that sends exactly this.) Once both have
leases, they can `ping` and talk to each other. See the
[Networking guide](./networking.md).

## 4. (Optional) Reach beyond the tab

Attach a transport to extend the LAN across tabs, to the internet, or to peers —
this is opt-in and unnecessary for the single-tab case:

```js
import { BroadcastChannelTransport } from './lib/network/transports/BroadcastChannelTransport.js';

const mgr = new VMManager({
  network: { subnet: '10.0.2.0/24' },
  transports: [ new BroadcastChannelTransport('tinyemu-lan') ],  // VMs in other tabs join this LAN
});
```

See [Networking § Transports](./networking.md#transports).

## 5. (Optional) Attach a persistent volume

A `files` volume is a JS-backed 9p filesystem that persists to OPFS/IndexedDB:

```js
const vm = await mgr.create('vm1', {
  configUrl: 'alpine-x86.cfg',
  volumes: [{ name: 'data', backend: 'opfs', type: 'files' }],
});
```

Point the `.cfg` at it (`fs1: { file: "js:data", tag: "data" }`) and mount it in
the guest:

```
mount -t 9p data /mnt/data -o trans=virtio,version=9p2000.L
```

Files under `/mnt/data` persist across reboots. Whole-disk `block` overlays are
still 🔴. See the [Storage guide](./storage.md).

## Quick network self-test (no browser)

The pure-JS network stack runs in Node:

```bash
node --input-type=module -e "
import { VirtualNetwork } from './lib/network/index.js';
const n = new VirtualNetwork(); const a = n.createVM('a'), b = n.createVM('b');
n.waitForDHCP(a).then(()=>n.waitForDHCP(b)).then(async()=>{
  console.log(await a.ping(b.getDHCPLease().ip, 3, 200)); process.exit(0); });"
```

Regression tests: `node tests/network-fixes.test.mjs`.

## Next steps

- [VM runtime](./vm.md) — lifecycle, modes, events, stats.
- [Networking](./networking.md) — the LAN, packets, and transports.
- [Storage](./storage.md) — volumes and backends.
- [WASM runtime](./wasm-runtime.md) — isolation and the C↔JS contract.
</content>
