/**
 * Unit tests for the pure token-auth decision functions (issue #1393).
 *
 * `decideMcpAuth` / `decideOAuthAuth` are the functional core extracted from
 * the old inline engine: given a fetched token record (and, for OAuth, an
 * injected clock), they classify the request into the action the imperative
 * shell must take — WITHOUT any I/O. That purity is what lets every fail-closed
 * branch be exercised deterministically here, with no database or mocks.
 */
import { describe, it, expect } from 'vitest';
import { decideMcpAuth, decideOAuthAuth } from '../auth-core';
import type { McpTokenAuthRecord } from '../auth-core';
import type { OAuthAccessTokenRecord } from '@pagespace/lib/auth/token-lookup';

const NOW = 1_700_000_000_000;

function mcpRecord(overrides: Partial<McpTokenAuthRecord> = {}): McpTokenAuthRecord {
  return {
    id: 'tok_mcp_1',
    userId: 'user_1',
    isScoped: false,
    user: { role: 'user', tokenVersion: 3, adminRoleVersion: 0, suspendedAt: null },
    driveScopes: [],
    ...overrides,
  };
}

function oauthRecord(overrides: Partial<OAuthAccessTokenRecord> = {}): OAuthAccessTokenRecord {
  return {
    id: 'tok_oauth_1',
    userId: 'user_1',
    scopes: ['account'],
    tokenVersion: 5,
    expiresAt: new Date(NOW + 60_000),
    revokedAt: null,
    user: { id: 'user_1', role: 'user', tokenVersion: 5, adminRoleVersion: 0, suspendedAt: null },
    ...overrides,
  };
}

describe('decideMcpAuth (pure)', () => {
  it('given no record, returns not-found (no side effect)', () => {
    expect(decideMcpAuth(null)).toEqual({ kind: 'not-found' });
  });

  it('given a record whose user relation is null, returns not-found', () => {
    expect(decideMcpAuth(mcpRecord({ user: null }))).toEqual({ kind: 'not-found' });
  });

  it('given a suspended user, returns suspended (shell revokes + denies)', () => {
    const record = mcpRecord({ user: { role: 'user', tokenVersion: 3, adminRoleVersion: 0, suspendedAt: new Date(NOW) } });
    expect(decideMcpAuth(record)).toEqual({ kind: 'suspended' });
  });

  it('given a scoped token whose drives are all gone, fails closed with scoped-no-drives', () => {
    expect(decideMcpAuth(mcpRecord({ isScoped: true, driveScopes: [] }))).toEqual({ kind: 'scoped-no-drives' });
  });

  it('given an unscoped token with no drives, resolves ok with empty allowedDriveIds (full access)', () => {
    const decision = decideMcpAuth(mcpRecord({ isScoped: false, driveScopes: [] }));
    expect(decision.kind).toBe('ok');
    if (decision.kind !== 'ok') throw new Error('unreachable');
    expect(decision.details.allowedDriveIds).toEqual([]);
  });

  it('given a scoped token with drives, resolves ok with exactly those drive ids and mapped fields', () => {
    const record = mcpRecord({
      id: 'tok_mcp_x',
      userId: 'user_9',
      isScoped: true,
      user: { role: 'admin', tokenVersion: 7, adminRoleVersion: 2, suspendedAt: null },
      driveScopes: [{ driveId: 'd1' }, { driveId: 'd2' }],
    });
    const decision = decideMcpAuth(record);
    expect(decision).toEqual({
      kind: 'ok',
      details: {
        userId: 'user_9',
        role: 'admin',
        tokenVersion: 7,
        adminRoleVersion: 2,
        tokenId: 'tok_mcp_x',
        allowedDriveIds: ['d1', 'd2'],
      },
    });
  });
});

describe('decideOAuthAuth (pure, clock injected)', () => {
  it('given no record, rejects', () => {
    expect(decideOAuthAuth(null, NOW)).toEqual({ kind: 'reject' });
  });

  it('given a suspended user, returns suspended (shell revokes + denies)', () => {
    const record = oauthRecord({ user: { id: 'user_1', role: 'user', tokenVersion: 5, adminRoleVersion: 0, suspendedAt: new Date(NOW) } });
    expect(decideOAuthAuth(record, NOW)).toEqual({ kind: 'suspended' });
  });

  it('given an expired token (expiresAt <= now), rejects', () => {
    expect(decideOAuthAuth(oauthRecord({ expiresAt: new Date(NOW) }), NOW)).toEqual({ kind: 'reject' });
    expect(decideOAuthAuth(oauthRecord({ expiresAt: new Date(NOW - 1) }), NOW)).toEqual({ kind: 'reject' });
  });

  it('given a stale token (record.tokenVersion !== user.tokenVersion), rejects', () => {
    const record = oauthRecord({ tokenVersion: 4, user: { id: 'user_1', role: 'user', tokenVersion: 5, adminRoleVersion: 0, suspendedAt: null } });
    expect(decideOAuthAuth(record, NOW)).toEqual({ kind: 'reject' });
  });

  it('given unparseable stored scopes, fails closed with reject', () => {
    expect(decideOAuthAuth(oauthRecord({ scopes: ['not a valid scope!'] }), NOW)).toEqual({ kind: 'reject' });
    expect(decideOAuthAuth(oauthRecord({ scopes: [] }), NOW)).toEqual({ kind: 'reject' });
  });

  it('given an all_drives bearer scope, rejects (must resolve as an unscoped mcp row, never a bearer token)', () => {
    expect(decideOAuthAuth(oauthRecord({ scopes: ['all_drives'] }), NOW)).toEqual({ kind: 'reject' });
  });

  it('given an update_key grant, rejects (one-shot consent ceremony, never a bearer scope)', () => {
    expect(decideOAuthAuth(oauthRecord({ scopes: ['update_key:tok1', 'drive:d1'] }), NOW)).toEqual({ kind: 'reject' });
  });

  it('given an activate_key grant, rejects (approval ceremony, never a bearer scope)', () => {
    expect(decideOAuthAuth(oauthRecord({ scopes: ['activate_key:tok1'] }), NOW)).toEqual({ kind: 'reject' });
  });

  it('given an account scope, resolves ok with empty allowedDriveIds (full-user access)', () => {
    const decision = decideOAuthAuth(oauthRecord({ scopes: ['account'] }), NOW);
    expect(decision.kind).toBe('ok');
    if (decision.kind !== 'ok') throw new Error('unreachable');
    expect(decision.details.allowedDriveIds).toEqual([]);
    expect(decision.details.scopes.account).toBe(true);
  });

  it('given drive-scoped scopes, resolves ok with exactly those drive ids and shell-mapped fields', () => {
    const record = oauthRecord({
      id: 'tok_oauth_x',
      userId: 'user_9',
      scopes: ['drive:d1', 'drive:d2'],
      tokenVersion: 5,
      user: { id: 'user_9', role: 'admin', tokenVersion: 5, adminRoleVersion: 4, suspendedAt: null },
    });
    const decision = decideOAuthAuth(record, NOW);
    expect(decision.kind).toBe('ok');
    if (decision.kind !== 'ok') throw new Error('unreachable');
    expect(decision.details.allowedDriveIds.sort()).toEqual(['d1', 'd2']);
    expect(decision.details.scopes.account).toBe(false);
    expect(decision.details).toMatchObject({
      userId: 'user_9',
      role: 'admin',
      tokenVersion: 5,
      adminRoleVersion: 4,
      tokenId: 'tok_oauth_x',
    });
  });
});
