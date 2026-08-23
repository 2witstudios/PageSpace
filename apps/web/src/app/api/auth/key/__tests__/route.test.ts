/**
 * Contract tests for GET /api/auth/key — the credential self-description
 * behind `pagespace keys describe` (issue #2470).
 *
 * Two things this route has to get right, and both are asserted here:
 *
 * - It admits the `mcp_` class the key-MANAGEMENT routes refuse, because a key
 *   asking about itself is not the same authority as a key enumerating every
 *   key its owner holds.
 * - It reports permissions that come from the resolver real requests are
 *   authorized by, never a second reading of the role vocabulary. The
 *   dispatcher is mocked here (this is a route test), so what is asserted is
 *   that the route DELEGATES rather than deciding — a route that computed its
 *   own answer would pass this only by reimplementing the mock.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/repositories/session-repository', () => ({
  sessionRepository: {
    findMcpTokenSelfById: vi.fn(),
    findDrivesByIds: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/auth/principal-permissions', () => ({
  getPrincipalAccessLevel: vi.fn(),
  getPrincipalDriveAccessLevel: vi.fn(),
  getPrincipalDriveIds: vi.fn(),
  getPrincipalDriveMembership: vi.fn(),
  isDriveScopedPrincipal: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-role-service', () => ({
  getRoleById: vi.fn(),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { auth: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } },
}));

import { GET } from '../route';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  getPrincipalAccessLevel,
  getPrincipalDriveAccessLevel,
  getPrincipalDriveIds,
  getPrincipalDriveMembership,
  isDriveScopedPrincipal,
} from '@/lib/auth/principal-permissions';
import { getRoleById } from '@pagespace/lib/services/drive-role-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const SCOPED_KEY = {
  userId: 'user-1',
  role: 'user',
  tokenVersion: 0,
  adminRoleVersion: 0,
  tokenType: 'mcp',
  tokenId: 'key-1',
  allowedDriveIds: ['drv1'],
};

const KEY_ROW = {
  id: 'key-1',
  name: 'lead-gen agent',
  tokenPrefix: 'mcp_abcdefghijk',
  createdAt: new Date('2026-08-22T00:00:00.000Z'),
  lastUsed: new Date('2026-08-22T10:00:00.000Z'),
  isScoped: true,
};

const MEMBER_LEVEL = { canView: true, canEdit: false, canShare: false, canDelete: false };

function request(pageId?: string): NextRequest {
  return new NextRequest(`http://localhost/api/auth/key${pageId === undefined ? '' : `?pageId=${pageId}`}`);
}

function arrangeScopedMemberKey() {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(SCOPED_KEY as never);
  vi.mocked(isAuthError).mockReturnValue(false);
  vi.mocked(isDriveScopedPrincipal).mockReturnValue(true);
  vi.mocked(sessionRepository.findMcpTokenSelfById).mockResolvedValue(KEY_ROW as never);
  vi.mocked(getPrincipalDriveIds).mockResolvedValue(['drv1']);
  vi.mocked(sessionRepository.findDrivesByIds).mockResolvedValue([{ id: 'drv1', name: 'Engineering' }]);
  vi.mocked(getPrincipalDriveMembership).mockResolvedValue({ role: 'MEMBER', customRoleId: null });
  vi.mocked(getPrincipalDriveAccessLevel).mockResolvedValue(MEMBER_LEVEL);
}

describe('GET /api/auth/key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts the mcp_ credential class the key-management routes refuse', async () => {
    arrangeScopedMemberKey();
    await GET(request());
    expect(vi.mocked(authenticateRequestWithOptions).mock.calls[0][1].allow).toEqual(['mcp', 'oauth', 'session']);
  });

  it('reports the role granted AND the effective permissions it resolves to', async () => {
    arrangeScopedMemberKey();

    const body = await (await GET(request())).json();

    expect(body.credential).toMatchObject({ type: 'mcp', name: 'lead-gen agent', tokenPrefix: 'mcp_abcdefghijk', scoped: true });
    expect(body.driveScopes).toEqual([
      {
        id: 'drv1',
        name: 'Engineering',
        role: 'MEMBER',
        customRoleId: null,
        customRoleName: null,
        roleSource: 'explicit',
        permissions: MEMBER_LEVEL,
      },
    ]);
  });

  it('resolves permissions through the principal dispatcher, not from the role string', async () => {
    arrangeScopedMemberKey();
    await GET(request());
    expect(getPrincipalDriveAccessLevel).toHaveBeenCalledWith(SCOPED_KEY, 'drv1');
  });

  // The owning user must not be reachable through a key — `/api/auth/me`
  // refuses mcp_* tokens for exactly this reason.
  it('never returns the owning user\'s identity', async () => {
    arrangeScopedMemberKey();
    const body = await (await GET(request())).json();
    expect(JSON.stringify(body)).not.toContain('user-1');
    expect(body.credential.email).toBeUndefined();
  });

  it('labels an inherit grant as inherited rather than as a missing role', async () => {
    arrangeScopedMemberKey();
    vi.mocked(getPrincipalDriveMembership).mockResolvedValue({ role: null, customRoleId: null });

    const body = await (await GET(request())).json();

    expect(body.driveScopes[0].roleSource).toBe('inherited');
  });

  it('resolves a custom role to its name', async () => {
    arrangeScopedMemberKey();
    vi.mocked(getPrincipalDriveMembership).mockResolvedValue({ role: null, customRoleId: 'role-1' });
    vi.mocked(getRoleById).mockResolvedValue({ id: 'role-1', name: 'Researcher' } as never);

    const body = await (await GET(request())).json();

    expect(body.driveScopes[0]).toMatchObject({ roleSource: 'custom', customRoleId: 'role-1', customRoleName: 'Researcher' });
  });

  // A dangling inherit row (the owner lost the drive) or an unresolvable custom
  // role reaches here as null. "You hold a grant that currently gets you
  // nothing" is the honest report; dropping the row would read as never having
  // had access at all.
  it('reports an unreachable scoped drive as all-false rather than omitting it', async () => {
    arrangeScopedMemberKey();
    vi.mocked(getPrincipalDriveAccessLevel).mockResolvedValue(null);

    const body = await (await GET(request())).json();

    expect(body.driveScopes).toHaveLength(1);
    expect(body.driveScopes[0].permissions).toEqual({ canView: false, canEdit: false, canShare: false, canDelete: false });
  });

  // The drive-as-root-node answer grants edit to any membership; a document
  // inside that drive can still be view-only for the same key. Reporting only
  // the drive level would tell an agent it may write where it may not — the
  // mirror image of the "reads fine, every write fails" report in #2470.
  describe('?pageId=', () => {
    it('resolves the named page through the page-level dispatcher, separately from the drive', async () => {
      arrangeScopedMemberKey();
      // The real divergence a MEMBER key sees: edit at the drive root (any
      // membership may create a top-level page), view-only on a document.
      vi.mocked(getPrincipalDriveAccessLevel).mockResolvedValue({ canView: true, canEdit: true, canShare: false, canDelete: false });
      vi.mocked(getPrincipalAccessLevel).mockResolvedValue({ canView: true, canEdit: false, canShare: false, canDelete: false });

      const body = await (await GET(request('pg1'))).json();

      expect(getPrincipalAccessLevel).toHaveBeenCalledWith(SCOPED_KEY, 'pg1');
      expect(body.driveScopes[0].permissions.canEdit).toBe(true);
      expect(body.page).toEqual({ id: 'pg1', permissions: { canView: true, canEdit: false, canShare: false, canDelete: false } });
    });

    // "Not yours to see" and "yours, but you may do nothing" are different
    // answers; flattening null to all-false would erase the distinction.
    it('preserves an out-of-reach page as null rather than flattening it to all-false', async () => {
      arrangeScopedMemberKey();
      vi.mocked(getPrincipalAccessLevel).mockResolvedValue(null);

      const body = await (await GET(request('pg9'))).json();

      expect(body.page).toEqual({ id: 'pg9', permissions: null });
    });

    it('resolves no page and calls nothing when the parameter is absent', async () => {
      arrangeScopedMemberKey();

      const body = await (await GET(request())).json();

      expect(body.page).toBeNull();
      expect(getPrincipalAccessLevel).not.toHaveBeenCalled();
    });
  });

  // The per-drive resolution runs concurrently; `Promise.all` preserves order,
  // but a future refactor to a settle-as-they-finish shape would not, and a
  // status readout that reorders between calls is hard to diff.
  it('reports drives in a stable order regardless of how fast each resolves', async () => {
    arrangeScopedMemberKey();
    vi.mocked(getPrincipalDriveIds).mockResolvedValue(['drv1', 'drv2', 'drv3']);
    vi.mocked(sessionRepository.findDrivesByIds).mockResolvedValue([
      { id: 'drv3', name: 'Third' },
      { id: 'drv1', name: 'First' },
      { id: 'drv2', name: 'Second' },
    ]);
    // First drive resolves slowest, so a completion-ordered result would invert.
    const delays: Record<string, number> = { drv1: 20, drv2: 10, drv3: 0 };
    vi.mocked(getPrincipalDriveAccessLevel).mockImplementation(
      async (_auth, driveId: string) =>
        new Promise((resolve) => setTimeout(() => resolve(MEMBER_LEVEL), delays[driveId])),
    );

    const body = await (await GET(request())).json();

    expect(body.driveScopes.map((scope: { id: string }) => scope.id)).toEqual(['drv1', 'drv2', 'drv3']);
    expect(body.driveScopes.map((scope: { name: string }) => scope.name)).toEqual(['First', 'Second', 'Third']);
  });

  it('describes an unscoped credential with no key row, leaving the key fields null', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ ...SCOPED_KEY, tokenType: 'oauth' } as never);
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isDriveScopedPrincipal).mockReturnValue(false);
    vi.mocked(getPrincipalDriveIds).mockResolvedValue([]);

    const body = await (await GET(request())).json();

    expect(body).toEqual({
      credential: { type: 'oauth', scoped: false, id: null, name: null, tokenPrefix: null, createdAt: null, lastUsed: null },
      driveScopes: [],
      page: null,
    });
    expect(sessionRepository.findMcpTokenSelfById).not.toHaveBeenCalled();
  });

  it('propagates the auth failure response untouched', async () => {
    const error = new Response('nope', { status: 401 });
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error } as never);
    vi.mocked(isAuthError).mockReturnValue(true);

    expect(await GET(request())).toBe(error);
  });

  it('audits the read', async () => {
    arrangeScopedMemberKey();
    await GET(request());
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.read', userId: 'user-1', resourceId: 'key-1' }),
    );
  });

  it('answers 500 rather than leaking an internal error when resolution throws', async () => {
    arrangeScopedMemberKey();
    vi.mocked(getPrincipalDriveIds).mockRejectedValue(new Error('db down'));

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('db down');
  });
});
