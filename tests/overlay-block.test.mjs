// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * overlay-block.test.mjs — unit tests for the copy-on-write overlay block store.
 * Run: node tests/overlay-block.test.mjs
 *
 * Uses a mock HTTP base (deterministic per-sector pattern) and an in-memory
 * overlay backend, so the CoW merge logic is exercised without a browser.
 */

import { OverlayBlockStore } from '../lib/volumes/OverlayBlockStore.js';

let failures = 0;
function check(name, cond, extra = '') {
    if (cond) console.log(`  ok   ${name}`);
    else { console.error(`  FAIL ${name} ${extra}`); failures++; }
}

const SECTOR = 512;
// A base sector filled with a byte derived from its number, so any read can be
// verified against its source (base vs overlay).
function baseSector(s) { return new Uint8Array(SECTOR).fill(s & 0xff); }
function fillSector(v) { return new Uint8Array(SECTOR).fill(v); }
function sectorByte(u8, i) { return u8[i * SECTOR]; }  // all bytes in a sector are equal here

function makeBase(spy) {
    return async (sector, count) => {
        if (spy) spy.push([sector, count]);
        const out = new Uint8Array(count * SECTOR);
        for (let i = 0; i < count; i++) out.set(baseSector(sector + i), i * SECTOR);
        return out;
    };
}

class MemBlock {
    constructor() { this.sectors = new Map(); this.files = new Map(); this.name = 'ov'; }
    async readSectors(sector, count) {
        const out = new Uint8Array(count * SECTOR);
        for (let i = 0; i < count; i++) {
            const d = this.sectors.get(sector + i);
            if (d) out.set(d, i * SECTOR);
        }
        return out;
    }
    async writeSectors(sector, data) {
        const n = Math.floor(data.length / SECTOR);
        for (let i = 0; i < n; i++)
            this.sectors.set(sector + i, data.slice(i * SECTOR, (i + 1) * SECTOR));
    }
    async readFile(k) { return this.files.has(k) ? this.files.get(k) : null; }
    async writeFile(k, d) { this.files.set(k, new Uint8Array(d)); }
    async flush() {}
}

async function testReadThroughToBase() {
    console.log('reads fall through to base when clean');
    const spy = [];
    const s = new OverlayBlockStore({ sectorCount: 64, readBase: makeBase(spy), overlay: new MemBlock() });
    await s.open();
    const r = await s.readSectors(5, 3);
    check('sector 5 from base', sectorByte(r, 0) === 5);
    check('sector 6 from base', sectorByte(r, 1) === 6);
    check('sector 7 from base', sectorByte(r, 2) === 7);
    check('one base read for a clean run', spy.length === 1 && spy[0][0] === 5 && spy[0][1] === 3,
        `(spy=${JSON.stringify(spy)})`);
}

async function testWriteGoesToOverlay() {
    console.log('writes go to overlay; reads mix overlay + base');
    const spy = [];
    const ov = new MemBlock();
    const s = new OverlayBlockStore({ sectorCount: 64, readBase: makeBase(spy), overlay: ov });
    await s.open();

    await s.writeSectors(6, fillSector(0xAA));           // dirty sector 6 only
    const r = await s.readSectors(5, 3);
    check('sector 5 still base', sectorByte(r, 0) === 5);
    check('sector 6 from overlay', sectorByte(r, 1) === 0xAA);
    check('sector 7 still base', sectorByte(r, 2) === 7);
    check('overlay holds sector 6', ov.sectors.has(6) && !ov.sectors.has(5));

    // The mixed read should split into runs: base[5], overlay[6], base[7].
    const baseRuns = spy.map(x => x.join(':'));
    check('base fetched only clean runs', baseRuns.includes('5:1') && baseRuns.includes('7:1'),
        `(runs=${JSON.stringify(baseRuns)})`);
}

async function testMultiSectorRuns() {
    console.log('contiguous dirty run batched');
    const spy = [];
    const ov = new MemBlock();
    const s = new OverlayBlockStore({ sectorCount: 64, readBase: makeBase(spy), overlay: ov });
    await s.open();

    const three = new Uint8Array(3 * SECTOR);
    for (let i = 0; i < 3; i++) three.set(fillSector(0xB0 + i), i * SECTOR);
    await s.writeSectors(10, three);                     // dirty 10,11,12

    const r = await s.readSectors(9, 5);                 // base 9 | overlay 10-12 | base 13
    check('9 base', sectorByte(r, 0) === 9);
    check('10 overlay', sectorByte(r, 1) === 0xB0);
    check('11 overlay', sectorByte(r, 2) === 0xB1);
    check('12 overlay', sectorByte(r, 3) === 0xB2);
    check('13 base', sectorByte(r, 4) === 13);
}

async function testPersistence() {
    console.log('dirty bitmap persists across reopen');
    const ov = new MemBlock();
    const s1 = new OverlayBlockStore({ sectorCount: 64, readBase: makeBase(), overlay: ov });
    await s1.open();
    await s1.writeSectors(20, fillSector(0xCC));
    await s1.flush();
    check('bitmap saved to overlay files', ov.files.size === 1);

    // Reopen with the SAME overlay backend: sector 20 must be served from
    // overlay (dirty), sector 21 from base (clean).
    const spy = [];
    const s2 = new OverlayBlockStore({ sectorCount: 64, readBase: makeBase(spy), overlay: ov });
    await s2.open();
    const r = await s2.readSectors(20, 2);
    check('reloaded dirty sector from overlay', sectorByte(r, 0) === 0xCC);
    check('reloaded clean sector from base', sectorByte(r, 1) === 21);
    check('base not consulted for the dirty sector', spy.every(x => x[0] !== 20),
        `(spy=${JSON.stringify(spy)})`);
}

(async () => {
    await testReadThroughToBase();
    await testWriteGoesToOverlay();
    await testMultiSectorRuns();
    await testPersistence();
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})();
