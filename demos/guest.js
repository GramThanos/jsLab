// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * guest.js — drive a guest's root shell from the lab pages: wait for its
 * prompt, type a file into it, bring its network up.
 *
 * The distro images boot with init=/bin/sh: no init system, so nothing in the
 * guest configures eth0. GuestShell.netUp() does it from outside, with busybox
 * udhcpc where the image has it (Alpine) and else with netup.py (Debian's slim
 * image has no ip, ifconfig or DHCP client, but has python3).
 */

const NETUP_URL = new URL('netup.py', import.meta.url);

// A shell prompt at the end of the output: "~ # " or "# " or "$ ", and busybox
// ash's cursor-position query (ESC[6n) after it.
const PROMPT = /[#$] (\x1b\[6n)?$/;

export class GuestShell {
    /**
     * @param {VM} vm
     * @param {{ write(data: Uint8Array|string): void }} term  where console output goes
     */
    constructor(vm, term) {
        this.vm = vm;
        this.term = term;
        this.tail = '';             // the last of the console output, as text
        this._held = false;         // output withheld from the terminal (typeFile)
        this._waiters = new Set();
        this.netState = null;       // null | 'pending' | 'up' | 'failed'
        const dec = new TextDecoder();
        vm.onConsole((bytes) => {
            this.tail = (this.tail + dec.decode(bytes, { stream: true })).slice(-400);
            for (const w of [...this._waiters]) w();
            if (!this._held) term.write(bytes);
        });
    }

    /** Resolves true once test(tail) holds on new output, false after ms. */
    waitFor(test, ms) {
        return new Promise((resolve) => {
            const done = (ok) => { clearTimeout(timer); this._waiters.delete(check); resolve(ok); };
            const check = () => { if (test(this.tail)) done(true); };
            const timer = setTimeout(() => done(false), ms);
            this._waiters.add(check);
        });
    }

    /** Run a command line; resolves when the shell prompts again (or after ms). */
    run(line, ms = 60000) {
        this.tail = '';
        this.vm.sendInput(line + '\n');
        return this.waitFor((t) => PROMPT.test(t), ms);
    }

    /** The first prompt after boot. */
    whenReady(ms = 120000) {
        return PROMPT.test(this.tail) ? Promise.resolve(true) : this.waitFor((t) => PROMPT.test(t), ms);
    }

    /**
     * Write a file in the guest through its console (it has no internet to
     * fetch it), with the output held back so the file doesn't scroll by.
     * Waits for the marker AND the next prompt: busybox ash's prompt ends in a
     * cursor-position query, and xterm's answer must not arrive after the next
     * command starts, or that program reads it as typed text. Held back, the
     * query is never answered, which ash doesn't mind.
     */
    async typeFile(path, text, ms = 180000) {
        const marker = '__TYPED_OK';
        this.term.write(`\r\n\x1b[2m[typing ${path}…]\x1b[0m`);
        this._held = true;
        this.tail = '';
        // A quoted heredoc writes the file verbatim; printf builds the marker so
        // the echoed command line itself doesn't contain it.
        this.vm.sendInput(`cat > ${path} <<'JSLAB_EOF'\n${text.replace(/\n?$/, '\n')}JSLAB_EOF\nprintf '%s_OK\\n' __TYPED\n`);
        const ok = await this.waitFor((t) => {
            const i = t.indexOf(marker);
            return i >= 0 && PROMPT.test(t.slice(i));
        }, ms);
        this._held = false;
        this.term.write(ok ? ' \x1b[32mdone\x1b[0m\r\n' : '\r\n\x1b[31m[no confirmation from the guest]\x1b[0m\r\n');
        return ok;
    }

    /**
     * Bring eth0 up and get a DHCP lease from the JS router. Resolves true once
     * the VM has an address (vm.ip, which VMManager learns from the lease).
     */
    async netUp() {
        if (this.netState === 'pending') return false;
        this.netState = 'pending';
        const need = '__NEED_NETUP';
        this.tail = '';
        this.vm.sendInput("if command -v udhcpc >/dev/null; then ip link set eth0 up && udhcpc -i eth0 -q -n -t 5; "
            + "else printf '%s_NETUP\\n' __NEED; fi\n");
        await this.waitFor((t) => t.includes(need) || PROMPT.test(t), 60000);
        if (this.tail.includes(need) && !this.vm.ip) {
            const script = await fetch(NETUP_URL).then((r) => (r.ok ? r.text() : null)).catch(() => null);
            if (script && await this.typeFile('/root/netup.py', script)) await this.run('python3 /root/netup.py');
        }
        // the lease and vm.ip arrive together, but give the event a moment
        if (!this.vm.ip) await new Promise((r) => setTimeout(r, 500));
        this.netState = this.vm.ip ? 'up' : 'failed';
        return !!this.vm.ip;
    }
}
