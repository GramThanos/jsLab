// SPDX-License-Identifier: GPL-3.0-or-later
export { StorageBackend, SECTOR_SIZE } from './backends/StorageBackend.js';
export { IndexedDBBackend } from './backends/IndexedDBBackend.js';
export { OPFSBackend } from './backends/OPFSBackend.js';
export { FileSystemAccessBackend } from './backends/FileSystemAccessBackend.js';
export { VolumeManager, VolumeMount } from './VolumeManager.js';
