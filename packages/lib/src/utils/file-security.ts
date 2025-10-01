/**
 * File Security Utilities
 * Handles filename sanitization and MIME type security for file serving endpoints
 */

/**
 * Sanitizes filename for safe use in HTTP headers (Content-Disposition)
 * Prevents: CRLF injection, header injection, XSS
 */
export function sanitizeFilenameForHeader(filename: string | null | undefined): string {
  if (!filename || typeof filename !== 'string') {
    return 'download';
  }

  return filename
    // Remove all control characters (0x00-0x1F including CRLF, 0x7F-0x9F)
    .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
    // Remove quotes that could break header syntax
    .replace(/["'`]/g, '')
    // Remove backslashes
    .replace(/\\/g, '')
    // Remove semicolons (header delimiter)
    .replace(/;/g, '')
    // Replace Unicode spaces with regular space
    .replace(/[\u202F\u00A0\u2000-\u200B\uFEFF]/g, ' ')
    // Normalize multiple spaces
    .replace(/\s+/g, ' ')
    // Trim whitespace
    .trim()
    // Limit length to prevent buffer overflow
    .substring(0, 200)
    // Fallback if empty after sanitization
    || 'download';
}

/**
 * Dangerous MIME types that can execute JavaScript
 */
export const DANGEROUS_MIME_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
] as const;

/**
 * Check if MIME type is dangerous (can execute scripts)
 */
export function isDangerousMimeType(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  const normalized = mimeType.toLowerCase().split(';')[0].trim();
  return DANGEROUS_MIME_TYPES.includes(normalized as any);
}

/**
 * Get Content-Security-Policy header for dangerous file types
 */
export function getCSPHeaderForFile(mimeType: string | null | undefined): string {
  if (isDangerousMimeType(mimeType)) {
    // Strictest CSP: no scripts, no external resources, sandboxed
    return "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox;";
  }
  return "default-src 'none';"; // Still restrictive for other types
}
