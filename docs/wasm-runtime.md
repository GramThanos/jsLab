# WASM runtime & isolation

Source: `x86emu-wasm.js` + `.wasm` (the bundle, from TinyEMU's Pages: `lib/vm/engine.js`), TinyEMU's `wasm/lib.js` (the C↔JS
binding), and `lib/vm/EmulatorFactory.js` / `EmulatorEngine.js`.

This explains how **many** emulator instances run in one JS realm from **one**
Emscripten bundle, and the exact contract between the C code and JS.

## The singleton problem

The emulator is a singleton by design: the C side (`jsemu.c`) has one
`static VirtMachine *global_vm;`, and Emscripten emits one global `Module`.
Loaded naively as a `<script>`, you can only ever run one VM per page.

Two mechanisms solve this:

1. **Closure wrapping** (`EmulatorFactory`) — gives every instance its own
   isolated `Module` (and its own `global_vm` inside the wasm). No rebuild.
2. **One Web Worker per VM** (`WorkerHost`) — additionally isolates a busy VM's
   CPU loop from the UI thread. The worker uses the same factory internally.

## EmulatorFactory — isolation via closure wrapping

The shipped `x86emu-wasm.js` is a **pre-`MODULARIZE`** build: at top level it does
`var Module = typeof Module !== "undefined" ? Module : {}` and ends by calling
`run()`. `EmulatorFactory` fetches the bundle text once and wraps it:

```js
new Function('Module', sourceText + '\n;return Module;')
```

Each `create()` passes a **fresh `Module`** and gets back an isolated instance —
its own `Module`, `_malloc`, `HEAPU8`, asm exports, and `global_vm`. This is
manual `MODULARIZE`, on the main thread **and** inside a worker.

```js
import { EmulatorFactory } from './lib/vm/EmulatorFactory.js';

const factory = await EmulatorFactory.fromUrl('./lib/x86emu-wasm.js');  // fetched + cached once
const Module = factory.create({
  locateFile: (p) => p.endsWith('.wasm') ? './lib/x86emu-wasm.wasm' : p,
  api,                       // the Module.api object lib.js calls into (below)
  onReady: (M) => { /* safe to cwrap/ccall here */ },
  print, printErr,
});
```

> **CSP:** `new Function` (like `eval`) must be permitted by the page's Content
> Security Policy.

The source text is cached per URL and fetched with `cache:'no-cache'` (a cheap
conditional GET), so a rebuilt bundle is never masked by a stale HTTP cache.

## EmulatorEngine — driving one Module

`EmulatorEngine` is the single place that knows the JS↔C contract. It builds the
`Module.api` from a `sink` of callbacks and, on `onRuntimeInitialized`, `cwrap`s
the exports and calls `vm_start`. Both `InlineHost` and `vm-worker.js` use it, so
inline and worker modes behave identically.

The `sink` it consumes:

```
console(bytes)     guest console output           netTx(frame)   guest transmitted a frame
state(s)           'running'|'paused'|'stopped'   log(level,txt) print / diagnostics
booted()           runtime up, vm_start issued     exit()         engine stopped
downloading(flag)  asset-fetch indicator           exportFile(name,file,url)
```

Emission callbacks (`console`, `netTx`) are gated on `running`, so a stopped
inline VM (whose C run loop can't be halted from JS) goes quiet instead of
leaking console bytes and network frames.

## The Module.api contract (`lib.js`)

`lib.js` is compiled into the bundle with `--js-library`. Every host call routes
through a per-instance `Module.api` object — no module globals, no DOM
assumptions, worker-friendly:

| C import | Calls… | Wired to |
|----------|--------|----------|
| `console_write` / `console_get_size` | `Module.api.terminal.write` / `.getSize` | console |
| `net_recv_packet` | `Module.api.net.recvPacket` | guest → network (`net-tx`) |
| `fs_wget_update_downloading` | `Module.api.downloading.update` | download indicator |
| `emscripten_async_wget3_data` | `Module.api.wgetRequests` | HTTP fetches (kernel/rootfs) |
| `fs_export_file` | `Module.api.export_file` | file download from guest |
| `fb_refresh` | `Module.api.display` | framebuffer (graphics builds) |
| `file_buffer_*` | `Module.api.fbuf_table` | in-memory file buffers |

### Exported (cwrap'd) C functions

`EXPORTED_FUNCTIONS` in `../Makefile.js`:

```
_vm_start _console_queue_char _fs_import_file
_display_key_event _display_mouse_event _display_wheel_event
_net_write_packet _net_set_carrier _malloc _free
```

`EmulatorEngine` also probes for optional `_vm_pause` / `_vm_resume` / `_vm_stop`
and uses them if a future build exports them (🔴 — see `plan-c-changes.md`).

### `vm_start` ABI (7 args)

```
vm_start(url, ram_size, cmdline, pwd, width, height, has_network)
```

Two gotchas handled in the code:

- the config **`url` must be absolute** — a relative URL aborts inside the C
  loader (`VM.start` resolves it against `location.href`);
- `Module.api` and `Module.locateFile` (for the `.wasm`) must be set **before**
  the bundle runs; `onRuntimeInitialized` is the safe point to `cwrap`/`vm_start`.

## Rebuilding the WASM

Built from the repo's **current C sources** with Emscripten via `../Makefile.js`,
bound through TinyEMU's `wasm/lib.js`. Output: `dist/wasm/x86emu-wasm.js` + `.wasm`; point jsLab at that folder with
`new VMManager({ engine: '<its URL>/' })`. No local
emcc needed — run it in the emscripten container from the repo root:

```bash
docker run --rm -v "$PWD":/src -w /src emscripten/emsdk:3.1.74 make -f Makefile.js
```

The output is a classic (non-`MODULARIZE`) script **on purpose**, so
`EmulatorFactory` can closure-wrap it for isolation.

> After a rebuild during a live session, **hard-reload** (Ctrl/Cmd+Shift+R). The
> JS loader revalidates (`cache:'no-cache'`), but the browser may otherwise pair
> the fresh loader with a stale cached `.wasm` and fail to instantiate
> (import-module mismatch). Fresh visitors are unaffected.

## The simple single-VM path

`lib/linux.js` is a clean single-VM bootstrap (xterm + `Module.api`) that doesn't
use the factory/manager — useful as a minimal reference for the C↔JS contract.
For multiple VMs, isolation, and networking, use the [VM runtime](./vm.md).

## See also

- [VM runtime](./vm.md) — `EmulatorFactory`/`EmulatorEngine` in context.
- Top-level [`docs/runtime.md`](./runtime.md) §4 and `plan-c-changes.md`.
</content>
