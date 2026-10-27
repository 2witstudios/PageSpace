/**
 * Security validation for fetch proxy requests.
 *
 * Only allows requests to local/private network addresses to prevent the cloud
 * server from using the desktop app as an arbitrary HTTP proxy to the public internet.
 */

const ALLOWED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  'host.docker.internal',
]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Check if an IPv4 address is in a private range:
 * - 10.0.0.0/8
 * - 172.16.0.0/12
 * - 192.168.0.0/16
 */
function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map(Number);
  if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return false;

  const [first, second] = octets;

  // 10.0.0.0/8
  if (first === 10) return true;

  // 172.16.0.0/12
  if (first === 172 && second >= 16 && second <= 31) return true;

  // 192.168.0.0/16
  if (first === 192 && second === 168) return true;

  return false;
}

/**
 * Explicit blocklist for dangerous IPv4 ranges — checked BEFORE the allowlist
 * as defense-in-depth against future allowlist expansion.
 */
function isBlockedIPv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map(Number);
  if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return false;

  const [first, second, third, fourth] = octets;

  // 169.254.0.0/16 — link-local (AWS/GCP/DO/Oracle/OpenStack metadata at 169.254.169.254)
  if (first === 169 && second === 254) return true;

  // Alibaba Cloud metadata endpoint
  if (first === 100 && second === 100 && third === 100 && fourth === 200) return true;

  // Azure wireserver / IMDS
  if (first === 168 && second === 63 && third === 129 && fourth === 16) return true;

  return false;
}

/**
 * Explicit blocklist for dangerous IPv6 ranges — checked BEFORE the allowlist.
 */
function isBlockedIPv6(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // fd00::/8 — ULA (covers AWS IMDSv2 IPv6 at fd00:ec2::254)
  if (lower.startsWith('fd')) return true;

  // fe80::/10 — link-local IPv6
  if (lower.startsWith('fe80:') || lower.startsWith('fe80%')) return true;

  return false;
}

/**
 * Extract the IPv4 address from an IPv6-mapped IPv4 hostname (::ffff:x.x.x.x or ::ffff:hex:hex).
 * Returns the dotted-quad IPv4 string, or null if not an IPv6-mapped address.
 */
function parseIPv6MappedIPv4(hostname: string): string | null {
  const match = hostname.match(/^::ffff:(.+)$/i);
  if (!match) return null;

  const mapped = match[1];

  // Dotted form: ::ffff:192.168.1.1
  if (mapped.includes('.')) return mapped;

  // Hex form: ::ffff:c0a8:101 → 192.168.1.1
  const hexParts = mapped.split(':');
  if (hexParts.length === 2) {
    const hi = parseInt(hexParts[0], 16);
    const lo = parseInt(hexParts[1], 16);
    if (!isNaN(hi) && !isNaN(lo)) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }

  return null;
}

/**
 * Validates whether a URL is allowed for fetch proxy requests.
 *
 * First blocks known-dangerous ranges (cloud metadata endpoints, link-local,
 * ULA IPv6) as defense-in-depth, then allows only local/private addresses.
 *
 * Allows:
 * - localhost, 127.0.0.1, ::1, 0.0.0.0 (any port)
 * - host.docker.internal (any port)
 * - Private IPv4 ranges: 10.x.x.x, 172.16-31.x.x, 192.168.x.x
 * - http: and https: protocols only
 *
 * Explicitly blocks (even if they overlap with allowed ranges):
 * - 169.254.0.0/16 (link-local — cloud metadata)
 * - 100.100.100.200 (Alibaba Cloud metadata)
 * - 168.63.129.16 (Azure wireserver)
 * - fd00::/8 (ULA IPv6 — AWS IMDSv2)
 * - fe80::/10 (link-local IPv6)
 *
 * Blocks everything else — especially public internet URLs.
 */
export function isAllowedFetchProxyURL(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return false;
  }

  // Strip brackets from IPv6 (URL parser wraps ::1 as [::1])
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  // Explicit blocklist — checked before the allowlist so dangerous ranges
  // stay blocked even if the allowlist is later expanded.
  if (isBlockedIPv4(hostname)) return false;
  if (isBlockedIPv6(hostname)) return false;
  const mappedForBlock = parseIPv6MappedIPv4(hostname);
  if (mappedForBlock !== null && isBlockedIPv4(mappedForBlock)) return false;

  if (ALLOWED_HOSTNAMES.has(hostname)) {
    return true;
  }

  if (isPrivateIPv4(hostname)) {
    return true;
  }

  // Handle IPv6-mapped IPv4 addresses (e.g. ::ffff:192.168.1.1 or ::ffff:c0a8:101)
  const mappedIPv4 = mappedForBlock ?? parseIPv6MappedIPv4(hostname);
  if (mappedIPv4 !== null) {
    return ALLOWED_HOSTNAMES.has(mappedIPv4) || isPrivateIPv4(mappedIPv4);
  }

  return false;
}
