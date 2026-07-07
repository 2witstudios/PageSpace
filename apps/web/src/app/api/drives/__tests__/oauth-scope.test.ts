/**
 * GET /api/drives under OAuth credentials (Phase 9 keys wizard fix).
 *
 * The `pagespace keys` wizard lists drives with the ambient manage_keys-scoped
 * OAuth credential minted by `pagespace login` — that credential must see the
 * owner's full drive list (it belongs to the real user; manage_keys only
 * self-limits *content* access, not seeing which drives exist to scope a new
 * key to). A genuine drive-scoped OAuth grant, however, must stay restricted
 * to exactly its scoped drives — never the empty-allowedDriveIds-means-full-
 * access default (the Phase 9 Task 1 bug class).
 *
 * Uses the REAL isScopedMCPAuth/isScopedOAuthAuth/getScopedDriveMembership
 * implementations (not mocked) so these fail if the scope dispatch regresses.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '../route';
import { manageKeysScopedAuthResult, driveScopedOAuthAuthResult } from '@/lib/auth/__tests__/manage-keys-fixture';

vi.mock('@pagespace/lib/services/drive-service', () => ({
  listAccessibleDrives: vi.fn(),
  createDrive: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackDriveOperation: vi.fn(),
}));
vi.mock('@pagespace/lib/utils/api-utils', () => ({
  jsonResponse: vi.fn((data, options = {}) => Response.json(data, { status: options.status || 200 })),
}));
vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn().mockResolvedValue(undefined),
  createDriveEventPayload: vi.fn((driveId, event, data) => ({ driveId, event, data })),
}));
vi.mock('@pagespace/db/db', () => ({
  db: { query: { drives: { findMany: vi.fn() } } },
}));

// Only stub authentication — isScopedMCPAuth/isScopedOAuthAuth and
// getScopedDriveMembership run for real.
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    authenticateRequestWithOptions: vi.fn(),
  };
});

import { authenticateRequestWithOptions } from '@/lib/auth';
import { listAccessibleDrives } from '@pagespace/lib/services/drive-service';
import { db } from '@pagespace/db/db';
import type { DriveWithAccess } from '@pagespace/lib/services/drive-service';

const driveFixture = (overrides: { id: string; name: string; ownerId?: string }) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.name.toLowerCase().replace(/\s+/g, '-'),
  ownerId: overrides.ownerId ?? 'test-user-id',
  kind: 'STANDARD' as const,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
  homePageId: null,
  publishSubdomain: null,
  publishDefaultOgImageUrl: null,
  notFoundPageId: null,
  publishFaviconUrl: null,
});

describe('GET /api/drives — OAuth credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('permits OAuth in the read auth options', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(manageKeysScopedAuthResult());
    vi.mocked(listAccessibleDrives).mockResolvedValue([]);

    const request = new Request('https://example.com/api/drives');
    await GET(request);

    expect(authenticateRequestWithOptions).toHaveBeenCalledWith(request, {
      allow: ['session', 'mcp', 'oauth'],
      requireCSRF: false,
    });
  });

  it('gives a manage_keys-scoped credential the full listAccessibleDrives result', async () => {
    const drives = [
      driveFixture({ id: 'drive-a', name: 'Drive A', ownerId: 'user-manage-keys' }),
      driveFixture({ id: 'drive-b', name: 'Drive B', ownerId: 'someone-else' }),
    ].map((drive) => ({ ...drive, isOwned: true, role: 'OWNER' as const, lastAccessedAt: null })) satisfies DriveWithAccess[];
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(manageKeysScopedAuthResult());
    vi.mocked(listAccessibleDrives).mockResolvedValue(drives);

    const request = new Request('https://example.com/api/drives?tokenScopable=true');
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(listAccessibleDrives).toHaveBeenCalledWith('user-manage-keys', { includeTrash: false, tokenScopable: true });
    expect(body.map((drive: { id: string }) => drive.id)).toEqual(['drive-a', 'drive-b']);
    expect(db.query.drives.findMany).not.toHaveBeenCalled();
  });

  it('gives an account-scoped OAuth credential the full listAccessibleDrives result', async () => {
    const drives = [
      driveFixture({ id: 'drive-account', name: 'Account Drive', ownerId: 'user-account' }),
    ].map((drive) => ({ ...drive, isOwned: true, role: 'OWNER' as const, lastAccessedAt: null })) satisfies DriveWithAccess[];
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(
      manageKeysScopedAuthResult({
        userId: 'user-account',
        tokenId: 'oauth-token-account',
        scopes: { account: true, offlineAccess: false, drives: new Map(), manageKeys: false },
      }),
    );
    vi.mocked(listAccessibleDrives).mockResolvedValue(drives);

    const request = new Request('https://example.com/api/drives');
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(listAccessibleDrives).toHaveBeenCalledWith('user-account', { includeTrash: false, tokenScopable: false });
    expect(body.map((drive: { id: string }) => drive.id)).toEqual(['drive-account']);
    expect(db.query.drives.findMany).not.toHaveBeenCalled();
  });

  it('restricts a drive-scoped OAuth credential to exactly its scoped drives — never the full list', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(driveScopedOAuthAuthResult());
    vi.mocked(db.query.drives.findMany).mockResolvedValue([driveFixture({ id: 'drive-1', name: 'Scoped Drive' })]);

    const request = new Request('https://example.com/api/drives');
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(listAccessibleDrives).not.toHaveBeenCalled();
    expect(db.query.drives.findMany).toHaveBeenCalledTimes(1);
    expect(body.map((drive: { id: string }) => drive.id)).toEqual(['drive-1']);
    // Inherit-role scope row owned by the requesting user resolves as OWNER.
    expect(body[0]).toMatchObject({ id: 'drive-1', role: 'OWNER', isOwned: true });
  });

  it('presents the scope row explicit role, not the owner relationship, when the grant is downgraded', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(
      driveScopedOAuthAuthResult({
        driveScopes: [{ driveId: 'drive-1', role: 'MEMBER', customRoleId: null }],
      }),
    );
    vi.mocked(db.query.drives.findMany).mockResolvedValue([driveFixture({ id: 'drive-1', name: 'Scoped Drive' })]);

    const request = new Request('https://example.com/api/drives');
    const response = await GET(request);
    const body = await response.json();

    expect(body[0]).toMatchObject({ id: 'drive-1', role: 'MEMBER', isOwned: false });
  });
});
