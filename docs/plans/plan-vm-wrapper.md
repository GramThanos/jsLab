The TinyEMU can be compiled using emscripten, but the output code assumes that only 1 instant of the wasm runtime is running.
We should change that my wrapping the emulator in a VM class that will allow:

- Instantiating multiple vm instances running in parallel on the same page
- Handle the interconnection of the vm with the external word
- Manage the various consoles and their connection to consolas
- Handle init and distro to load/boot
- Handle vm init and params (e.g. custom mac addresses)
- Handle vm stages (start, stop, pause)
- Handle containers like volumes mapping (check plan-vm-volumes)
- Handle networking (using the network related libs)
- Allow deployment of the vm on a webworker and handle message exchange
- Manage status indicators and vm runtime attributes
