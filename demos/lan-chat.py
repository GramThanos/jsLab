#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""lan-chat: peer-to-peer chat for the VMs on one virtual LAN.

No server: every peer broadcasts its messages over UDP to the whole subnet and
announces itself every few seconds, so peers find each other on their own.
Private messages (/msg) go straight to the peer's address.

    python3 lan-chat.py [--nick NAME] [--port 50505] [--broadcast ADDR]

The VM needs an address first (the lab's network button, or: udhcpc -i eth0).
Commands: /who  /msg NICK TEXT  /me ACTION  /nick NAME  /help  /quit
"""

import argparse
import json
import os
import random
import socket
import sys
import threading
import time

try:
    import readline  # line editing, and lets incoming messages redraw the prompt
except ImportError:
    readline = None

HELLO_EVERY = 5      # seconds between presence announcements
PEER_TIMEOUT = 16    # seconds of silence before a peer counts as gone
COLOURS = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96]
PROMPT = '> '


def colour(nick, text=None):
    code = COLOURS[sum(map(ord, nick)) % len(COLOURS)]
    return f'\x1b[1;{code}m{text if text is not None else nick}\x1b[0m'


def dim(text):
    return f'\x1b[2m{text}\x1b[0m'


def local_ip():
    """The address the default route leaves from (no packet is sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 9))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


class Chat:
    def __init__(self, nick, port, broadcast):
        self.id = '%08x' % random.getrandbits(32)
        self.nick = nick
        self.port = port
        self.broadcast = broadcast
        self.peers = {}               # id -> {'nick', 'ip', 'seen'}
        self.lock = threading.Lock()
        self.running = True
        self.reading = False          # the main thread is waiting in input()

        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        self.sock.bind(('', port))

    # -- output ------------------------------------------------------------
    def show(self, line):
        """Print above the prompt without losing what the user is typing."""
        with self.lock:
            if self.reading:
                typed = readline.get_line_buffer() if readline else ''
                sys.stdout.write('\r\x1b[K' + line + '\n' + PROMPT + typed)
            else:
                sys.stdout.write(line + '\n')
            sys.stdout.flush()

    # -- network -----------------------------------------------------------
    def send(self, kind, addr=None, **fields):
        packet = json.dumps({'v': 1, 'type': kind, 'id': self.id, 'nick': self.nick, **fields})
        try:
            self.sock.sendto(packet.encode(), (addr or self.broadcast, self.port))
            return True
        except OSError as e:
            self.show(colour('!', f'! send failed: {e.strerror}. Does this VM have an address? (udhcpc -i eth0)'))
            return False

    def receive(self):
        while self.running:
            try:
                data, (ip, _) = self.sock.recvfrom(65535)
                msg = json.loads(data.decode())
            except (OSError, ValueError):
                continue
            if not isinstance(msg, dict) or msg.get('id') == self.id:
                continue                  # our own broadcast, looped back
            self.handle(msg, ip)

    def handle(self, msg, ip):
        pid, nick, kind = msg.get('id'), str(msg.get('nick', '?'))[:32], msg.get('type')
        known = self.peers.get(pid)
        self.peers[pid] = {'nick': nick, 'ip': ip, 'seen': time.time()}
        if kind == 'leave':
            del self.peers[pid]
            self.show(dim(f'* {nick} ({ip}) left'))
            return
        if not known:
            self.show(dim(f'* {nick} ({ip}) joined'))
            if kind == 'join':            # answer, so the newcomer sees us at once
                self.send('hello', addr=ip)
        elif known['nick'] != nick:
            self.show(dim(f'* {known["nick"]} is now {nick}'))
        text = str(msg.get('text', ''))
        if kind == 'msg':
            self.show(f'{colour(nick)}: {text}')
        elif kind == 'me':
            self.show(f'* {colour(nick)} {text}')
        elif kind == 'pm':
            self.show(f'{colour(nick)} {dim("(private)")}: {text}')

    def heartbeat(self):
        while self.running:
            self.send('hello')
            now = time.time()
            for pid, p in list(self.peers.items()):
                if now - p['seen'] > PEER_TIMEOUT:
                    del self.peers[pid]
                    self.show(dim(f'* {p["nick"]} ({p["ip"]}) timed out'))
            time.sleep(HELLO_EVERY)

    # -- commands ----------------------------------------------------------
    def command(self, line):
        cmd, _, rest = line.partition(' ')
        rest = rest.strip()
        if cmd in ('/quit', '/exit'):
            return False
        if cmd == '/who':
            peers = sorted(self.peers.values(), key=lambda p: p['nick'])
            self.show(f'{len(peers)} peer(s) online' + ''.join(
                f'\n  {colour(p["nick"])}  {p["ip"]}' for p in peers))
        elif cmd == '/nick' and rest:
            old, self.nick = self.nick, rest[:32]
            self.send('hello')
            self.show(dim(f'* you are now {colour(self.nick)} (were {old})'))
        elif cmd == '/me' and rest:
            if self.send('me', text=rest):
                self.show(f'* {colour(self.nick)} {rest}')
        elif cmd == '/msg' and ' ' in rest:
            to, text = rest.split(' ', 1)
            match = [p for p in self.peers.values() if p['nick'] == to]
            if not match:
                self.show(f'no peer called {to}: try /who')
            elif self.send('pm', addr=match[0]['ip'], text=text):
                self.show(f'{colour(self.nick)} {dim("-> " + to)}: {text}')
        else:
            self.show(__doc__.strip().splitlines()[-1])
        return True

    def run(self):
        threading.Thread(target=self.receive, daemon=True).start()
        self.send('join')
        threading.Thread(target=self.heartbeat, daemon=True).start()
        print(f'lan-chat as {colour(self.nick)} on {local_ip() or "no address"}, '
              f'port {self.port}. /help for commands, /quit to leave.')
        try:
            while True:
                self.reading = True
                line = input(PROMPT).strip()
                self.reading = False
                if not line:
                    continue
                if line.startswith('/'):
                    if not self.command(line):
                        break
                elif self.send('msg', text=line):
                    # replace the echoed input line with the formatted message
                    with self.lock:
                        sys.stdout.write('\x1b[1A\r\x1b[K' + f'{colour(self.nick)}: {line}\n')
                        sys.stdout.flush()
        except (EOFError, KeyboardInterrupt):
            print()
        finally:
            self.running = False
            self.send('leave')


def main():
    ap = argparse.ArgumentParser(description='Peer-to-peer chat over UDP broadcast.')
    ap.add_argument('--nick', help='your name (default: vm-<last part of your IP>)')
    ap.add_argument('--port', type=int, default=50505, help='UDP port (default 50505)')
    ap.add_argument('--broadcast', default='255.255.255.255', help='where to send (default 255.255.255.255)')
    args = ap.parse_args()
    ip = local_ip()
    nick = args.nick or os.environ.get('CHAT_NICK') or (f'vm-{ip.rsplit(".", 1)[1]}' if ip else 'vm')
    Chat(nick, args.port, args.broadcast).run()


if __name__ == '__main__':
    main()
