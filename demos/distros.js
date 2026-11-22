// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * distros.js — the guest images a lab can boot.
 *
 * _distro/manifest.json when distros are staged next to jsLab (TinyEMU-distros'
 * scripts/stage-web.sh writes it), else the distros TinyEMU-distros publishes on
 * its Pages: x86 only there, since jsLab's engine is the x86 one. A local
 * manifest lists configs relative to jsLab's root, a published one relative to
 * itself; every entry comes back with an absolute config URL.
 */

export const PUBLISHED = 'https://gramthanos.github.io/TinyEMU-distros/manifest.json';

async function fetchManifest(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return (await r.json()).distros || [];
}

/**
 * @param {string|URL} root  jsLab's root URL (where _distro/ would be)
 * @returns {Promise<{ source: 'local'|'published', distros: Array<{ name: string,
 *          arch: string, description: string, url: string }> }>}  rejects if neither list loads
 */
export async function loadDistros(root) {
    let list, base, source;
    try {
        list = await fetchManifest(new URL('_distro/manifest.json', root));
        base = new URL(root); source = 'local';
    } catch {
        list = (await fetchManifest(PUBLISHED)).filter((d) => d.arch === 'x86');
        base = new URL(PUBLISHED); source = 'published';
    }
    const distros = list.map((d) => ({
        name: d.name,
        arch: d.arch,
        description: d.description || '',
        url: d.url || new URL(d.config, base).href,
    }));
    return { source, distros };
}
