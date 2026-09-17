/**
 * GET /api/auth/me decides FULL disclosure by an explicit allow, never by
 * elimination (Phase 2 leaf 1, "Added 2026-09-14" from PR #2619 review).
 *
 * Full identity goes to a browser/app SESSION, or to an OAuth token the
 * consent-bound rule releases it to. Every other principal is denied — so if
 * this route's allow list is ever widened to `mcp` (or a service result reaches
 * it), the identity leak Phase 1a closed cannot reopen through a default branch.
 * The route's allow list is not what is under test: authentication is stubbed
 * to hand the route each principal shape directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: { findUserById: vi.fn() },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: (result: object) => 'error' in result,
}));

import { GET } from '../me/route';
import { authRepository } from '@/lib/repositories/auth-repository';
import { authenticateRequestWithOptions, type AuthResult } from '@/lib/auth';
import { mcpDriveKey, oauthDriveGrant, PARITY_USER_ID } from '@/lib/auth/__tests__/oauth-principal-fixture';

const base = { userId: PARITY_USER_ID, role: 'user' as const, tokenVersion: 0, adminRoleVersion: 0 };

const principals: Record<string, AuthResult> = {
  'an unscoped mcp_ key': { ...mcpDriveKey('drivex'), allowedDriveIds: [] },
  'a drive-scoped mcp_ key': mcpDriveKey('drivex'),
  'a service result': { ...base, tokenType: 'service', service: 'agent-dispatch', allowedDriveIds: [] },
  'a service result carrying an originating mcp token': { ...base, tokenType: 'service', service: 'agent-dispatch', allowedDriveIds: ['drivex'], originatingCeiling: { kind: 'mcp', tokenId: 'mcp-token-row' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authRepository.findUserById).mockResolvedValue({
    id: PARITY_USER_ID, name: 'N', email: 'e@example.com', image: null, role: 'user', provider: 'email', emailVerified: null, subscriptionTier: 'free',
  } as never);
});

describe('GET /api/auth/me — full disclosure is an explicit allow', () => {
  for (const [label, principal] of Object.entries(principals)) {
    it(`denies ${label} without reading the user`, async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(principal);
      const res = await GET(new Request('https://example.com/api/auth/me'));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'insufficient_scope' });
      expect(authRepository.findUserById).not.toHaveBeenCalled();
    });
  }

  it('still gives a session the full profile', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ ...base, tokenType: 'session', sessionId: 's' });
    const res = await GET(new Request('https://example.com/api/auth/me'));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('subscriptionTier', 'free');
  });

  it('still gives a third-party drive grant without profile nothing', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant('drivex'));
    const res = await GET(new Request('https://example.com/api/auth/me'));
    expect(res.status).toBe(403);
  });
});
