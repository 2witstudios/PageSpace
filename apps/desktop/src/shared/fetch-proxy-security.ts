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
 * Allows:
 * - localhost, 127.0.0.1, ::1, 0.0.0.0 (any port)
 * - host.docker.internal (any port)
 * - Private IPv4 ranges: 10.x.x.x, 172.16-31.x.x, 192.168.x.x
 * - http: and https: protocols only
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

  if (ALLOWED_HOSTNAMES.has(hostname)) {
    return true;
  }

  if (isPrivateIPv4(hostname)) {
    return true;
  }

  // Handle IPv6-mapped IPv4 addresses (e.g. ::ffff:192.168.1.1 or ::ffff:c0a8:101)
  const mappedIPv4 = parseIPv6MappedIPv4(hostname);
  if (mappedIPv4 !== null) {
    return ALLOWED_HOSTNAMES.has(mappedIPv4) || isPrivateIPv4(mappedIPv4);
  }

  return false;
}
