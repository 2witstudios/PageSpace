/**
 * GET /api/auth/me for OAuth tokens (point guard ruling on Phase 1a, ADR 0004
 * Decisions 4 and 8): identity is consent-bound. A first-party client (the
 * CLI) keeps the full profile; a third-party app gets identity only when the
 * user approved `profile`, and then ONLY the fields that consent narrates —
 * "See your name, email, and avatar."
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '../me/route';
import type { User } from '@/lib/repositories/auth-repository';
import { parseScopeList, scopeSetToDriveScopes } from '@pagespace/lib/auth/oauth/scopes';

vi.mock('@/lib/repositories/auth-repository', () => ({ authRepository: { findUserById: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn(() => false) }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { authRepository } from '@/lib/repositories/auth-repository';
import { authenticateRequestWithOptions } from '@/lib/auth';

const USER = {
  id: 'user-1',
  name: 'Maya',
  email: 'maya@example.test',
  image: '/avatars/maya.png',
  role: 'admin',
  emailVerified: new Date('2026-01-01T00:00:00Z'),
  subscriptionTier: 'pro',
} as unknown as User;

function oauth(raw: string, clientFirstParty: boolean) {
  const parsed = parseScopeList(raw);
  if (!parsed.ok) throw new Error(raw);
  const driveScopes = scopeSetToDriveScopes(parsed.scopes);
  return {
    tokenType: 'oauth',
    userId: 'user-1',
    role: 'admin',
    tokenVersion: 0,
    adminRoleVersion: 0,
    tokenId: 'at-1',
    scopes: parsed.scopes,
    driveScopes,
    allowedDriveIds: driveScopes.map((d) => d.driveId),
    clientFirstParty,
  };
}

const request = () => new Request('http://localhost/api/auth/me', { headers: { authorization: 'Bearer ps_at_x' } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authRepository.findUserById).mockResolvedValue(USER);
});

describe('GET /api/auth/me — OAuth identity is consent-bound', () => {
  it('refuses a third-party drive:X:member token without profile with a constant-shape 403, never reading the user', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauth('drive:abc123:member offline_access', false) as never);

    const res = await GET(request());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'insufficient_scope' });
    expect(authRepository.findUserById).not.toHaveBeenCalled();
  });

  it('returns exactly { id, name, email, image } to a third-party profile token — no role, emailVerified or subscriptionTier', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauth('profile drive:abc123:member', false) as never);

    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ id: 'user-1', name: 'Maya', email: 'maya@example.test', image: '/avatars/maya.png' });
  });

  it('keeps the full body for a first-party manage_keys token (pagespace login / whoami)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauth('manage_keys offline_access', true) as never);

    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: 'user-1',
      name: 'Maya',
      email: 'maya@example.test',
      role: 'admin',
      subscriptionTier: 'pro',
      emailVerified: '2026-01-01T00:00:00.000Z',
    });
  });
});
