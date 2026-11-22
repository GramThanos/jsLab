The TinyEMU can be compiled using emscripten, but the output vm's storage is not persistent across reboots.

The implementation should allow mapping and mounting filesystem locations at runtime in adition to the distro image. The vm handler should support:
- Docker like volumes mapping to paths inside the vm
- Volumes storage should be implemented using web technologies and support various types like:
  - File System API: mounting a local directory to a vm directory
  - IndexedDB: storing files and folder in the browser's db
  - Origin Private File System (OPFS): creating a virtual fs.to use
- Depending on the implementation, in this way the user will be able to exchange files with the vm and also have them persisten (if they are inside the volume) across reboot.
- Optional overlay mode, where the distro fs is used bormally but any change is recorded and stored allowing keeping changes across the full disk. This will also allow persistence between reboot.

