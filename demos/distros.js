// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * distros.js — the guest images a lab can boot: the distros TinyEMU-distros
 * publishes on its Pages. Every architecture is listed: the engine carries both
 * the PC (x86) and the RISC-V (riscv32 / riscv64) machines and boots whichever
 * the distro's config names in `machine:`. The manifest lists configs relative
 * to itself; every entry comes back with an absolute config URL.
 */

export const PUBLISHED = 'https://gramthanos.github.io/TinyEMU-distros/manifest.json';

/**
 * @returns {Promise<Array<{ name: string, arch: string, description: string, url: string }>>}
 *          rejects if the list does not load
 */
export async function loadDistros() {
    const r = await fetch(PUBLISHED, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${PUBLISHED}: HTTP ${r.status}`);
    const list = (await r.json()).distros || [];
    return list.map((d) => ({
        name: d.name,
        arch: d.arch,
        description: d.description || '',
        url: d.url || new URL(d.config, PUBLISHED).href,
    }));
}
