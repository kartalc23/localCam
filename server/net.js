import os from "node:os";

/** LAN'da erisilebilir IPv4 adresleri (loopback ve docker/veth haric). */
export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|br-|veth|virbr|tailscale|zt)/.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

/** avahi calisiyorsa iPhone bu ismi cozer; IP degisse de link sabit kalir. */
export function mdnsHost() {
  return `${os.hostname().split(".")[0]}.local`;
}
