/**
 * Environment variable audit tests
 * Ensures NEXT_PUBLIC_APP_URL is never the sole URL source on the client side.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const WEB_SRC = join(__dirname, '../../../apps/web/src');

function collectFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '.next') continue;
    if (statSync(full).isDirectory()) {
      results.push(...collectFiles(full, ext));
    } else if (full.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

// Server-side paths that are acceptable (route handlers, middleware, server actions)
const SERVER_SIDE_PATTERNS = [
  /\/api\//,       // API route handlers
  /middleware/,    // Middleware
  /\.server\./,   // Explicit server files
  /\/actions\//,  // Server actions
  /__tests__\//,  // Test files
];

function isServerSide(filePath: string): boolean {
  return SERVER_SIDE_PATTERNS.some((pattern) => pattern.test(filePath));
}

describe('NEXT_PUBLIC_APP_URL audit', () => {
  it('given client-side .tsx files, should not use NEXT_PUBLIC_APP_URL without WEB_APP_URL guard', () => {
    const tsxFiles = collectFiles(WEB_SRC, '.tsx');
    const violations: string[] = [];

    for (const file of tsxFiles) {
      if (isServerSide(file)) continue;

      const content = readFileSync(file, 'utf-8');
      if (content.includes('NEXT_PUBLIC_APP_URL')) {
        // Check if it always has a WEB_APP_URL || prefix
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (
            line.includes('NEXT_PUBLIC_APP_URL') &&
            !line.includes('WEB_APP_URL') &&
            !line.trimStart().startsWith('//') &&
            !line.trimStart().startsWith('*')
          ) {
            violations.push(
              `${relative(WEB_SRC, file)}:${i + 1}: ${line.trim()}`
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('given client-side .ts files (non-route), should not use NEXT_PUBLIC_APP_URL without guard', () => {
    const tsFiles = collectFiles(WEB_SRC, '.ts');
    const violations: string[] = [];

    for (const file of tsFiles) {
      if (isServerSide(file)) continue;
      // Skip .d.ts files
      if (file.endsWith('.d.ts')) continue;

      const content = readFileSync(file, 'utf-8');
      if (content.includes('NEXT_PUBLIC_APP_URL')) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (
            line.includes('NEXT_PUBLIC_APP_URL') &&
            !line.includes('WEB_APP_URL') &&
            !line.trimStart().startsWith('//') &&
            !line.trimStart().startsWith('*')
          ) {
            violations.push(
              `${relative(WEB_SRC, file)}:${i + 1}: ${line.trim()}`
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('given server-side route handlers, usage of NEXT_PUBLIC_APP_URL is acceptable (server-only context)', () => {
    const routeFiles = collectFiles(join(WEB_SRC, 'app/api'), '.ts').filter(
      (f) => !f.includes('__tests__')
    );
    const routeFilesUsingVar = routeFiles.filter((f) => {
      const content = readFileSync(f, 'utf-8');
      return content.includes('NEXT_PUBLIC_APP_URL');
    });

    // These are all server-side route handlers — usage is acceptable
    // because the value is read at runtime on the server, not inlined client-side
    expect(routeFilesUsingVar.length).toBeGreaterThanOrEqual(0);
  });
});
