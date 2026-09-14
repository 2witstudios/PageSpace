/**
 * Phase 2 cluster test — uploads (inline scope branch).
 *
 * Presign gates a drive-scoped credential on its OWN drive access level inline
 * and everyone else on the owning user's drive permissions. Written against
 * `isScopedMCPAuth`, an OAuth grant was judged by the user's permissions
 * instead of the grant's. Real scope/principal helpers; the grant's
 * drive-access resolver is stubbed at the app-permissions boundary so the test
 * can tell which of the two authorities was asked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/permissions/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/permissions/permissions')>();
  return { ...actual, getUserDrivePermissions: vi.fn() };
});
vi.mock('@pagespace/lib/permissions/app-permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/permissions/app-permissions')>();
  return { ...actual, getAppDriveAccessLevel: vi.fn(), getScopedDriveAccessLevel: vi.fn() };
});
vi.mock('@pagespace/lib/services/storage-limits', () => ({
  getUserStorageQuota: vi.fn().mockResolvedValue(null),
  checkStorageQuota: vi.fn(),
  reserveConcurrentUploadSlot: vi.fn(),
  userReferencesContentHash: vi.fn(),
}));
vi.mock('@pagespace/lib/services/pending-uploads', () => ({ releasePendingUpload: vi.fn() }));
vi.mock('@pagespace/lib/services/upload-semaphore', () => ({
  uploadSemaphore: { acquireUploadSlot: vi.fn(), releaseUploadSlot: vi.fn() },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  logSecurityEvent: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@/lib/upload/s3-effects', () => ({ checkObjectExists: vi.fn(), issuePresignedPutUrl: vi.fn() }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, authenticateRequestWithOptions: vi.fn() };
});

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { getUserDrivePermissions } from '@pagespace/lib/permissions/permissions';
import { getAppDriveAccessLevel, getScopedDriveAccessLevel } from '@pagespace/lib/permissions/app-permissions';
import { getUserStorageQuota } from '@pagespace/lib/services/storage-limits';
import { PARITY_USER_ID, mcpDriveKey, oauthDriveGrant, profileOnlyGrant } from '@/lib/auth/__tests__/oauth-principal-fixture';

const DRIVE_X = 'drivex';
const DRIVE_Y = 'drivey';

const presign = (driveId: string) =>
  POST(
    new Request('https://example.com/api/upload/presign', {
      method: 'POST',
      body: JSON.stringify({ contentHash: 'a'.repeat(64), driveId, filename: 'f.txt', mimeType: 'text/plain', fileSize: 10 }),
    }),
  );

const NO_ACCESS = null;
const EDIT = { canView: true, canEdit: true, canShare: false, canDelete: false };

beforeEach(() => {
  vi.clearAllMocks();
  // The owning user can upload anywhere.
  vi.mocked(getUserDrivePermissions).mockResolvedValue({ hasAccess: true, isOwner: true, isAdmin: false, isMember: true, canEdit: true } as never);
  vi.mocked(getUserStorageQuota).mockResolvedValue(null);
});

describe('POST /api/upload/presign — OAuth principals', () => {
  it("judges an OAuth drive grant by the GRANT's drive access, never the owning user's", async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'inherit'));
    vi.mocked(getScopedDriveAccessLevel).mockResolvedValue(NO_ACCESS);
    const res = await presign(DRIVE_X);
    expect(res.status).toBe(403);
    expect(getScopedDriveAccessLevel).toHaveBeenCalledWith([{ driveId: DRIVE_X, role: null, customRoleId: null }], PARITY_USER_ID, DRIVE_X);
    expect(getUserDrivePermissions).not.toHaveBeenCalled();
    expect(getUserStorageQuota).not.toHaveBeenCalled();
  });

  it('gives the same answer as a drive-scoped mcp_ key whose own access is refused (parity)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpDriveKey(DRIVE_X));
    vi.mocked(getAppDriveAccessLevel).mockResolvedValue(NO_ACCESS);
    const res = await presign(DRIVE_X);
    expect(res.status).toBe(403);
    expect(getUserDrivePermissions).not.toHaveBeenCalled();
  });

  it('lets a drive:X:member grant past the permission gate in X (positive control)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'member'));
    vi.mocked(getScopedDriveAccessLevel).mockResolvedValue(EDIT);
    await presign(DRIVE_X);
    expect(getUserStorageQuota).toHaveBeenCalledWith(PARITY_USER_ID);
  });

  it('denies the grant in drive Y', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'member'));
    const res = await presign(DRIVE_Y);
    expect(res.status).toBe(403);
    expect(getUserStorageQuota).not.toHaveBeenCalled();
  });

  it('denies a profile-only token in every drive', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(profileOnlyGrant());
    for (const driveId of [DRIVE_X, DRIVE_Y]) {
      const res = await presign(driveId);
      expect(res.status).toBe(403);
    }
    expect(getUserStorageQuota).not.toHaveBeenCalled();
  });
});
