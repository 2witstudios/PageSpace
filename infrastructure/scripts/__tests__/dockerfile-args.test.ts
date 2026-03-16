/**
 * Dockerfile ARG validation tests
 * Ensures build-time variables are configured correctly for multi-tenant reuse.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const dockerfile = readFileSync(
  join(__dirname, '../../../apps/web/Dockerfile'),
  'utf-8'
);

describe('Dockerfile build args', () => {
  it('given the Dockerfile, should have NEXT_PUBLIC_REALTIME_URL ARG with empty default', () => {
    const match = dockerfile.match(/^ARG NEXT_PUBLIC_REALTIME_URL(.*)$/m);
    expect(match).not.toBeNull();
    // Should have an empty default (="" or no value after =)
    expect(match![1]).toMatch(/^="?"?$/);
  });

  it('given the Dockerfile, should NOT have tenant-specific secrets as ARGs', () => {
    const argLines = dockerfile.match(/^ARG .+$/gm) || [];
    const secretPatterns = [
      /DATABASE_URL/,
      /SECRET/,
      /PASSWORD/,
      /PRIVATE_KEY/,
      /API_KEY(?!.*NEXT_PUBLIC)/,
    ];

    for (const arg of argLines) {
      for (const pattern of secretPatterns) {
        expect(arg).not.toMatch(pattern);
      }
    }
  });

  it('given the Dockerfile, should still have NEXT_PUBLIC_APP_URL as a build ARG', () => {
    expect(dockerfile).toMatch(/^ARG NEXT_PUBLIC_APP_URL$/m);
  });

  it('given the Dockerfile, should still have NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB as a build ARG', () => {
    expect(dockerfile).toMatch(/^ARG NEXT_PUBLIC_STORAGE_MAX_FILE_SIZE_MB$/m);
  });
});
