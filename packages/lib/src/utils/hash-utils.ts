import { createHash } from 'crypto';

function stableStringify(value: unknown): string {
  // Treat null and undefined the same to avoid hash churn for optional fields.
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);

  return `{${entries.join(',')}}`;
}

export function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashObject(value: unknown): string {
  return hashString(stableStringify(value));
}

export function hashWithPrefix(prefix: string, value: string): string {
  const hasher = createHash('sha256');
  hasher.update(prefix);
  hasher.update('\0');
  hasher.update(value);
  return hasher.digest('hex');
}
