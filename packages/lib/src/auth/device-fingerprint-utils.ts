import { createHash } from 'crypto';

/**
 * Server-side device fingerprinting utilities for detecting token theft
 * and generating stable device identifiers
 */

/**
 * Parse User-Agent to extract browser family and OS
 * Returns a normalized object for comparison
 */
function parseUserAgent(userAgent: string): { browser: string; os: string } {
  const ua = userAgent.toLowerCase();

  // Extract browser family
  let browser = 'unknown';
  if (ua.includes('firefox')) browser = 'firefox';
  else if (ua.includes('edg')) browser = 'edge';
  else if (ua.includes('chrome')) browser = 'chrome';
  else if (ua.includes('safari')) browser = 'safari';
  else if (ua.includes('opera') || ua.includes('opr')) browser = 'opera';

  // Extract OS
  let os = 'unknown';
  if (ua.includes('windows')) os = 'windows';
  else if (ua.includes('mac os x') || ua.includes('macos')) os = 'macos';
  else if (ua.includes('linux')) os = 'linux';
  else if (ua.includes('android')) os = 'android';
  else if (ua.includes('ios') || ua.includes('iphone') || ua.includes('ipad')) os = 'ios';

  return { browser, os };
}

/**
 * Compare two User-Agent strings based on browser family and OS
 * More lenient than exact string matching to handle browser updates
 */
function compareUserAgents(ua1: string, ua2: string): boolean {
  if (!ua1 || !ua2) return false;

  const parsed1 = parseUserAgent(ua1);
  const parsed2 = parseUserAgent(ua2);

  return parsed1.browser === parsed2.browser && parsed1.os === parsed2.os;
}

export interface DeviceFingerprint {
  deviceId: string;
  userAgent: string;
  ipAddress: string;
  platform: 'web' | 'desktop' | 'ios' | 'android';
  location?: string;
}

/**
 * Extract client IP address from request
 * Handles X-Forwarded-For, X-Real-IP, and direct connection
 */
export function getClientIP(request: Request): string {
  // Check X-Forwarded-For (set by proxies/load balancers)
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    // Take the first IP in the chain
    return forwardedFor.split(',')[0].trim();
  }

  // Check X-Real-IP (set by some proxies)
  const realIP = request.headers.get('x-real-ip');
  if (realIP) {
    return realIP.trim();
  }

  // Fallback to unknown (Next.js doesn't expose socket in edge runtime)
  return 'unknown';
}

/**
 * Detect platform from User-Agent string
 */
export function detectPlatform(userAgent: string): 'web' | 'desktop' | 'ios' | 'android' {
  const ua = userAgent.toLowerCase();

  // Check for Electron (desktop app)
  if (ua.includes('electron')) {
    return 'desktop';
  }

  // Check for iOS
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) {
    return 'ios';
  }

  // Check for Android
  if (ua.includes('android')) {
    return 'android';
  }

  // Default to web
  return 'web';
}

/**
 * Generate a server-side device fingerprint hash
 * This is NOT a substitute for client-side device ID generation,
 * but provides an additional security layer to detect token theft
 */
export function generateServerFingerprint(
  userAgent: string,
  ipAddress: string
): string {
  const fingerprintData = [
    userAgent,
    ipAddress,
  ].join('|');

  return createHash('sha256').update(fingerprintData).digest('hex');
}

/**
 * Validate device fingerprint matches stored values
 * Returns true if fingerprint is valid, false if suspicious
 */
export function validateDeviceFingerprint(
  currentUserAgent: string,
  currentIP: string,
  storedUserAgent: string | null,
  storedLastIP: string | null
): {
  valid: boolean;
  userAgentMatch: boolean;
  ipMatch: boolean;
  suspiciousFactors: string[];
} {
  const suspiciousFactors: string[] = [];
  let userAgentMatch = true;
  let ipMatch = true;

  // Check User-Agent match (compare browser family and OS, not exact string)
  if (storedUserAgent && currentUserAgent && !compareUserAgents(storedUserAgent, currentUserAgent)) {
    userAgentMatch = false;
    suspiciousFactors.push('user_agent_mismatch');
  }

  // Check IP match (allow some flexibility for mobile networks)
  if (storedLastIP && currentIP !== storedLastIP && currentIP !== 'unknown') {
    ipMatch = false;
    suspiciousFactors.push('ip_address_change');
  }

  const valid = suspiciousFactors.length === 0;

  return {
    valid,
    userAgentMatch,
    ipMatch,
    suspiciousFactors,
  };
}

/**
 * Calculate trust score based on device fingerprint validation
 * Trust score ranges from 0.0 (completely untrusted) to 1.0 (fully trusted)
 */
export function calculateTrustScore(
  currentTrustScore: number,
  suspiciousFactors: string[]
): number {
  let newScore = currentTrustScore;

  // Decrease trust score for each suspicious factor
  for (const factor of suspiciousFactors) {
    switch (factor) {
      case 'user_agent_mismatch':
        newScore -= 0.2; // Major indicator of device change/theft
        break;
      case 'ip_address_change':
        newScore -= 0.05; // Minor indicator (users travel, change networks)
        break;
      case 'location_change':
        newScore -= 0.1; // Moderate indicator
        break;
      case 'rapid_refresh':
        newScore -= 0.15; // Potential token theft/automated attack
        break;
      default:
        newScore -= 0.05;
    }
  }

  // Clamp between 0 and 1
  return Math.max(0, Math.min(1, newScore));
}

/**
 * Check if IP addresses are from the same subnet (for relaxed IP validation)
 */
export function isSameSubnet(ip1: string, ip2: string): boolean {
  if (ip1 === ip2) return true;
  if (ip1 === 'unknown' || ip2 === 'unknown') return false;

  // Simple IPv4 /24 subnet check (first 3 octets)
  const ip1Parts = ip1.split('.');
  const ip2Parts = ip2.split('.');

  if (ip1Parts.length !== 4 || ip2Parts.length !== 4) {
    return false; // Not valid IPv4
  }

  // Compare first 3 octets
  return ip1Parts[0] === ip2Parts[0] &&
         ip1Parts[1] === ip2Parts[1] &&
         ip1Parts[2] === ip2Parts[2];
}

/**
 * Detect rapid token refresh attempts (potential token theft)
 */
export function isRapidRefresh(lastUsedAt: Date | null): boolean {
  if (!lastUsedAt) return false;

  const timeSinceLastUse = Date.now() - lastUsedAt.getTime();
  const oneMinute = 60 * 1000;

  // Flag as suspicious if refreshed within 1 minute
  return timeSinceLastUse < oneMinute;
}

/**
 * Extract device metadata from request headers
 */
export function extractDeviceMetadata(request: Request): {
  userAgent: string;
  ipAddress: string;
  platform: 'web' | 'desktop' | 'ios' | 'android';
} {
  const userAgent = request.headers.get('user-agent') || 'unknown';
  const ipAddress = getClientIP(request);
  const platform = detectPlatform(userAgent);

  return {
    userAgent,
    ipAddress,
    platform,
  };
}

/**
 * Generate a default device name based on platform and user agent
 */
export function generateDefaultDeviceName(
  platform: 'web' | 'desktop' | 'ios' | 'android',
  userAgent: string
): string {
  const ua = userAgent.toLowerCase();

  switch (platform) {
    case 'ios':
      if (ua.includes('ipad')) return 'iPad';
      if (ua.includes('iphone')) return 'iPhone';
      return 'iOS Device';

    case 'android':
      if (ua.includes('tablet')) return 'Android Tablet';
      return 'Android Phone';

    case 'desktop':
      if (ua.includes('mac')) return 'Desktop (Mac)';
      if (ua.includes('windows')) return 'Desktop (Windows)';
      if (ua.includes('linux')) return 'Desktop (Linux)';
      return 'Desktop';

    case 'web':
    default:
      if (ua.includes('chrome')) return 'Chrome Browser';
      if (ua.includes('firefox')) return 'Firefox Browser';
      if (ua.includes('safari')) return 'Safari Browser';
      if (ua.includes('edge')) return 'Edge Browser';
      return 'Web Browser';
  }
}

/**
 * Anonymize IP address for privacy (keep first 3 octets for IPv4)
 */
export function anonymizeIP(ip: string): string {
  if (ip === 'unknown') return ip;

  const parts = ip.split('.');
  if (parts.length === 4) {
    // IPv4: Keep first 3 octets
    return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
  }

  // IPv6: Keep first 4 groups
  const ipv6Parts = ip.split(':');
  if (ipv6Parts.length >= 4) {
    return `${ipv6Parts.slice(0, 4).join(':')}:xxxx:xxxx:xxxx:xxxx`;
  }

  return 'unknown';
}
