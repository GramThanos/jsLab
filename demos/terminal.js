// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * terminal.js — an xterm.js console for a guest, shared by the lab pages.
 *
 * Needs xterm.js, its fit addon and (optionally) its web-links addon loaded as
 * classic scripts first: they define the globals Terminal, FitAddon and
 * WebLinksAddon. The guest's bytes go straight to xterm (UTF-8, ANSI colours,
 * cursor movement); what the user types or pastes comes back through onData as
 * a string, for vm.sendInput().
 *
 * Copy and paste:
 *   Ctrl+Shift+C, or Ctrl+C with text selected   copy the selection
 *   Ctrl+Shift+V, Shift+Insert                     paste
 *   right-click                                    copy the selection, else paste
 * Ctrl+C with nothing selected still sends ^C to the guest, as in any terminal.
 */

// One dark palette for every lab console: Bootstrap's dark surface behind it.
const THEME = {
    background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3', cursorAccent: '#0d1117',
    selectionBackground: '#3b5070',
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
    brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
};

/**
 * @param {HTMLElement} el      where the terminal goes (it fills it)
 * @param {object} [opts]
 * @param {(data: string) => void} [opts.onData]  keys and pastes, for the guest
 * @param {number} [opts.cols]  fixed size; omit both to fit the element
 * @param {number} [opts.rows]
 * @param {number} [opts.fontSize]
 * @returns {{ term: Terminal, write(data: Uint8Array|string): void, fit(): {cols:number, rows:number},
 *            copy(): Promise<boolean>, paste(): Promise<void>, focus(): void, dispose(): void }}
 */
export function createTerminal(el, opts = {}) {
    const term = new globalThis.Terminal({
        cols: opts.cols || 80,
        rows: opts.rows || 24,
        fontSize: opts.fontSize || 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        cursorBlink: true,
        scrollback: 5000,
        theme: THEME,
        allowProposedApi: false,
    });
    const fitAddon = new globalThis.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    if (globalThis.WebLinksAddon) term.loadAddon(new globalThis.WebLinksAddon.WebLinksAddon());
    term.open(el);

    const fit = () => {
        try { fitAddon.fit(); } catch { /* not laid out yet */ }
        return { cols: term.cols, rows: term.rows };
    };
    if (!opts.cols && !opts.rows) fit();

    const copy = async () => {
        if (!term.hasSelection()) return false;
        try { await navigator.clipboard.writeText(term.getSelection()); } catch { return false; }
        term.clearSelection();
        return true;
    };
    // term.paste() fires onData with the text, bracketed if the guest asked for it.
    const paste = async () => {
        try { const text = await navigator.clipboard.readText(); if (text) term.paste(text); }
        catch { /* clipboard read refused */ }
        term.focus();
    };

    term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        const key = e.key.toLowerCase();
        if (e.ctrlKey && e.shiftKey && key === 'c') { e.preventDefault(); copy(); return false; }
        if (e.ctrlKey && !e.shiftKey && key === 'c' && term.hasSelection()) { e.preventDefault(); copy(); return false; }
        if ((e.ctrlKey && e.shiftKey && key === 'v') || (e.shiftKey && key === 'insert')) {
            e.preventDefault(); paste(); return false;
        }
        return true;
    });
    el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (term.hasSelection()) copy(); else paste();
    });

    if (opts.onData) term.onData(opts.onData);

    return {
        term,
        write: (data) => term.write(data),
        fit,
        copy,
        paste,
        focus: () => term.focus(),
        dispose: () => term.dispose(),
    };
}
