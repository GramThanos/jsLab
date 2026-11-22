# jsLab — Documentation

jsLab runs one or more TinyEMU emulator instances (compiled to
WebAssembly) inside a browser, wires them to a virtual network, and gives them
persistent, Docker-like volumes — all client-side, no backend required.

## Start here

- **[Getting started](./getting-started.md)** — serve the page, boot a VM, wire
  a console, connect two VMs. Read this first.

## Component guides

| Guide | Covers | Source |
|-------|--------|--------|
| [VM runtime](./vm.md) | Creating/starting/stopping VMs, `VMManager`, `VM` handles, inline vs worker modes, events & stats | `lib/vm/` |
| [Networking](./networking.md) | The in-tab virtual LAN (switch, DHCP, ARP, ICMP), packet classes, and **transports** for reaching other tabs / the internet / peers | `lib/network/` |
| [Storage / volumes](./storage.md) | Browser-backed persistent volumes and overlay disks, the backends, and their current guest-side status | `lib/volumes/` |
| [WASM runtime & isolation](./wasm-runtime.md) | How one Emscripten bundle runs many isolated VMs (`EmulatorFactory`), the `Module.api` C↔JS contract (`lib.js`), and rebuilding the `.wasm` | `engine/x86emu-wasm.*`, TinyEMU's `wasm/lib.js`, `lib/vm/Emulator*.js` |

## How the pieces fit

```
VMManager ── owns ──▶ VirtualNetwork  (JS L2/L3 switch: DHCP, ARP, ICMP)
    │                      │
    │                      └── transports ▶ other tabs / internet / peers  (optional)
    │
    ├── VM #1 (handle) ─▶ host (inline | worker) ─▶ WASM Module  (isolated)
    ├── VM #2 (handle) ─▶ ...
    │
    └── VolumeManager ─▶ OPFS / IndexedDB / File System Access
```

- **One page, many VMs.** Each VM is an isolated Emscripten `Module` (see
  [WASM runtime](./wasm-runtime.md)); they interconnect over one shared
  `VirtualNetwork` with zero extra setup.
- **Optional reach beyond the tab.** Attach a transport to extend the LAN across
  browser tabs, to the internet via a relay, or (future) peer-to-peer — see
  [Networking § Transports](./networking.md#transports).

## Status legend

✅ done & tested · 🟡 implemented, needs guest assets or C-side work to fully
exercise · 🔴 planned / needs C-side work.

| Area | Status |
|------|--------|
| VM wrapper/manager (inline + worker, lifecycle, console, net bridge) | ✅ |
| Virtual network (DHCP/ARP/ICMP, inter-VM within a tab) | ✅ |
| Transports (cross-tab BroadcastChannel, WebSocket relay) | ✅ |
| Volumes: JS storage backends | ✅ |
| Volumes: `files` guest mount (JS-backed 9p) | ✅ builds + unit-tested (in-browser mount pending) |
| Volumes: `block` fresh disk (JS-backed virtio-block) | ✅ builds/links (in-browser check pending) |
| Volumes: `block` copy-on-write overlay (HTTP base) | ✅ JS + unit-tested (in-browser check pending) |
| `vm_pause` / `vm_resume` / `vm_stop` | ✅ C export done (interactive check pending) |

See [`runtime.md`](./runtime.md) for the roadmap and build/rebuild
instructions, and `docs/plans/plan-*.md` for the original designs.
</content>
