# TinyEMU Virtual Network Plan

## Overview

Implement a virtual network stack in JavaScript (OOP) that:
1. Receives raw Ethernet frames from WASM-emulated VMs
2. Routes packets between multiple VMs
3. Provides a central router with DHCP server
4. Runs entirely in the browser (no backend needed)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser JS Environment                   │
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │   VM #1     │    │   VM #2     │    │   VM #N     │         │
│  │ (WASM)      │    │ (WASM)      │    │ (WASM)      │         │
│  │             │    │             │    │             │         │
│  │ virtio-net  │    │ virtio-net  │    │ virtio-net  │         │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘         │
│         │                  │                  │                 │
│         ▼                  ▼                  ▼                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              VirtualNetwork (Central Router)             │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │   │
│  │  │  DHCPServer │  │   Router    │  │  PacketSwitch   │  │   │
│  │  │             │  │             │  │                 │  │   │
│  │  │ - Leases    │  │ - ARP       │  │ - Broadcast     │  │   │
│  │  │ - Options   │  │ - Routing   │  │ - Unicast       │  │   │
│  │  │ - Renewal   │  │ - NAT*      │  │ - Multicast     │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Class Design

### 1. `VirtualNetwork` - Main Coordinator

```javascript
class VirtualNetwork {
    constructor(options = {}) {
        this.subnet = options.subnet || '10.0.2.0/24';
        this.gatewayIP = options.gatewayIP || '10.0.2.2';
        this.netmask = options.netmask || '255.255.255.0';
        this.dhcpStart = options.dhcpStart || '10.0.2.15';
        this.dhcpEnd = options.dhcpEnd || '10.0.2.100';
        this.dnsServer = options.dnsServer || '10.0.2.3';
        
        this.vms = new Map();           // vmId -> VMInterface
        this.dhcpServer = new DHCPServer(this);
        this.router = new Router(this);
        this.packetSwitch = new PacketSwitch(this);
        
        this.stats = { rx: 0, tx: 0, dropped: 0 };
    }
    
    // Register a VM's network interface
    registerVM(vmId, vmInterface) { ... }
    
    // Unregister a VM
    unregisterVM(vmId) { ... }
    
    // Main entry point: receive raw Ethernet frame from a VM
    receivePacket(vmId, frameBuffer) { ... }
    
    // Send frame to specific VM
    sendToVM(vmId, frameBuffer) { ... }
    
    // Broadcast to all VMs except sender
    broadcast(vmId, frameBuffer) { ... }
}
```

### 2. `VMInterface` - Per-VM Network Interface

```javascript
class VMInterface {
    constructor(vmId, macAddress, virtualNetwork) {
        this.vmId = vmId;
        this.macAddress = macAddress;           // 6 bytes
        this.ipAddress = null;                  // Assigned by DHCP
        this.virtualNetwork = virtualNetwork;
        this.pendingDHCP = false;
        this.arpCache = new Map();              // ip -> mac
        
        // Callbacks to WASM
        this.onPacketReceived = null;           // (frameBuffer) => void
    }
    
    // Called by VirtualNetwork when packet arrives for this VM
    deliverPacket(frameBuffer) { ... }
    
    // Send raw frame to network
    sendPacket(frameBuffer) { ... }
    
    // Handle DHCP assignment
    setIPAddress(ip, leaseTime, options) { ... }
    
    // ARP resolution
    resolveARP(targetIP) { ... }
}
```

### 3. `DHCPServer` - DHCP Protocol Implementation

```javascript
class DHCPServer {
    constructor(virtualNetwork) {
        this.virtualNetwork = virtualNetwork;
        this.leases = new Map();                // mac -> LeaseInfo
        this.availableIPs = [];                 // Pool of available IPs
        this.allocatedIPs = new Map();          // ip -> mac
        
        this.options = {
            subnetMask: '255.255.255.0',
            router: '10.0.2.2',
            dnsServer: '10.0.2.3',
            leaseTime: 86400,                   // 24 hours
            serverIdentifier: '10.0.2.2',
            broadcastAddress: '10.0.2.255'
        };
        
        this.initializePool();
    }
    
    initializePool() { ... }
    
    // Process incoming DHCP packet, return response frame or null
    handleDHCP(vmInterface, frameBuffer) { ... }
    
    // Build DHCP response (OFFER/ACK/NAK)
    buildResponse(vmInterface, msgType, transactionId, requestedIP) { ... }
    
    // Parse DHCP options from frame
    parseOptions(frameBuffer) { ... }
    
    // Allocate IP for MAC
    allocateIP(macAddress) { ... }
    
    // Release IP
    releaseIP(macAddress) { ... }
}
```

### 4. `Router` - L3 Routing & ARP

```javascript
class Router {
    constructor(virtualNetwork) {
        this.virtualNetwork = virtualNetwork;
        this.arpTable = new Map();              // ip -> {mac, expiry, vmId}
        this.routes = [];                       // Routing table entries
        this.gatewayMAC = null;                 // Router's MAC
    }
    
    // Process IP packet, handle routing
    routePacket(vmInterface, ipPacket) { ... }
    
    // ARP request/reply handling
    handleARP(vmInterface, arpPacket) { ... }
    
    // Send ARP request
    sendARPRequest(targetIP, senderVM) { ... }
    
    // Send ARP reply
    sendARPReply(targetIP, targetMAC, senderVM) { ... }
    
    // Update ARP table
    updateARP(ip, mac, vmId) { ... }
    
    // Resolve next-hop MAC for IP
    resolveNextHop(destIP, senderVM) { ... }
}
```

### 5. `PacketSwitch` - L2 Switching

```javascript
class PacketSwitch {
    constructor(virtualNetwork) {
        this.virtualNetwork = virtualNetwork;
        this.macTable = new Map();              // mac -> vmId (learning switch)
    }
    
    // Switch frame based on destination MAC
    switchFrame(srcVMId, frameBuffer) { ... }
    
    // Learn source MAC
    learnMAC(mac, vmId) { ... }
    
    // Handle broadcast/multicast
    floodFrame(srcVMId, frameBuffer) { ... }
    
    // Check if MAC is local
    isLocalMAC(mac) { ... }
}
```

### 6. `EthernetFrame` - Frame Parsing/Building

```javascript
class EthernetFrame {
    static ETH_P_IP = 0x0800;
    static ETH_P_ARP = 0x0806;
    static ETH_P_RARP = 0x8035;
    static ETH_P_IPV6 = 0x86DD;
    
    constructor(buffer = null) {
        this.dstMAC = new Uint8Array(6);
        this.srcMAC = new Uint8Array(6);
        this.ethertype = 0;
        this.payload = null;
        this.fcs = null;                        // Optional, usually not in emulation
        
        if (buffer) this.parse(buffer);
    }
    
    parse(buffer) { ... }
    serialize() { ... }
    
    static build(dstMAC, srcMAC, ethertype, payload) { ... }
}
```

### 7. `IPPacket` - IP Packet Parsing/Building

```javascript
class IPPacket {
    static PROTO_ICMP = 1;
    static PROTO_TCP = 6;
    static PROTO_UDP = 17;
    
    constructor(buffer = null) {
        this.version = 4;
        this.ihl = 5;
        this.tos = 0;
        this.totalLength = 0;
        this.identification = 0;
        this.flags = 0;
        this.fragmentOffset = 0;
        this.ttl = 64;
        this.protocol = 0;
        this.headerChecksum = 0;
        this.srcIP = new Uint8Array(4);
        this.dstIP = new Uint8Array(4);
        this.options = null;
        this.payload = null;
        
        if (buffer) this.parse(buffer);
    }
    
    parse(buffer) { ... }
    serialize() { ... }
    computeChecksum() { ... }
    
    static build(srcIP, dstIP, protocol, payload, ttl = 64) { ... }
}
```

### 8. `ARPPacket` - ARP Parsing/Building

```javascript
class ARPPacket {
    static HW_ETHERNET = 1;
    static PROTO_IP = 0x0800;
    static OP_REQUEST = 1;
    static OP_REPLY = 2;
    
    constructor(buffer = null) {
        this.hardwareType = ARPPacket.HW_ETHERNET;
        this.protocolType = ARPPacket.PROTO_IP;
        this.hardwareSize = 6;
        this.protocolSize = 4;
        this.operation = 0;
        this.senderMAC = new Uint8Array(6);
        this.senderIP = new Uint8Array(4);
        this.targetMAC = new Uint8Array(6);
        this.targetIP = new Uint8Array(4);
        
        if (buffer) this.parse(buffer);
    }
    
    parse(buffer) { ... }
    serialize() { ... }
    
    static buildRequest(senderMAC, senderIP, targetIP) { ... }
    static buildReply(senderMAC, senderIP, targetMAC, targetIP) { ... }
}
```

### 9. `DHCPPacket` - DHCP Parsing/Building

```javascript
class DHCPPacket {
    static OP_BOOTREQUEST = 1;
    static OP_BOOTREPLY = 2;
    static MAGIC_COOKIE = [0x63, 0x82, 0x53, 0x63];
    
    // DHCP Option codes
    static OPT_SUBNET_MASK = 1;
    static OPT_ROUTER = 3;
    static OPT_DNS = 6;
    static OPT_HOSTNAME = 12;
    static OPT_DOMAIN = 15;
    static OPT_BROADCAST = 28;
    static OPT_LEASE_TIME = 51;
    static OPT_MSG_TYPE = 53;
    static OPT_SERVER_ID = 54;
    static OPT_PARAM_REQ = 55;
    static OPT_RENEWAL = 58;
    static OPT_REBIND = 59;
    static OPT_END = 255;
    
    static MSG_DISCOVER = 1;
    static MSG_OFFER = 2;
    static MSG_REQUEST = 3;
    static MSG_ACK = 5;
    static MSG_NAK = 6;
    
    constructor(buffer = null) {
        this.op = 0;
        this.htype = 1;
        this.hlen = 6;
        this.hops = 0;
        this.xid = 0;
        this.secs = 0;
        this.flags = 0;
        this.ciaddr = new Uint8Array(4);
        this.yiaddr = new Uint8Array(4);
        this.siaddr = new Uint8Array(4);
        this.giaddr = new Uint8Array(4);
        this.chaddr = new Uint8Array(16);
        this.sname = new Uint8Array(64);
        this.file = new Uint8Array(128);
        this.options = new Map();               // option code -> value
        
        if (buffer) this.parse(buffer);
    }
    
    parse(buffer) { ... }
    serialize() { ... }
    
    getOption(code) { ... }
    setOption(code, value) { ... }
    
    static buildReply(request, msgType, serverIP, clientIP, options) { ... }
}
```

### 10. `UDPPacket` / `TCPPacket` / `ICMPPacket` - Transport Layer (Optional)

```javascript
class UDPPacket {
    constructor(buffer = null) {
        this.srcPort = 0;
        this.dstPort = 0;
        this.length = 0;
        this.checksum = 0;
        this.payload = null;
        
        if (buffer) this.parse(buffer);
    }
    
    parse(buffer) { ... }
    serialize(pseudoHeader) { ... }
    computeChecksum(pseudoHeader) { ... }
}

// Similar for TCP (simplified, connection tracking optional)
// Similar for ICMP (echo request/reply for ping)
```

---

## Integration Points

### 1. C/WASM Side (jsemu.c + lib.js)

**Current flow:**
- VM → `net_recv_packet()` in lib.js → `Module.api.net.recvPacket()`
- JS → `net_write_packet()` in jsemu.c → `device_write_packet()` → virtio-net

**Required changes:**

In TinyEMU's `wasm/lib.js`:
```javascript
// Replace simple net_recv_packet with VirtualNetwork integration
net_recv_packet: function(bs, buf, len) {
    const frame = HEAPU8.subarray(buf, buf + len);
    if (Module.api.virtualNetwork) {
        Module.api.virtualNetwork.receivePacket(Module.api.currentVMId, frame);
    }
},

// New: called from JS to inject packet into VM
net_inject_packet: function(buf, len) {
    // Called by VirtualNetwork.sendToVM()
    net_write_packet(HEAPU8.subarray(buf, buf + len));
},
```

In `jsemu.c`:
```c
// Add export for JS to inject packets
void net_inject_packet(const uint8_t *buf, int len) {
    EthernetDevice *net = global_vm->net;
    if (net) {
        net->device_write_packet(net, buf, len);
    }
}
```

### 2. VM Registration

Each VM needs a unique MAC address. The VM can be identified by an ID passed during `vm_start()`.

```javascript
// In JS initialization
const network = new VirtualNetwork({ subnet: '10.0.2.0/24' });

// When starting a VM
function startVM(vmId, config) {
    const mac = generateMAC(vmId);  // Deterministic from VM ID
    const vmInterface = new VMInterface(vmId, mac, network);
    network.registerVM(vmId, vmInterface);
    
    // Pass VM ID to WASM so it knows which VM it is
    Module.api.currentVMId = vmId;
    Module.api.virtualNetwork = network;
    
    vm_start(url, ram, cmdline, pwd, width, height, true);
}
```

---

## Packet Flow

### VM → Network (Outbound)

```
VM (virtio-net) 
    → jsemu.c: net_write_packet() 
    → lib.js: net_recv_packet() 
    → VirtualNetwork.receivePacket(vmId, frame)
    → PacketSwitch.switchFrame()
    → [ARP resolution if needed]
    → Router.routePacket() or direct delivery
    → targetVM.deliverPacket(frame)
    → JS → net_inject_packet() → virtio-net RX queue
```

### DHCP Flow

```
VM boots → sends DHCPDISCOVER (broadcast)
    → VirtualNetwork.receivePacket()
    → PacketSwitch: flood to router
    → DHCPServer.handleDHCP() → DHCPOFFER
    → Router delivers to VM
    → VM sends DHCPREQUEST
    → DHCPServer.handleDHCP() → DHCPACK + lease
    → VMInterface.setIPAddress()
```

### Inter-VM Communication

```
VM1 → ping VM2 (IP)
    → ARP request for VM2 IP
    → Router responds with VM2 MAC (from DHCP lease)
    → VM1 sends ICMP echo to VM2 MAC
    → PacketSwitch delivers to VM2
    → VM2 replies
```

---

## Implementation Phases

### Phase 1: Core Infrastructure (Week 1-2)
- [ ] `VirtualNetwork` class with VM registry
- [ ] `VMInterface` class with MAC management
- [ ] `EthernetFrame` parser/builder
- [ ] Basic packet switching (MAC learning, flooding)
- [ ] Integration with existing `net_recv_packet` / `net_write_packet`

### Phase 2: DHCP Server (Week 2-3)
- [ ] `DHCPServer` class with lease management
- [ ] `DHCPPacket` parser/builder (full option support)
- [ ] DHCP state machine (DISCOVER → OFFER → REQUEST → ACK)
- [ ] Lease renewal/rebinding/expiration
- [ ] Integration test: VM gets IP via DHCP

### Phase 3: IP Routing & ARP (Week 3-4)
- [ ] `IPPacket` parser/builder
- [ ] `ARPPacket` parser/builder
- [ ] `Router` class with ARP table
- [ ] ARP request/reply handling
- [ ] IP forwarding between VMs
- [ ] Test: ping between two VMs

### Phase 4: Advanced Features (Week 4-5)
- [ ] ICMP echo request/reply (ping)
- [ ] UDP parsing (for DHCP, DNS, NTP)
- [ ] DNS proxy/forwarder (optional)
- [ ] NAT for external access (optional, complex)
- [ ] Statistics/monitoring UI
- [ ] Multiple virtual networks (VLANs)

### Phase 5: Polish & Integration (Week 5-6)
- [ ] Error handling & edge cases
- [ ] Performance optimization (buffer pooling)
- [ ] Debug logging & visualization
- [ ] Documentation & examples
- [ ] Multi-VM demo page

---

## Key Technical Decisions

### 1. Buffer Handling
- Use `Uint8Array` for all packet buffers
- Avoid copies where possible (use subarray views)
- Pool buffers to reduce GC pressure

### 2. MAC Address Generation
```javascript
function generateMAC(vmId) {
    // Locally administered, unicast: 02:xx:xx:xx:xx:xx
    const hash = simpleHash(vmId);
    return new Uint8Array([
        0x02,  // Locally administered
        (hash >> 24) & 0xff,
        (hash >> 16) & 0xff,
        (hash >> 8) & 0xff,
        hash & 0xff,
        vmId & 0xff
    ]);
}
```

### 3. IP Address Utilities
```javascript
const IPUtils = {
    toString: (buf, offset = 0) => 
        `${buf[offset]}.${buf[offset+1]}.${buf[offset+2]}.${buf[offset+3]}`,
    parse: (str) => {
        const parts = str.split('.').map(Number);
        return new Uint8Array(parts);
    },
    equals: (a, b) => a.every((v, i) => v === b[i]),
    inSubnet: (ip, subnet, mask) => { ... },
    nextIP: (ip) => { ... }
};
```

### 4. Checksum Calculation
```javascript
function internetChecksum(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 2) {
        sum += (buffer[i] << 8) + (buffer[i + 1] || 0);
    }
    while (sum > 0xffff) sum = (sum & 0xffff) + (sum >> 16);
    return ~sum & 0xffff;
}
```

---

## Testing Strategy

### Unit Tests (Node.js / Vitest)
- Packet parsing/serialization round-trips
- DHCP state machine transitions
- ARP table operations
- IP routing decisions
- Checksum calculations

### Integration Tests (Browser)
- Single VM: DHCP lease acquisition
- Two VMs: ping each other
- Three+ VMs: broadcast handling
- Lease renewal/expiration
- VM disconnect/reconnect

### Manual Testing
- Alpine Linux in VM: `udhcpc -i eth0`
- Multiple Alpine VMs: `ping`, `wget` between them
- Browser devtools: inspect packet flows

---

## File Structure

```
js/
├── lib.js                    # Existing Emscripten bindings
├── network/
│   ├── VirtualNetwork.js     # Main coordinator
│   ├── VMInterface.js        # Per-VM interface
│   ├── PacketSwitch.js       # L2 switching
│   ├── Router.js             # L3 routing + ARP
│   ├── DHCPServer.js         # DHCP protocol
│   ├── packets/
│   │   ├── EthernetFrame.js
│   │   ├── IPPacket.js
│   │   ├── ARPPacket.js
│   │   ├── DHCPPacket.js
│   │   ├── UDPPacket.js
│   │   └── ICMPPacket.js
│   └── utils/
│       ├── IPUtils.js
│       ├── Checksum.js
│       └── MACUtils.js
```

---

## Integration with Existing Build

1. Add `lib/network/**/*.js` to the Emscripten build (or load as ES modules)
2. Modify TinyEMU's `wasm/lib.js` to import and initialize `VirtualNetwork`
3. Update `jsemu.c` to export `net_inject_packet`
4. Add `Module.api.virtualNetwork` and `Module.api.currentVMId` setup in HTML/JS launcher

---

## Future Extensions

- **VDE/Tap integration**: Connect to host network via WebRTC/WebSocket
- **PCAP export**: Capture packets for Wireshark analysis
- **Network topology visualization**: D3.js graph of VMs/connections
- **VPN gateway**: WireGuard/OpenVPN client in JS for secure tunnels
- **Load balancer**: Distribute traffic across VM pools