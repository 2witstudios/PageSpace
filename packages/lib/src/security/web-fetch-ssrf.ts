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
 * Extract an embedded IPv4 value (as a 32-bit int) from an IPv6 string when it
 * is an IPv4-mapped/compatible address. Handles both dotted (`::ffff:1.2.3.4`)
 * and hextet (`::ffff:a9fe:a9fe`, the WHATWG-normalized form) representations.
 * Returns null when there is no embedded IPv4.
 */
function extractEmbeddedIpv4(h: string): number | null {
  // ::ffff:1.2.3.4  or  ::1.2.3.4 (deprecated IPv4-compatible)
  const dotted = h.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return parseIpv4(dotted[1]);

  // ::ffff:a9fe:a9fe  (WHATWG normalizes ::ffff:169.254.169.254 to this)
  const hextets = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hextets) {
    const hi = parseInt(hextets[1], 16);
    const lo = parseInt(hextets[2], 16);
    return (((hi << 16) >>> 0) + lo) >>> 0;
  }
  return null;
}

/** True only when the IPv6 address is globally routable (not loopback/private/reserved). */
function isPublicIpv6(host: string): boolean {
  let h = host.toLowerCase();
  const zone = h.indexOf('%');
  if (zone !== -1) h = h.slice(0, zone);

  if (h === '::' || h === '::1') return false;            // unspecified / loopback
  if (h.startsWith('64:ff9b:')) return false;             // NAT64 — embeds arbitrary (possibly private) IPv4

  const embedded = extractEmbeddedIpv4(h);
  if (embedded !== null) return isPublicIpv4(embedded);

  if (h.startsWith('fc') || h.startsWith('fd')) return false;   // fc00::/7 unique-local
  if (/^fe[89ab]/.test(h)) return false;                        // fe80::/10 link-local
  if (/^fe[cdef]/.test(h)) return false;                        // fec0::/10 site-local (deprecated)
  if (h.startsWith('ff')) return false;                         // ff00::/8 multicast
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
