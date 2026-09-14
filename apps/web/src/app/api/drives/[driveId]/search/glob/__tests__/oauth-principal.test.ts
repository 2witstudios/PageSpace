/**
 * Phase 2 cluster test — search (inline scope branch).
 *
 * Drive search gates a drive-scoped credential on its OWN membership and, for
 * an explicit role, filters every hit through the credential's own page set.
 * Written against `isScopedMCPAuth`, an OAuth `drive:X:member` grant skipped
 * both and searched with the owning user's full visibility (private pages
 * included). Real scope/principal helpers; DB-backed resolvers stubbed at the
 * app-permissions boundary.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/services/drive-search-service', () => ({
  checkDriveAccessForSearch: vi.fn(),
  globSearchPages: vi.fn(),
}));
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: async () => [{ id: 'drivex', slug: 'x', name: 'X' }] }) })),
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  logSecurityEvent: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/app-permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/permissions/app-permissions')>();
  return {
    ...actual,
    hasAppDriveMembership: vi.fn(),
    getAppDriveMembership: vi.fn(),
    getAppAccessiblePagesInDrive: vi.fn(),
    getScopedAccessiblePagesInDrive: vi.fn(),
  };
});
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, authenticateRequestWithOptions: vi.fn() };
});

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { checkDriveAccessForSearch, globSearchPages } from '@pagespace/lib/services/drive-search-service';
import {
  getAppAccessiblePagesInDrive,
  getAppDriveMembership,
  getScopedAccessiblePagesInDrive,
  hasAppDriveMembership,
} from '@pagespace/lib/permissions/app-permissions';
import { PARITY_USER_ID, mcpDriveKey, oauthDriveGrant, profileOnlyGrant } from '@/lib/auth/__tests__/oauth-principal-fixture';

const DRIVE_X = 'drivex';
const DRIVE_Y = 'drivey';

const search = (driveId: string) =>
  GET(new Request(`https://example.com/api/drives/${driveId}/search/glob?pattern=*`), { params: Promise.resolve({ driveId }) });

const grantPages = [
  { id: 'visible', permissions: { canView: true, canEdit: true, canShare: false, canDelete: false } },
  { id: 'listed-not-viewable', permissions: { canView: false, canEdit: false, canShare: false, canDelete: false } },
];

async function authorizeViewPassedToSearch(): Promise<((pageId: string) => Promise<boolean>) | undefined> {
  const options = vi.mocked(globSearchPages).mock.calls[0]?.[4] as { authorizeView?: (pageId: string) => Promise<boolean> } | undefined;
  return options?.authorizeView;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The owning user could search everything in both drives.
  vi.mocked(checkDriveAccessForSearch).mockResolvedValue({ hasAccess: true, drive: { id: DRIVE_X, slug: 'x', name: 'X' } } as never);
  vi.mocked(globSearchPages).mockResolvedValue({ results: [] } as never);
});

describe('GET /api/drives/[driveId]/search/glob — OAuth principals', () => {
  it("filters a drive:X:member OAuth grant's hits through the GRANT's page set, not the owner's", async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'member'));
    vi.mocked(getScopedAccessiblePagesInDrive).mockResolvedValue(grantPages as never);

    const res = await search(DRIVE_X);

    expect(res.status).toBe(200);
    expect(checkDriveAccessForSearch).not.toHaveBeenCalled();
    const authorizeView = await authorizeViewPassedToSearch();
    expect(authorizeView).toBeTypeOf('function');
    expect(await authorizeView!('visible')).toBe(true);
    expect(await authorizeView!('listed-not-viewable')).toBe(false);
    expect(await authorizeView!('owner-only-private-page')).toBe(false);
    expect(getScopedAccessiblePagesInDrive).toHaveBeenCalledWith([{ driveId: DRIVE_X, role: 'MEMBER', customRoleId: null }], PARITY_USER_ID, DRIVE_X);
  });

  it('applies the same filter as a MEMBER-role mcp_ key (parity)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpDriveKey(DRIVE_X));
    vi.mocked(hasAppDriveMembership).mockResolvedValue(true);
    vi.mocked(getAppDriveMembership).mockResolvedValue({ role: 'MEMBER', customRoleId: null, ownerUserId: PARITY_USER_ID });
    vi.mocked(getAppAccessiblePagesInDrive).mockResolvedValue(grantPages as never);

    const res = await search(DRIVE_X);

    expect(res.status).toBe(200);
    expect(checkDriveAccessForSearch).not.toHaveBeenCalled();
    const authorizeView = await authorizeViewPassedToSearch();
    expect(await authorizeView!('visible')).toBe(true);
    expect(await authorizeView!('owner-only-private-page')).toBe(false);
  });

  it('denies the grant in drive Y', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'admin'));
    const res = await search(DRIVE_Y);
    expect(res.status).toBe(403);
    expect(globSearchPages).not.toHaveBeenCalled();
  });

  it('denies a profile-only token in every drive', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(profileOnlyGrant());
    for (const driveId of [DRIVE_X, DRIVE_Y]) {
      const res = await search(driveId);
      expect(res.status).toBe(403);
    }
    expect(globSearchPages).not.toHaveBeenCalled();
  });
});
