/**
 * Generate a stable browser fingerprint for device identification
 * This uses a combination of browser characteristics to create a unique device ID
 */
export function generateBrowserFingerprint(): string {
  if (typeof window === 'undefined') {
    // Server-side - return a placeholder
    return 'server-side-render';
  }

  const components: string[] = [];

  // User agent
  components.push(navigator.userAgent || 'unknown-ua');

  // Screen resolution
  components.push(`${screen.width}x${screen.height}x${screen.colorDepth}`);

  // Timezone offset
  components.push(new Date().getTimezoneOffset().toString());

  // Language
  components.push(navigator.language || 'unknown-lang');

  // Platform
  components.push(navigator.platform || 'unknown-platform');

  // Hardware concurrency (CPU cores)
  components.push((navigator.hardwareConcurrency || 0).toString());

  // Combine and hash
  const combined = components.join('|');

  // Simple hash function (FNV-1a)
  let hash = 2166136261;
  for (let i = 0; i < combined.length; i++) {
    hash ^= combined.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return `web_${(hash >>> 0).toString(36)}`;
}

/**
 * Get or create a persistent device ID for the browser
 * Stores in localStorage for consistency across sessions
 */
export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') {
    return 'server-side-render';
  }

  const STORAGE_KEY = 'browser_device_id';

  // Try to get existing device ID
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) {
      return existing;
    }
  } catch (error) {
    // localStorage might be unavailable (private browsing, etc.)
    console.warn('Failed to access localStorage for device ID:', error);
  }

  // Generate new device ID
  const deviceId = generateBrowserFingerprint();

  // Try to store it
  try {
    localStorage.setItem(STORAGE_KEY, deviceId);
  } catch (error) {
    console.warn('Failed to store device ID in localStorage:', error);
  }

  return deviceId;
}

/**
 * Get browser/device name for display
 */
export function getDeviceName(): string {
  if (typeof window === 'undefined') {
    return 'Server';
  }

  const ua = navigator.userAgent;

  // Detect browser
  let browser = 'Unknown Browser';
  if (ua.includes('Firefox/')) {
    browser = 'Firefox';
  } else if (ua.includes('Edg/')) {
    browser = 'Edge';
  } else if (ua.includes('Chrome/') && !ua.includes('Edg/')) {
    browser = 'Chrome';
  } else if (ua.includes('Safari/') && !ua.includes('Chrome/')) {
    browser = 'Safari';
  }

  // Detect OS
  let os = 'Unknown OS';
  if (ua.includes('Win')) {
    os = 'Windows';
  } else if (ua.includes('Mac')) {
    os = 'macOS';
  } else if (ua.includes('Linux')) {
    os = 'Linux';
  } else if (ua.includes('Android')) {
    os = 'Android';
  } else if (ua.includes('iOS') || ua.includes('iPhone') || ua.includes('iPad')) {
    os = 'iOS';
  }

  return `${browser} on ${os}`;
}
