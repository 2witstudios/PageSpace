/**
 * Token-prefix single-source-of-truth tests.
 *
 * middleware.ts (Edge runtime) imports the bearer prefixes from the
 * token-prefixes leaf; the '@/lib/auth' barrel re-exports the same values for
 * Node-side consumers. These tests pin both halves of that contract:
 * 1. the leaf exports the exact prefixes the auth layer authenticates,
 * 2. the barrel's re-exports are identical (no second copy can drift),
 * 3. middleware.ts never imports the Node-only barrel (the import graph that
 *    500'd every request when middleware first shipped to production).
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// --- Mocks so the real barrel (Node-only import graph) can load in a unit test.
vi.mock('next/server', () => ({
  NextResponse: { json: vi.fn(), redirect: vi.fn(), rewrite: vi.fn(), next: vi.fn() },
}));
vi.mock('@pagespace/db/db', () => ({
  db: { query: {}, insert: vi.fn(), update: vi.fn() },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(), and: vi.fn(), isNull: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ mcpTokens: {} }));
vi.mock('@pagespace/db/schema/oauth', () => ({ oauthAccessTokens: {} }));
vi.mock('@pagespace/lib/auth/token-utils', () => ({ hashToken: vi.fn() }));
vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: { validateSession: vi.fn() },
}));
vi.mock('@pagespace/lib/auth/token-lookup', () => ({ findOAuthAccessTokenByValue: vi.fn() }));
vi.mock('@pagespace/lib/permissions/enforced-context', () => ({
  EnforcedAuthContext: { fromSession: vi.fn() },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ logSecurityEvent: vi.fn() }));
vi.mock('../cookie-config', () => ({
  getSessionFromCookies: vi.fn(),
  COOKIE_CONFIG: {},
  createSessionCookie: vi.fn(),
  createClearSessionCookie: vi.fn(),
  createLoggedInIndicatorCookie: vi.fn(),
  createClearLoggedInIndicatorCookie: vi.fn(),
  appendSessionCookie: vi.fn(),
  appendClearCookies: vi.fn(),
}));

import * as leaf from '../token-prefixes';
import * as barrel from '../index';

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

describe('@/lib/auth barrel re-export integrity', () => {
  it('re-exports the identical leaf values (single source of truth, no drift possible)', () => {
    expect(barrel.MCP_TOKEN_PREFIX).toBe(leaf.MCP_TOKEN_PREFIX);
    expect(barrel.SESSION_TOKEN_PREFIX).toBe(leaf.SESSION_TOKEN_PREFIX);
    expect(barrel.OAUTH_ACCESS_TOKEN_PREFIX).toBe(leaf.OAUTH_ACCESS_TOKEN_PREFIX);
  });

  it('defines no prefix literals of its own in index.ts', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8');
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
