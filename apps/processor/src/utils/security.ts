import path from 'path';

export const SAFE_EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/i;
export const DEFAULT_EXTENSION = '.bin';
export const DEFAULT_IMAGE_EXTENSION = '.png';
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

function withTrailingSeparator(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

export function sanitizeExtension(
  filename: string | undefined | null,
  fallback: string = DEFAULT_EXTENSION
): string {
  if (!filename || typeof filename !== 'string') {
    return fallback;
  }

  const ext = path.extname(filename).toLowerCase();
  if (!ext) {
    return fallback;
  }

  const extBody = ext.slice(1);
  if (!SAFE_EXTENSION_PATTERN.test(extBody)) {
    return fallback;
  }

  return `.${extBody}`;
}

export function resolvePathWithin(baseDir: string, ...segments: string[]): string | null {
  if (!baseDir) {
    return null;
  }

  const normalizedBase = path.resolve(baseDir);
  const targetPath = path.resolve(normalizedBase, ...segments);
  const expectedPrefix = withTrailingSeparator(normalizedBase);

  if (targetPath === normalizedBase && segments.length === 0) {
    return normalizedBase;
  }

  if (!targetPath.startsWith(expectedPrefix)) {
    return null;
  }

  return targetPath;
}

export function normalizeIdentifier(
  value: unknown,
  pattern: RegExp = IDENTIFIER_PATTERN
): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!pattern.test(trimmed)) {
    return null;
  }

  return trimmed;
}

/**
 * Sanitizes filename for safe use in HTTP headers (Content-Disposition)
 * Prevents: CRLF injection, header injection, XSS
 */
export function sanitizeFilename(filename: string | null | undefined): string {
  if (!filename || typeof filename !== 'string') {
    return 'file';
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
    || 'file';
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
