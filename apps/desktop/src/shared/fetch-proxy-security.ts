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

  return false;
}
