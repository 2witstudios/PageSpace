/**
 * ADR 0004 Decision 11 — the SDK owns the token-endpoint helpers; the CLI
 * imports them. One implementation of the wire protocol: the CLI modules
 * that used to hand-roll discovery, the code exchange, the token-response
 * shapes, the refresh grant and revocation are now adapters over
 * `@pagespace/sdk` that keep the CLI's own result/error types. This guard
 * fails if any of them grows its own `fetch` call or its own wire schema
 * again, and if identity stops going through the SDK's `auth.me`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AUTH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const ADAPTERS = ['discover.ts', 'exchange-code.ts', 'token-response.ts', 'silent-refresh.ts', 'revoke-token.ts'] as const;

function source(file: string): string {
  return readFileSync(join(AUTH_DIR, file), 'utf-8');
}

describe('the CLI token-endpoint helpers are adapters over @pagespace/sdk', () => {
  it.each(ADAPTERS)('%s imports its implementation from @pagespace/sdk', (file) => {
    expect(source(file)).toMatch(/from '@pagespace\/sdk'/);
  });

  it.each(ADAPTERS)('%s makes no network call of its own', (file) => {
    expect(source(file)).not.toMatch(/fetchImpl\s*\(/);
  });

  it.each(ADAPTERS)('%s declares no wire schema of its own', (file) => {
    expect(source(file)).not.toMatch(/z\.(object|discriminatedUnion)\s*\(/);
  });

  it('confirm-identity asks who the user is through the SDK facade (client.auth.me), not a private operation', () => {
    const text = source('confirm-identity.ts');
    expect(text).toMatch(/\.auth\.me\(/);
    expect(text).not.toMatch(/client\.invoke\(/);
  });
});
