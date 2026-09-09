/**
 * Comprehensive CSS sanitization for canvas pages
 * Goal: Allow creative freedom while blocking data exfiltration and JavaScript execution
 *
 * Security Controls:
 * 1. Blocks external URLs in url() to prevent tracking pixels and data exfiltration
 * 2. Allows data: URIs for inline images and fonts
 * 3. Validates data: URI MIME types (images and fonts only)
 * 4. Blocks JavaScript execution vectors (expression, javascript:, etc.)
 * 5. Blocks external @import statements
 *
 * Preserves:
 * - Gradients (linear, radial, conic)
 * - Animations and transforms
 * - CSS variables
 * - All standard CSS properties
 *
 * Pure string transform: no DOM dependency, safe to run server-side.
 */
export function sanitizeCSS(
  css: string,
  opts?: { allowedHttpsHosts?: string[]; allowAnyHttpsUrl?: boolean },
): string {
  if (!css) return '';

  const allowedHttpsHosts = new Set(
    (opts?.allowedHttpsHosts ?? [])
      .map((host) => normalizeAllowedHttpsHost(host))
      .filter((host): host is string => Boolean(host)),
  );
  // Site mode (`pages.siteMode`): a real website loads stylesheets, webfonts and
  // background images from CDNs it does not enumerate in advance, so host
  // allowlisting is replaced by "any https origin". This widens NETWORK FETCH only
  // — every script-execution vector below stays blocked, because none of them is a
  // website feature and CSP does not cover the legacy ones. Plaintext `http:` stays
  // blocked too, so a site cannot silently downgrade a subresource.
  const allowAnyHttpsUrl = opts?.allowAnyHttpsUrl === true;

  let sanitized = css;

  // Remove JavaScript execution vectors and dangerous URL schemes
  sanitized = sanitized
    .replace(/expression\s*\(/gi, '/* expression blocked */')
    .replace(/-moz-binding\s*:/gi, '/* moz-binding blocked */')
    .replace(/javascript\s*:/gi, '/* javascript blocked */')
    .replace(/vbscript\s*:/gi, '/* vbscript blocked */')
    .replace(/data\s*:\s*text\/html/gi, '/* data:text/html blocked */')
    .replace(/(?<![a-zA-Z-])behavior\s*:/gi, '/* behavior blocked */');

  // Block external @import statements (prevent external stylesheet loading).
  // In site mode an https @import is a first-class website feature — it is how
  // Google Fonts and most webfont services are consumed — so only non-https
  // imports are blocked there.
  const importUrlPattern = allowAnyHttpsUrl
    ? /@import\s+url\s*\(['"]?(?!data:|https:)[^'")]+['"]?\)/gi
    : /@import\s+url\s*\(['"]?(?!data:)[^'")]+['"]?\)/gi;
  const importBarePattern = allowAnyHttpsUrl
    ? /@import\s+['"](?!data:|https:)[^'"]+['"]/gi
    : /@import\s+['"](?!data:)[^'"]+['"]/gi;
  sanitized = sanitized
    .replace(importUrlPattern, '/* @import blocked */')
    .replace(importBarePattern, '/* @import blocked */');

  // Block external URLs in url() functions
  // This prevents tracking pixels, font exfiltration, and other data leakage
  // Pattern: url() with anything except data: URIs
  sanitized = sanitized.replace(
    /url\s*\(\s*(['"]?)(?!data:)([^'")]+)\1\s*\)/gi,
    (match, quote, url) => {
      const trimmed = url.trim();
      if (allowAnyHttpsUrl) {
        try {
          if (new URL(trimmed).protocol === 'https:') return match;
        } catch {
          // Relative and malformed URLs fall through to the default block.
        }
      }
      if (allowedHttpsHosts.size > 0) {
        try {
          const parsed = new URL(trimmed);
          if (parsed.protocol === 'https:' && allowedHttpsHosts.has(parsed.hostname.toLowerCase())) {
            return match;
          }
        } catch {
          // Invalid URLs fall through to the default block.
        }
      }
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[Canvas Security] Blocked external URL: ${url}`);
      }
      return 'url("")';
    }
  );

  // Validate data: URIs to only allow safe MIME types
  // Allowed: image/* and font/*
  // Blocked: text/html, application/javascript, etc.
  sanitized = sanitized.replace(
    /url\s*\(\s*(['"]?)(data:([^'");,]+)([^'")]*?))\1\s*\)/gi,
    (match, quote, dataUrl, mimeType) => {
      const normalizedMime = mimeType.toLowerCase().trim();

      // Allow image and font data URIs
      if (normalizedMime.startsWith('image/') || normalizedMime.startsWith('font/')) {
        return match; // Keep as-is
      }

      // Block potentially dangerous MIME types
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[Canvas Security] Blocked data URI with MIME type: ${normalizedMime}`);
      }
      return 'url("")'; // Replace with empty URL
    }
  );

  return sanitized;
}

function normalizeAllowedHttpsHost(host: string): string | null {
  const trimmed = host.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}
