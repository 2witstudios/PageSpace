/**
 * Canonical byte formatting and parsing utilities.
 * All formatBytes/parseBytes usages across the monorepo should import from here.
 */

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${Math.round(bytes / Math.pow(1024, i) * 100) / 100} ${SIZE_UNITS[i]}`;
}

export function parseBytes(size: string): number {
  if (!size || typeof size !== 'string') {
    throw new Error(`Invalid size parameter: expected string, got ${typeof size}`);
  }

  const match = size.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) {
    throw new Error(`Invalid size format: ${size}. Expected format like "500MB" or "2GB"`);
  }

  const [, num, unit] = match;
  const bytes = parseFloat(num);

  switch (unit.toUpperCase()) {
    case 'B': return bytes;
    case 'KB': return bytes * 1024;
    case 'MB': return bytes * 1024 * 1024;
    case 'GB': return bytes * 1024 * 1024 * 1024;
    case 'TB': return bytes * 1024 * 1024 * 1024 * 1024;
    default: throw new Error(`Unsupported size unit: ${unit}`);
  }
}
