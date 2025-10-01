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
 */
export function sanitizeCSS(css: string): string {
  if (!css) return '';

  let sanitized = css;

  // Remove JavaScript execution vectors
  sanitized = sanitized
    .replace(/expression\s*\(/gi, '/* expression blocked */')
    .replace(/-moz-binding\s*:/gi, '/* moz-binding blocked */')
    .replace(/javascript:/gi, '/* javascript blocked */')
    .replace(/behavior\s*:/gi, '/* behavior blocked */');

  // Block external @import statements (prevent external stylesheet loading)
  sanitized = sanitized
    .replace(/@import\s+url\s*\(['"]?(?!data:)[^'")]+['"]?\)/gi, '/* @import blocked */')
    .replace(/@import\s+['"](?!data:)[^'"]+['"]/gi, '/* @import blocked */');

  // Block external URLs in url() functions
  // This prevents tracking pixels, font exfiltration, and other data leakage
  // Pattern: url() with anything except data: URIs
  sanitized = sanitized.replace(
    /url\s*\(\s*(['"]?)(?!data:)([^'")]+)\1\s*\)/gi,
    (match, quote, url) => {
      // Log blocked URL for monitoring (in development)
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[Canvas Security] Blocked external URL: ${url}`);
      }
      return 'url("")'; // Replace with empty URL
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