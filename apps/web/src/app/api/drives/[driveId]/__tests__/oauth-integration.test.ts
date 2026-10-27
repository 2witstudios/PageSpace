/**
 * OAuth access-token integration test (task qyqgrjbvntpsdh578k0yiwgr) —
 * proves the FULL authenticateRequest chain end to end against a real
 * protected route: `@/lib/auth` is NOT mocked here (unlike
 * `route.test.ts`'s contract tests), only its DB/session edges are, so this
 * exercises the real hash lookup, expiry/revocation/suspension checks, and
 * `checkMCPDriveScope` drive-scope gating for an OAuth access token exactly
 * as production would.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: { validateSession: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@pagespace/lib/permissions/enforced-context', () => ({
  EnforcedAuthContext: class EnforcedAuthContext {
    static fromSession(sessionClaims: unknown): unknown {
      return sessionClaims;
    }
  },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  logSecurityEvent: vi.fn(),
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

const mcpTokensFindFirst = vi.fn();
const oauthAccessTokensFindFirst = vi.fn();
const dbUpdateSet = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      mcpTokens: { findFirst: (...args: unknown[]) => mcpTokensFindFirst(...args) },
    },
    update: vi.fn().mockReturnValue({
      set: (...args: unknown[]) => {
        dbUpdateSet(...args);
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ field, value })),
  and: vi.fn((...conditions) => conditions),
  isNull: vi.fn((field) => ({ field, isNull: true })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({ mcpTokens: {} }));
vi.mock('@pagespace/db/schema/oauth', () => ({ oauthAccessTokens: {} }));
vi.mock('@pagespace/lib/auth/token-lookup', () => ({
  findOAuthAccessTokenByValue: (...args: unknown[]) => oauthAccessTokensFindFirst(...args),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveById: vi.fn(),
  getDriveWithAccess: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));
vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn().mockResolvedValue(undefined),
  createDriveEventPayload: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppDriveMembership: vi.fn(),
  getAppDriveAccessLevel: vi.fn(),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({}),
  logDriveActivity: vi.fn(),
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue([]),
}));

import { GET } from '../route';
import { getDriveById, getDriveWithAccess } from '@pagespace/lib/services/drive-service';
import { logSecurityEvent } from '@pagespace/lib/logging/logger-config';

const USER_ID = 'test-user-id';
const IN_SCOPE_DRIVE = 'driveinscope1';
const OUT_OF_SCOPE_DRIVE = 'driveoutofscope1';

function oauthRequest(driveId: string, token: string): { request: Request; context: { params: Promise<{ driveId: string }> } } {
  return {
    request: new Request(`http://localhost/api/drives/${driveId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }),
    context: { params: Promise.resolve({ driveId }) },
  };
}

function baseOAuthTokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'oauth-token-1',
    userId: USER_ID,
    scopes: [`drive:${IN_SCOPE_DRIVE}`],
    tokenVersion: 0,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    revokedAt: null,
    user: { id: USER_ID, role: 'user', tokenVersion: 0, adminRoleVersion: 0, suspendedAt: null },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mcpTokensFindFirst.mockResolvedValue(null);
  vi.mocked(getDriveById).mockResolvedValue({ id: IN_SCOPE_DRIVE } as never);
  vi.mocked(getDriveWithAccess).mockResolvedValue({ id: IN_SCOPE_DRIVE, name: 'Drive' } as never);
});

describe('GET /api/drives/[driveId] — OAuth access-token integration', () => {
  it('accepts a valid OAuth access token scoped to this drive (in-scope → 200)', async () => {
    oauthAccessTokensFindFirst.mockResolvedValue(baseOAuthTokenRow());

    const { request, context } = oauthRequest(IN_SCOPE_DRIVE, 'ps_at_' + 'a'.repeat(43));
    const res = await GET(request, context);

    expect(res.status).toBe(200);
  });

  it('rejects the same token for an out-of-scope drive — scope narrowing bites (403)', async () => {
    oauthAccessTokensFindFirst.mockResolvedValue(baseOAuthTokenRow());

    const { request, context } = oauthRequest(OUT_OF_SCOPE_DRIVE, 'ps_at_' + 'a'.repeat(43));
    const res = await GET(request, context);

    expect(res.status).toBe(403);
  });

  it('accepts an account-scoped OAuth token for ANY drive (full-user credential parity)', async () => {
    oauthAccessTokensFindFirst.mockResolvedValue(baseOAuthTokenRow({ scopes: ['account'] }));

    const { request, context } = oauthRequest(OUT_OF_SCOPE_DRIVE, 'ps_at_' + 'b'.repeat(43));
    const res = await GET(request, context);

    expect(res.status).toBe(200);
  });

  it('rejects an expired OAuth access token (401)', async () => {
    oauthAccessTokensFindFirst.mockResolvedValue(
      baseOAuthTokenRow({ expiresAt: new Date(Date.now() - 1000) }),
    );

    const { request, context } = oauthRequest(IN_SCOPE_DRIVE, 'ps_at_' + 'c'.repeat(43));
    const res = await GET(request, context);

    expect(res.status).toBe(401);
  });

  it('rejects a revoked/unknown OAuth access token — indistinguishable from expired (401)', async () => {
    oauthAccessTokensFindFirst.mockResolvedValue(null);

    const { request, context } = oauthRequest(IN_SCOPE_DRIVE, 'ps_at_' + 'd'.repeat(43));
    const res = await GET(request, context);

    expect(res.status).toBe(401);
  });

  it('rejects an OAuth access token belonging to a suspended user, and revokes it on sight (401)', async () => {
    oauthAccessTokensFindFirst.mockResolvedValue(
      baseOAuthTokenRow({ user: { id: USER_ID, role: 'user', tokenVersion: 0, adminRoleVersion: 0, suspendedAt: new Date() } }),
    );

    const { request, context } = oauthRequest(IN_SCOPE_DRIVE, 'ps_at_' + 'e'.repeat(43));
    const res = await GET(request, context);

    expect(res.status).toBe(401);
    expect(dbUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ revokedAt: expect.any(Date) }));
    expect(logSecurityEvent).toHaveBeenCalledWith(
      'unauthorized',
      expect.objectContaining({ reason: 'oauth_token_user_suspended' }),
    );
  });
});
