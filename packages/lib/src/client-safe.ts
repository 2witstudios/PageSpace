/**
 * Client-Safe Exports for @pagespace/lib
 *
 * This module contains only browser-compatible exports with no Node.js dependencies.
 * It's safe to import from client-side React components.
 */

// Enums (always safe for client-side)
export * from './enums';

// Client-safe types (no server dependencies)
export * from './types';

// Browser-safe utilities
export * from './utils';
export * from './tree-utils';

// Page type configurations (safe - no server dependencies)
export * from './page-types.config';
export * from './page-type-validators';

// Sheet utilities (safe - pure JavaScript functions)
export * from './sheet';

// Page content parsing (safe - no server dependencies)
export * from './page-content-parser';

// Browser-safe format bytes utility
export function formatBytes(bytes: number): string {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${Math.round(bytes / Math.pow(1024, i) * 100) / 100} ${sizes[i]}`;
}

// Parse human-readable size to bytes
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

// Client-safe notification types and guards (no database dependencies)
export * from './notifications/types';
export * from './notifications/guards';

// Note: Server-side modules like permissions, auth-utils, logger-config, etc.
// are NOT exported here to prevent Node.js dependencies in browser bundles.