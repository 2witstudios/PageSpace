/**
 * URL Validator for SSRF Prevention
 *
 * Provides utilities to validate URLs before making server-side requests,
 * preventing Server-Side Request Forgery (SSRF) attacks.
 *
 * Key protections:
 * - Blocks localhost and loopback addresses
 * - Blocks private IP ranges (RFC 1918)
 * - Blocks link-local addresses
 * - Blocks cloud metadata endpoints (AWS, GCP, Azure)
 * - Blocks dangerous protocols (file://, gopher://, etc.)
 * - Validates ALL DNS-resolved IPs (not just the first)
 * - Handles IPv4-mapped IPv6 addresses
 */

import { promises as dns } from 'dns';

// Blocked IP addresses (cloud metadata endpoints)
const BLOCKED_IPS = [
  '169.254.169.254', // AWS/GCP metadata
  '100.100.100.200', // Alibaba Cloud metadata
  'fd00:ec2::254',   // AWS IMDSv2 IPv6
];

// Blocked hostnames (cloud metadata)
const BLOCKED_HOSTNAMES = [
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.com',
  'instance-data',
];

// Allowed protocols
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/**
 * Check if an IP address is in a private/blocked range
 */
export function isBlockedIP(ip: string): boolean {
  // Normalize IPv4-mapped IPv6 addresses (::ffff:127.0.0.1 -> 127.0.0.1)
  const normalizedIP = normalizeIP(ip);

  // Check explicit block list
  if (BLOCKED_IPS.includes(normalizedIP)) {
    return true;
  }

  // Parse IPv4 address
  const ipv4Match = normalizedIP.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [, a, b, c, d] = ipv4Match.map(Number);

    // Loopback (127.0.0.0/8)
    if (a === 127) return true;

    // Private Class A (10.0.0.0/8)
    if (a === 10) return true;

    // Private Class B (172.16.0.0/12)
    if (a === 172 && b >= 16 && b <= 31) return true;

    // Private Class C (192.168.0.0/16)
    if (a === 192 && b === 168) return true;

    // Link-local (169.254.0.0/16)
    if (a === 169 && b === 254) return true;

    // Localhost variants
    if (a === 0) return true;

    // Broadcast
    if (a === 255 && b === 255 && c === 255 && d === 255) return true;

    // Reserved (240.0.0.0/4)
    if (a >= 240) return true;
  }

  // Check IPv6 addresses
  if (normalizedIP.includes(':')) {
    const lowerIP = normalizedIP.toLowerCase();

    // Loopback (::1)
    if (lowerIP === '::1') return true;

    // Unspecified (::)
    if (lowerIP === '::') return true;

    // Link-local (fe80::/10)
    if (lowerIP.startsWith('fe80:')) return true;

    // Unique local (fc00::/7)
    if (lowerIP.startsWith('fc') || lowerIP.startsWith('fd')) return true;
  }

  return false;
}

/**
 * Normalize an IP address (handle IPv4-mapped IPv6 in both dotted and hex formats)
 */
function normalizeIP(ip: string): string {
  // Handle bracketed IPv6 first ([::1] -> ::1)
  let normalized = ip;
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }

  // Handle IPv4-mapped IPv6 in dotted form (::ffff:127.0.0.1)
  const ipv4MappedDottedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (ipv4MappedDottedMatch) {
    return ipv4MappedDottedMatch[1];
  }

  // Handle IPv4-mapped IPv6 in hex form (::ffff:7f00:1 -> 127.0.0.1)
  // Format: ::ffff:XXXX:YYYY where XXXX:YYYY is the IPv4 in hex
  const ipv4MappedHexMatch = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (ipv4MappedHexMatch) {
    const high = parseInt(ipv4MappedHexMatch[1], 16);
    const low = parseInt(ipv4MappedHexMatch[2], 16);
    // Convert hex to dotted quad: XXXX -> a.b, YYYY -> c.d
    const a = (high >> 8) & 0xff;
    const b = high & 0xff;
    const c = (low >> 8) & 0xff;
    const d = low & 0xff;
    return `${a}.${b}.${c}.${d}`;
  }

  return normalized;
}

/**
 * Check if a hostname is blocked
 */
function isBlockedHostname(hostname: string): boolean {
  const lowerHostname = hostname.toLowerCase();

  // Check explicit block list
  if (BLOCKED_HOSTNAMES.includes(lowerHostname)) {
    return true;
  }

  // Block localhost variants
  if (lowerHostname === 'localhost' || lowerHostname.endsWith('.localhost')) {
    return true;
  }

  // Block .local domains
  if (lowerHostname.endsWith('.local')) {
    return true;
  }

  // Block .internal domains
  if (lowerHostname.endsWith('.internal')) {
    return true;
  }

  return false;
}

export interface URLValidationResult {
  valid: boolean;
  url?: URL;
  resolvedIPs?: string[];
  error?: string;
}

/**
 * Validate a URL for SSRF safety
 *
 * This function:
 * 1. Parses and validates the URL format
 * 2. Checks for blocked protocols
 * 3. Checks for blocked hostnames
 * 4. Resolves DNS and checks ALL resolved IPs
 *
 * @param urlString - The URL to validate
 * @param options - Validation options
 * @returns Validation result with resolved IPs if valid
 */
export async function validateExternalURL(
  urlString: string,
  options: {
    allowPrivateIPs?: boolean;
    skipDNSCheck?: boolean;
  } = {}
): Promise<URLValidationResult> {
  const { allowPrivateIPs = false, skipDNSCheck = false } = options;

  // Parse URL
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Check protocol
  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    return { valid: false, error: `Protocol not allowed: ${url.protocol}` };
  }

  // Check for blocked hostnames
  if (isBlockedHostname(url.hostname)) {
    return { valid: false, error: `Hostname blocked: ${url.hostname}` };
  }

  // Check if hostname is an IP address
  const isIPAddress = /^[\d.:[\]]+$/.test(url.hostname) ||
    url.hostname.includes(':'); // IPv6

  if (isIPAddress) {
    const ip = normalizeIP(url.hostname);
    if (!allowPrivateIPs && isBlockedIP(ip)) {
      return { valid: false, error: `IP address blocked: ${ip}` };
    }
    return { valid: true, url, resolvedIPs: [ip] };
  }

  // Skip DNS resolution if requested
  if (skipDNSCheck) {
    return { valid: true, url, resolvedIPs: [] };
  }

  // Resolve DNS and check ALL IPs
  try {
    const resolvedIPs = await dns.resolve4(url.hostname).catch(() => [] as string[]);
    const resolvedIPv6 = await dns.resolve6(url.hostname).catch(() => [] as string[]);
    const allIPs = [...resolvedIPs, ...resolvedIPv6];

    if (allIPs.length === 0) {
      return { valid: false, error: 'Could not resolve hostname' };
    }

    // Check ALL resolved IPs (not just the first)
    if (!allowPrivateIPs) {
      for (const ip of allIPs) {
        if (isBlockedIP(ip)) {
          return {
            valid: false,
            error: `Hostname resolves to blocked IP: ${ip}`,
            resolvedIPs: allIPs,
          };
        }
      }
    }

    return { valid: true, url, resolvedIPs: allIPs };
  } catch (error) {
    return {
      valid: false,
      error: `DNS resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Safe fetch wrapper that validates URLs before making requests
 *
 * @param url - The URL to fetch
 * @param options - Fetch options
 * @returns Response from fetch
 * @throws Error if URL validation fails
 */
export async function safeFetch(
  url: string,
  options?: RequestInit & {
    allowPrivateIPs?: boolean;
    skipDNSCheck?: boolean;
  }
): Promise<Response> {
  const { allowPrivateIPs, skipDNSCheck, ...fetchOptions } = options || {};

  const validation = await validateExternalURL(url, {
    allowPrivateIPs,
    skipDNSCheck,
  });

  if (!validation.valid) {
    throw new Error(`SSRF protection: ${validation.error}`);
  }

  // Perform the fetch
  const response = await fetch(url, {
    ...fetchOptions,
    // Prevent automatic redirects to validate each URL
    redirect: 'manual',
  });

  // If redirect, validate the new URL
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location) {
      // Resolve relative URLs
      const redirectUrl = new URL(location, url).toString();
      const redirectValidation = await validateExternalURL(redirectUrl, {
        allowPrivateIPs,
        skipDNSCheck,
      });

      if (!redirectValidation.valid) {
        throw new Error(`SSRF protection: Redirect to blocked URL: ${redirectValidation.error}`);
      }

      // Follow the redirect manually
      return safeFetch(redirectUrl, options);
    }
  }

  return response;
}
