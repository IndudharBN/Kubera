// Force IPv4 egress for ALL outbound connections.
//
// Why: Zerodha Kite whitelists a *static IP* for order placement. On a dual-stack home
// connection, Node 24 (Happy Eyeballs / autoSelectFamily) often connects over IPv6, so Kite
// sees a rotating, un-whitelisted IPv6 address and rejects orders:
//   "IP (2a00:…) is not allowed to place orders for this app."
// The whitelisted address is the IPv4 (e.g. 86.178.70.232). Forcing IPv4-only resolution makes
// every connection (Kite orders, quotes, historical) egress over IPv4 → Kite sees the whitelisted
// IP. Kite + Cloudflare all have IPv4, so nothing breaks. Imported FIRST in index.ts.

import dns from 'node:dns';
import net from 'node:net';

// 1) Prefer IPv4 in the resolver ordering.
dns.setDefaultResultOrder('ipv4first');

// 2) Disable Happy Eyeballs so IPv4 isn't raced against (and lost to) IPv6.
(net as unknown as { setDefaultAutoSelectFamily?: (v: boolean) => void })
  .setDefaultAutoSelectFamily?.(false);

// 3) Hard guarantee: force every dns.lookup to IPv4-only (family 4). The http/https modules use
// dns.lookup under the hood, so this pins all outbound sockets to IPv4 regardless of caller options.
const _lookup = dns.lookup.bind(dns) as typeof dns.lookup;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(dns as any).lookup = (hostname: string, options: any, callback: any) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  const base = typeof options === 'object' && options !== null ? options : {};
  return _lookup(hostname, { ...base, family: 4 }, callback);
};

console.log('[net] IPv4-only egress enforced (Kite static-IP whitelist)');
