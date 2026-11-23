#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""netup: bring a network interface up and configure it by DHCP, with nothing
but Python's standard library: for guest images with no ip, ifconfig or DHCP
client (Debian's slim image, for one).

    python3 netup.py [IFACE]          (default eth0; run as root)

It sets the link up, asks for a lease over a packet socket (the interface has
no address to send from yet), then sets the address, netmask, broadcast and
default route with ioctls. It does not renew the lease: the jsLab DHCP server
hands out day-long leases and keeps a VM's address for its MAC.
"""

import fcntl
import os
import random
import select
import socket
import struct
import sys
import time

ETH_P_IP = 0x0800
SIOCGIFFLAGS, SIOCSIFFLAGS = 0x8913, 0x8914
SIOCGIFHWADDR = 0x8927
SIOCSIFADDR, SIOCSIFBRDADDR, SIOCSIFNETMASK = 0x8916, 0x891a, 0x891c
SIOCADDRT = 0x890b
IFF_UP, RTF_UP, RTF_GATEWAY = 0x1, 0x1, 0x2
DISCOVER, OFFER, REQUEST, ACK, NAK = 1, 2, 3, 5, 6
COOKIE = b'\x63\x82\x53\x63'


def ifreq(iface, data=b''):
    return struct.pack('16s16s', iface.encode(), data)


def checksum(data):
    if len(data) % 2:
        data += b'\0'
    s = sum(struct.unpack('!%dH' % (len(data) // 2), data))
    s = (s >> 16) + (s & 0xffff)
    s += s >> 16
    return ~s & 0xffff


def dhcp_message(kind, xid, mac, options=()):
    """A BOOTP request with DHCP options, in a UDP/IPv4 packet from 0.0.0.0:68."""
    bootp = struct.pack('!BBBBIHH4s4s4s4s16s64s128s', 1, 1, 6, 0, xid, 0, 0x8000,
                        bytes(4), bytes(4), bytes(4), bytes(4), mac, b'', b'')
    opts = bytes([53, 1, kind, 55, 4, 1, 3, 6, 28, 61, 7, 1]) + mac
    for code, value in options:
        opts += bytes([code, len(value)]) + value
    payload = bootp + COOKIE + opts + b'\xff'
    udp = struct.pack('!HHHH', 68, 67, 8 + len(payload), 0) + payload   # UDP checksum 0: none
    ip = struct.pack('!BBHHHBBH4s4s', 0x45, 0, 20 + len(udp), random.getrandbits(16), 0, 64, 17, 0,
                     bytes(4), b'\xff' * 4)
    ip = ip[:10] + struct.pack('!H', checksum(ip)) + ip[12:]
    return ip + udp


def parse_reply(packet, xid):
    """The DHCP options of a reply to us, as {code: bytes}, plus yiaddr; else None."""
    if len(packet) < 28 or packet[9] != 17:
        return None
    ihl = (packet[0] & 0x0f) * 4
    udp = packet[ihl:]
    if len(udp) < 8 + 240 or struct.unpack('!H', udp[2:4])[0] != 68:
        return None
    bootp = udp[8:]
    if bootp[0] != 2 or struct.unpack('!I', bootp[4:8])[0] != xid or bootp[236:240] != COOKIE:
        return None
    opts, i = {}, 240
    while i < len(bootp) and bootp[i] != 255:
        if bootp[i] == 0:
            i += 1
            continue
        if i + 1 >= len(bootp):
            break
        code, length = bootp[i], bootp[i + 1]
        opts[code] = bootp[i + 2:i + 2 + length]
        i += 2 + length
    opts['yiaddr'] = bootp[16:20]
    return opts


def exchange(raw, iface, packet, xid, want, timeout=3.0):
    raw.sendto(packet, (iface, ETH_P_IP, 0, 0, b'\xff' * 6))
    end = time.time() + timeout
    while time.time() < end:
        ready, _, _ = select.select([raw], [], [], max(0, end - time.time()))
        if not ready:
            break
        reply = parse_reply(raw.recv(2048), xid)
        if reply and reply.get(53, b'\0')[0] in want:
            return reply
    return None


def set_addr(ctl, iface, request, ip):
    fcntl.ioctl(ctl, request, ifreq(iface, struct.pack('HH4s8x', socket.AF_INET, 0, ip)))


def add_default_route(ctl, gateway):
    sin = lambda a: struct.pack('HH4s8x', socket.AF_INET, 0, a)
    # struct rtentry, native layout: pad1, dst, gateway, genmask, flags, pad2,
    # pad3, pad4, metric, dev, mtu, window, irtt
    rt = struct.pack('@L16s16s16sHhLPhPLLH', 0, sin(bytes(4)), sin(gateway), sin(bytes(4)),
                     RTF_UP | RTF_GATEWAY, 0, 0, 0, 0, 0, 0, 0, 0)
    fcntl.ioctl(ctl, SIOCADDRT, rt)


def main():
    iface = sys.argv[1] if len(sys.argv) > 1 else 'eth0'
    if os.geteuid() != 0:
        sys.exit('netup: needs root')
    ctl = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    flags = struct.unpack('16sH', fcntl.ioctl(ctl, SIOCGIFFLAGS, ifreq(iface))[:18])[1]
    fcntl.ioctl(ctl, SIOCSIFFLAGS, ifreq(iface, struct.pack('H', flags | IFF_UP)))
    mac = fcntl.ioctl(ctl, SIOCGIFHWADDR, ifreq(iface))[18:24]
    print(f'netup: {iface} is up, MAC {mac.hex(":")}; asking for a lease')

    raw = socket.socket(socket.AF_PACKET, socket.SOCK_DGRAM, socket.htons(ETH_P_IP))
    raw.bind((iface, ETH_P_IP))
    for attempt in range(5):
        xid = random.getrandbits(32)
        offer = exchange(raw, iface, dhcp_message(DISCOVER, xid, mac), xid, (OFFER,))
        if not offer:
            continue
        server = offer.get(54, b'')
        ack = exchange(raw, iface, dhcp_message(REQUEST, xid, mac, [(50, offer['yiaddr']), (54, server)]),
                       xid, (ACK, NAK))
        if ack and ack[53][0] == ACK:
            break
    else:
        sys.exit('netup: no lease (no DHCP server answered)')

    ip = ack['yiaddr']
    mask = ack.get(1, b'\xff\xff\xff\x00')
    bcast = ack.get(28) or bytes(a | (~m & 0xff) for a, m in zip(ip, mask))
    set_addr(ctl, iface, SIOCSIFADDR, ip)
    set_addr(ctl, iface, SIOCSIFNETMASK, mask)
    set_addr(ctl, iface, SIOCSIFBRDADDR, bcast)
    gateway = ack.get(3, b'')[:4]
    if gateway:
        try:
            add_default_route(ctl, gateway)
        except OSError as e:
            if e.errno != 17:   # EEXIST: already there
                print(f'netup: no default route ({e.strerror})')
    dns = ack.get(6, b'')
    if dns:
        try:
            with open('/etc/resolv.conf', 'w') as f:
                f.writelines(f'nameserver {socket.inet_ntoa(dns[i:i + 4])}\n' for i in range(0, len(dns) - 3, 4))
        except OSError:
            pass
    prefix = bin(int.from_bytes(mask, 'big')).count('1')
    print(f'netup: {iface} {socket.inet_ntoa(ip)}/{prefix}'
          + (f' via {socket.inet_ntoa(gateway)}' if gateway else ''))


if __name__ == '__main__':
    main()
