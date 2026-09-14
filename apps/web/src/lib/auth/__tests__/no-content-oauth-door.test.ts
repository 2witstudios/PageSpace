/**
 * A content route's door refuses OAuth credentials that carry NO content access
 * (Phase 2, leaf 1 "profile short-circuit").
 *
 * Identity-only (`profile`) and key-management-only (`manage_keys`) tokens
 * already resolve to "no drives" in every scope helper. That is not enough once
 * `oauth` is admitted by ~90 content routes: some decisions there are
 * IDENTITY-bound, not drive-bound (a personal calendar event the user created,
 * for instance), and never consult a scope helper at all. So these shapes are
 * refused where they authenticate — normalized at the door rather than
 * remembered in every route. A content route is one that admits `mcp` (the
 * parity guard makes every such route admit `oauth` too); routes admitting
 * `oauth` without `mcp` answer about the identity or its keys and still serve
 * these credentials, as does a content route that opts in (`admitNoContentOAuth`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: { validateSession: vi.fn(), validateSessionWithReason: vi.fn() },
}));
vi.mock('@pagespace/lib/auth/token-lookup', () => ({ findOAuthAccessTokenByValue: vi.fn() }));
vi.mock('@pagespace/lib/permissions/enforced-context', () => ({
  EnforcedAuthContext: class EnforcedAuthContext {},
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ logSecurityEvent: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { mcpTokens: { findFirst: vi.fn() } },
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
  },
}));

import { authenticateRequestWithOptions, isAuthError } from '../index';
import { findOAuthAccessTokenByValue } from '@pagespace/lib/auth/token-lookup';

function tokenRow(scopes: string[]) {
  return {
    id: 'oauth-token-id',
    userId: 'user-1',
    scopes,
    tokenVersion: 0,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    revokedAt: null,
    user: { id: 'user-1', role: 'user', tokenVersion: 0, adminRoleVersion: 0, suspendedAt: null },
    client: { clientId: 'some-third-party-app', disabledAt: null },
  };
}

const bearer = () => new Request('https://example.com/api/x', { headers: { Authorization: 'Bearer ps_at_token' } });
// Admits `mcp`, so a content route.
const CONTENT_ROUTE = { allow: ['session', 'mcp', 'oauth'] as const };
// Admits `oauth` without `mcp`: answers about the identity or its keys (`/api/auth/me`).
const IDENTITY_ROUTE = { allow: ['session', 'oauth'] as const };
// A content-admitting route that also serves those credentials (`GET /api/drives` for the keys wizard).
const OPTED_IN_CONTENT_ROUTE = { allow: ['session', 'mcp', 'oauth'] as const, admitNoContentOAuth: true };

beforeEach(() => vi.clearAllMocks());

describe('authenticateRequestWithOptions — OAuth credentials with no content access', () => {
  it('refuses a profile-only token on a content route with the identity-only 403', async () => {
    vi.mocked(findOAuthAccessTokenByValue).mockResolvedValue(tokenRow(['profile']) as never);
    const result = await authenticateRequestWithOptions(bearer(), CONTENT_ROUTE);
    expect(isAuthError(result)).toBe(true);
    if (!isAuthError(result)) return;
    expect(result.error.status).toBe(403);
    expect(await result.error.json()).toEqual({ error: 'This credential is identity-only and has no drive content access' });
  });

  it('refuses a profile + offline_access token on a content route', async () => {
    vi.mocked(findOAuthAccessTokenByValue).mockResolvedValue(tokenRow(['profile', 'offline_access']) as never);
    const result = await authenticateRequestWithOptions(bearer(), CONTENT_ROUTE);
    expect(isAuthError(result) && result.error.status).toBe(403);
  });

  it('refuses a manage_keys-only token on a content route with the management-only 403', async () => {
    vi.mocked(findOAuthAccessTokenByValue).mockResolvedValue(tokenRow(['manage_keys']) as never);
    const result = await authenticateRequestWithOptions(bearer(), CONTENT_ROUTE);
    expect(isAuthError(result)).toBe(true);
    if (!isAuthError(result)) return;
    expect(result.error.status).toBe(403);
    expect(await result.error.json()).toEqual({ error: 'This credential is management-only and has no drive content access' });
  });

  it('admits a drive grant (even one that also carries profile) on a content route', async () => {
    vi.mocked(findOAuthAccessTokenByValue).mockResolvedValue(tokenRow(['profile', 'drive:drivex:member']) as never);
    const result = await authenticateRequestWithOptions(bearer(), CONTENT_ROUTE);
    expect(isAuthError(result)).toBe(false);
  });

  it('admits profile-only and manage_keys-only tokens on an identity route (oauth without mcp)', async () => {
    for (const scopes of [['profile'], ['manage_keys']]) {
      vi.mocked(findOAuthAccessTokenByValue).mockResolvedValue(tokenRow(scopes) as never);
      const result = await authenticateRequestWithOptions(bearer(), IDENTITY_ROUTE);
      expect(isAuthError(result)).toBe(false);
    }
  });

  it('admits them on a content-admitting route only when it opts in', async () => {
    for (const scopes of [['profile'], ['manage_keys']]) {
      vi.mocked(findOAuthAccessTokenByValue).mockResolvedValue(tokenRow(scopes) as never);
      const result = await authenticateRequestWithOptions(bearer(), OPTED_IN_CONTENT_ROUTE);
      expect(isAuthError(result)).toBe(false);
    }
  });
});
