/**
 * Token-prefix single-source-of-truth tests.
 *
 * middleware.ts (Edge runtime) and the Node-side token-auth engine both import
 * the bearer prefixes from the token-prefixes leaf. These tests pin that
 * contract:
 * 1. the leaf exports the exact prefixes the auth layer authenticates,
 * 2. the token-auth engine (request-auth.ts) re-uses the leaf and defines no
 *    prefix literals of its own (no second copy can drift),
 * 3. middleware.ts never imports the Node-only auth graph (the import that
 *    500'd every request when middleware first shipped to production).
 *
 * Note (issue #1393): the `@/lib/auth` barrel has been deleted; prefixes are
 * imported directly from `./token-prefixes` everywhere, so there is no longer a
 * barrel re-export to drift.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import * as leaf from '../token-prefixes';

describe('token-prefixes leaf', () => {
  it('exports the exact prefixes the auth layer authenticates', () => {
    expect(leaf.MCP_TOKEN_PREFIX).toBe('mcp_');
    expect(leaf.SESSION_TOKEN_PREFIX).toBe('ps_sess_');
    expect(leaf.OAUTH_ACCESS_TOKEN_PREFIX).toBe('ps_at_');
  });

  it('has no imports at all — it must stay an edge-safe leaf', () => {
    // Strip comments first — the doc header talks about imports.
    const source = fs
      .readFileSync(path.resolve(__dirname, '../token-prefixes.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/\bimport\b/);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});

describe('token-auth engine single source of truth', () => {
  it('request-auth.ts imports the prefixes from the leaf and defines none of its own', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../request-auth.ts'), 'utf8');
    // Re-uses the leaf (single source of truth).
    expect(source).toMatch(/from ['"]\.\/token-prefixes['"]/);
    // Never redefines the literals (a second copy could silently drift).
    expect(source).not.toMatch(/=\s*'mcp_'/);
    expect(source).not.toMatch(/=\s*'ps_sess_'/);
    expect(source).not.toMatch(/=\s*'ps_at_'/);
  });
});

describe('packages/lib token-lookup drift guard', () => {
  // packages/lib/src/auth/token-lookup.ts keeps its own private copies of the
  // mcp_/ps_at_ prefixes (packages/lib cannot import from apps/web). Nothing
  // at the type level couples them to the leaf, so pin them here: if either
  // side changes a prefix, this fails instead of tokens silently failing to
  // authenticate.
  it('token-lookup.ts private prefix literals match the leaf', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../../../../packages/lib/src/auth/token-lookup.ts'),
      'utf8'
    );
    expect(source).toContain(`const MCP_TOKEN_PREFIX = '${leaf.MCP_TOKEN_PREFIX}'`);
    expect(source).toContain(`const OAUTH_ACCESS_TOKEN_PREFIX = '${leaf.OAUTH_ACCESS_TOKEN_PREFIX}'`);
  });
});

describe('middleware.ts edge-safety (acceptance criterion)', () => {
  it('has zero imports from the @/lib/auth barrel — leaf modules only', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../middleware.ts'), 'utf8');
    // Barrel forms: '@/lib/auth' exactly, or '@/lib/auth/index'
    expect(source).not.toMatch(/from\s+['"]@\/lib\/auth['"]/);
    expect(source).not.toMatch(/from\s+['"]@\/lib\/auth\/index['"]/);
    // And no @pagespace/lib logger (the exact import that 500'd prod)
    expect(source).not.toMatch(/@pagespace\/lib\/logging/);
  });
});
