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
