/**
 * Pure SSRF-guard decision functions for the `web_fetch` AI tool.
 *
 * These are intentionally side-effect free (no DNS, no network) so the security
 * decision can be exhaustively unit-tested with table-driven cases. The network
 * shell in `web-search-tools.ts` resolves hostnames and re-applies `isPublicIp`
 * to every resolved address and every redirect hop.
 *
 * Threat model (audit finding M2): an attacker-controlled public URL can 302 to
 * `http://169.254.169.254/...` (cloud metadata) or an internal host, or use a
 * hostname that resolves to a private IP (DNS rebinding). The initial-host-only
 * check is insufficient, so every hop is revalidated and pinned downstream.
 */

/** Human-readable reason returned for any private/internal/reserved target. */
export const PRIVATE_HOST_MESSAGE = 'Fetching private or internal hosts is not allowed';

export interface FetchTargetDecision {
  ok: boolean;
  reason?: string;
}

/** Parse a single dotted part as decimal, hex (0x…) or octal (0…). Returns null if invalid. */
function parseIpv4Part(part: string): number | null {
  if (part === '') return null;
  let n: number;
  if (/^0x[0-9a-f]+$/i.test(part)) {
    n = parseInt(part.slice(2), 16);
  } else if (/^0[0-7]+$/.test(part)) {
    n = parseInt(part, 8);
  } else if (/^[0-9]+$/.test(part)) {
    n = parseInt(part, 10);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Parse an IPv4 address in any inet_aton form (dotted decimal/hex/octal, or a
 * single decimal/hex integer) into a 32-bit unsigned integer. Returns null when
 * the string is not a valid IPv4 literal.
 */
export function parseIpv4(host: string): number | null {
  const rawParts = host.split('.');
  if (rawParts.length < 1 || rawParts.length > 4) return null;

  const parts: number[] = [];
  for (const raw of rawParts) {
    const n = parseIpv4Part(raw);
    if (n === null) return null;
    parts.push(n);
  }

  const last = parts.length - 1;
  // Every part except the last must fit in a single byte.
  for (let i = 0; i < last; i++) {
    if (parts[i] > 0xff) return null;
  }
  // The last part absorbs the remaining bytes (e.g. "127.1" => 127.0.0.1).
  const maxLast = Math.pow(256, 4 - last) - 1;
  if (parts[last] > maxLast) return null;

  let result = parts[last];
  for (let i = 0; i < last; i++) {
    result += parts[i] * Math.pow(256, 3 - i);
  }
  if (result < 0 || result > 0xffffffff) return null;
  return result >>> 0;
}

/** True only when the 32-bit IPv4 value is globally routable (not private/reserved). */
function isPublicIpv4(n: number): boolean {
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  const c = (n >>> 8) & 0xff;

  if (a === 0) return false;                              // 0.0.0.0/8 "this network"
  if (a === 10) return false;                             // 10.0.0.0/8 private
  if (a === 127) return false;                            // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return false;               // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;      // 172.16.0.0/12 private
  if (a === 192 && b === 168) return false;               // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return false;     // 100.64.0.0/10 carrier-grade NAT
  if (a === 192 && b === 0 && c === 0) return false;      // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false;      // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false;  // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false;   // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;    // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return false;                             // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  return true;
}

/**
 * Parse an IPv6 address in any textual form (compressed `::`, fully expanded,
 * leading zeros, trailing dotted IPv4, any case) into its eight 16-bit groups.
 * The zone id (`%eth0`) must already be stripped. Returns null when the string
 * is not a valid IPv6 address.
 */
function parseIpv6(h: string): number[] | null {
  let text = h;
  const tail: number[] = [];
  const dotted = text.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const octets = dotted[2].split('.').map(Number);
    if (octets.some((o) => o > 255)) return null;
    tail.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    text = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
    return groups.map((g) => parseInt(g, 16));
  };
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (head === null || rest === null) return null;

  const explicit = head.length + rest.length + tail.length;
  if (halves.length === 1) {
    return explicit === 8 ? [...head, ...tail] : null;
  }
  if (explicit > 7) return null;
  return [...head, ...new Array<number>(8 - explicit).fill(0), ...rest, ...tail];
}

const ipv4From = (hi: number, lo: number): number => ((hi << 16) >>> 0) + lo;

/**
 * IANA IPv6 Global Unicast Address Assignments: the only prefixes allocated to
 * RIRs for routing. Everything else in 2000::/3 is unallocated, retired (6bone
 * 3ffe::/16) or special-purpose (3fff::/20, 5f00::/16), and everything outside
 * it is loopback / mapped / translated / NAT64 / discard / ULA / link-local /
 * multicast. A newly allocated block must be added here before it is fetchable.
 * Each entry is [the first 32 bits of the prefix, prefix length (<= 32)].
 */
const IANA_GLOBAL_UNICAST: ReadonlyArray<readonly [number, number]> = [
  [0x20010000, 16],
  [0x20020000, 16], // 6to4 — additionally judged by its embedded IPv4 below
  [0x20030000, 18],
  [0x24000000, 12],
  [0x26000000, 12],
  [0x26100000, 23],
  [0x26200000, 23],
  [0x26300000, 12],
  [0x28000000, 12],
  [0x2a000000, 12],
  [0x2c000000, 12],
];

const inIanaGlobalUnicast = (g0: number, g1: number): boolean => {
  const high32 = ((g0 << 16) >>> 0) + g1;
  return IANA_GLOBAL_UNICAST.some(([prefix, length]) => high32 >>> (32 - length) === prefix >>> (32 - length));
};

/**
 * True only when the IPv6 address is globally routable. Allowlist, not
 * denylist: only the IANA global unicast allocations can be public, minus
 * 2001::/23 IETF protocol assignments (incl. Teredo 2001::/32) and
 * 2001:db8::/32 documentation. IPv4-mapped (::ffff:0:0/96) and 6to4
 * (2002::/16) are judged by the IPv4 they embed. Unparseable input is refused
 * (fail closed).
 */
function isPublicIpv6(host: string): boolean {
  const zone = host.indexOf('%');
  const groups = parseIpv6((zone === -1 ? host : host.slice(0, zone)).toLowerCase());
  if (groups === null) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  // ::ffff:a.b.c.d — IPv4-mapped: the socket really connects to that IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPublicIpv4(ipv4From(g6, g7));
  }
  if (!inIanaGlobalUnicast(g0, g1)) return false;
  if (g0 === 0x2001 && g1 < 0x0200) return false;           // 2001::/23 IETF protocol assignments (incl. Teredo 2001::/32)
  if (g0 === 0x2001 && g1 === 0x0db8) return false;         // 2001:db8::/32 documentation
  if (g0 === 0x2002) return isPublicIpv4(ipv4From(g1, g2)); // 2002::/16 6to4 embeds an IPv4
  return true;
}

/** True when the bare host (no brackets) is an IP literal in any IPv4 or IPv6 form. */
export function isIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare === '') return false;
  if (parseIpv4(bare) !== null) return true;
  return bare.includes(':');
}

/**
 * True only for a globally routable public IP address. Returns false for any
 * private/loopback/link-local/reserved IP, and false for non-IP strings
 * (fail-closed). Accepts decimal/hex/octal-encoded IPv4 and bracketed IPv6.
 */
export function isPublicIp(ip: string): boolean {
  const bare = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (bare === '') return false;
  const v4 = parseIpv4(bare);
  if (v4 !== null) return isPublicIpv4(v4);
  if (bare.includes(':')) return isPublicIpv6(bare);
  return false;
}

/**
 * Decide whether a URL is an allowed `web_fetch` target based on scheme and any
 * literal IP in the host. Pure and DNS-free: hostnames that are not IP literals
 * return `{ ok: true }` and MUST still be DNS-validated (and pinned) by the
 * network shell before connecting.
 */
export function isAllowedFetchTarget(url: string): FetchTargetDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Only HTTPS URLs are supported' };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '') {
    return { ok: false, reason: 'URL has no host' };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: PRIVATE_HOST_MESSAGE };
  }

  if (isIpLiteral(host)) {
    if (!isPublicIp(host)) {
      return { ok: false, reason: PRIVATE_HOST_MESSAGE };
    }
  }

  return { ok: true };
}
