/**
 * Contract tests for /api/storage/info — security audit coverage
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({
    audit: vi.fn(),
    auditRequest: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@/lib/auth/admin-role', () => ({
  validateAdminAccess: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserDriveAccess: vi.fn(),
}));

vi.mock('@pagespace/lib/services/storage-limits', () => ({
  getUserStorageQuota: vi.fn().mockResolvedValue({ tier: 'free', usedBytes: 0, quotaBytes: 1e9, availableBytes: 1e9 }),
  getUserFileCount: vi.fn().mockResolvedValue(0),
  reconcileStorageUsage: vi.fn(),
  STORAGE_TIERS: { free: {} },
  formatBytes: vi.fn((n: number) => `${n}B`),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      drives: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  or: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'id', ownerId: 'ownerId' },
}));
vi.mock('@/lib/storage/storage-info-repository', () => ({
  findUserFileRows: vi.fn().mockResolvedValue([]),
}));

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import { validateAdminAccess } from '@/lib/auth/admin-role';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { reconcileStorageUsage } from '@pagespace/lib/services/storage-limits';
import { getUserDriveAccess } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import { eq, or, inArray } from '@pagespace/db/operators';
import { findUserFileRows } from '@/lib/storage/storage-info-repository';

describe('GET /api/storage/info', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue({ id: 'user_1', role: 'user', adminRoleVersion: 0 } as never);
    vi.mocked(validateAdminAccess).mockResolvedValue({ isValid: false, reason: 'not_admin' } as never);
  });

  it('logs audit event on successful storage info fetch', async () => {
    const request = new Request('https://example.com/api/storage/info');
    await GET(request as never);

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.read', userId: 'user_1', resourceType: 'storage', resourceId: 'user_1' }
    );
  });

  it('does not log audit event when auth fails', async () => {
    vi.mocked(verifyAuth).mockResolvedValue(null);

    const request = new Request('https://example.com/api/storage/info');
    await GET(request as never);

    expect(auditRequest).not.toHaveBeenCalled();
  });

  describe('H4 — ?reconcile=true is admin-gated (gate resolved up front, not from the request param)', () => {
    it('returns 403 and does not reconcile for a non-admin', async () => {
      // default mocks: role 'user', validateAdminAccess invalid
      const request = new Request('https://example.com/api/storage/info?reconcile=true');
      const res = await GET(request as never);

      expect(res.status).toBe(403);
      expect(reconcileStorageUsage).not.toHaveBeenCalled();
    });

    it('reconciles for a DB-verified admin', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({ id: 'user_1', role: 'admin', adminRoleVersion: 3 } as never);
      vi.mocked(validateAdminAccess).mockResolvedValue({ isValid: true } as never);
      vi.mocked(reconcileStorageUsage).mockResolvedValue({ previousUsage: 0, actualUsage: 0, difference: 0 } as never);

      const request = new Request('https://example.com/api/storage/info?reconcile=true');
      const res = await GET(request as never);

      expect(res.status).toBe(200);
      expect(validateAdminAccess).toHaveBeenCalledWith('user_1', 3);
      expect(reconcileStorageUsage).toHaveBeenCalledWith('user_1');
    });

    it('rejects a stale admin session whose adminRoleVersion no longer validates', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({ id: 'user_1', role: 'admin', adminRoleVersion: 1 } as never);
      vi.mocked(validateAdminAccess).mockResolvedValue({ isValid: false, reason: 'version_mismatch' } as never);

      const request = new Request('https://example.com/api/storage/info?reconcile=true');
      const res = await GET(request as never);

      expect(res.status).toBe(403);
      expect(reconcileStorageUsage).not.toHaveBeenCalled();
    });

    it('does not call the admin DB validation for a non-admin normal read (short-circuit, no reconcile)', async () => {
      const request = new Request('https://example.com/api/storage/info');
      await GET(request as never);

      expect(validateAdminAccess).not.toHaveBeenCalled();
      expect(reconcileStorageUsage).not.toHaveBeenCalled();
    });
  });

  describe('#2225 review — by-drive breakdown includes shared (non-owned) drives', () => {
    it('queries only owned drives when no file references a drive the user does not own', async () => {
      vi.mocked(findUserFileRows).mockResolvedValue([
        { fileId: 'f1', sizeBytes: 10, mimeType: 'text/plain', createdAt: new Date(), driveId: null, pageId: null, title: null, pageDriveId: null },
      ]);

      const request = new Request('https://example.com/api/storage/info');
      await GET(request as never);

      expect(or).not.toHaveBeenCalled();
      expect(inArray).not.toHaveBeenCalled();
      expect(eq).toHaveBeenCalledWith('ownerId', 'user_1');
    });

    it('unions owned drives with every drive a referenced file lives in', async () => {
      vi.mocked(findUserFileRows).mockResolvedValue([
        { fileId: 'f1', sizeBytes: 10, mimeType: 'text/plain', createdAt: new Date(), driveId: 'shared-drive-1', pageId: 'p1', title: 't1', pageDriveId: 'shared-drive-1' },
        { fileId: 'f2', sizeBytes: 20, mimeType: 'text/plain', createdAt: new Date(), driveId: 'shared-drive-1', pageId: 'p2', title: 't2', pageDriveId: 'shared-drive-1' },
        { fileId: 'f3', sizeBytes: 30, mimeType: 'text/plain', createdAt: new Date(), driveId: null, pageId: null, title: null, pageDriveId: null },
      ]);

      const request = new Request('https://example.com/api/storage/info');
      await GET(request as never);

      // Deduplicated: 'shared-drive-1' appears once despite two files referencing it.
      expect(inArray).toHaveBeenCalledWith('id', ['shared-drive-1']);
      expect(or).toHaveBeenCalled();
    });

    it('re-checks current access for non-owned candidate drives and excludes ones the user has lost access to', async () => {
      vi.mocked(findUserFileRows).mockResolvedValue([
        { fileId: 'f1', sizeBytes: 100, mimeType: 'text/plain', createdAt: new Date(), driveId: 'still-shared', pageId: 'p1', title: 't1', pageDriveId: 'still-shared' },
        { fileId: 'f2', sizeBytes: 200, mimeType: 'text/plain', createdAt: new Date(), driveId: 'access-revoked', pageId: 'p2', title: 't2', pageDriveId: 'access-revoked' },
      ]);
      vi.mocked(db.query.drives.findMany).mockResolvedValue([
        { id: 'still-shared', name: 'Still Shared', ownerId: 'other-owner' },
        { id: 'access-revoked', name: 'Revoked Drive', ownerId: 'other-owner' },
      ] as never);
      vi.mocked(getUserDriveAccess).mockImplementation(async (_userId, driveId) => driveId === 'still-shared');

      const request = new Request('https://example.com/api/storage/info');
      const res = await GET(request as never);
      const body = await res.json();

      expect(getUserDriveAccess).toHaveBeenCalledWith('user_1', 'still-shared');
      expect(getUserDriveAccess).toHaveBeenCalledWith('user_1', 'access-revoked');
      const driveIds = body.storageByDrive.map((d: { driveId: string }) => d.driveId);
      expect(driveIds).toContain('still-shared');
      expect(driveIds).not.toContain('access-revoked');
      // The bytes stay in the overall accounting even though the drive metadata is hidden.
      expect(body.fileTypeBreakdown.Text.totalSize).toBe(300);
    });

    it('never re-checks access for drives the user owns', async () => {
      vi.mocked(findUserFileRows).mockResolvedValue([
        { fileId: 'f1', sizeBytes: 100, mimeType: 'text/plain', createdAt: new Date(), driveId: 'owned-drive', pageId: 'p1', title: 't1', pageDriveId: 'owned-drive' },
      ]);
      vi.mocked(db.query.drives.findMany).mockResolvedValue([
        { id: 'owned-drive', name: 'My Drive', ownerId: 'user_1' },
      ] as never);

      const request = new Request('https://example.com/api/storage/info');
      const res = await GET(request as never);
      const body = await res.json();

      expect(getUserDriveAccess).not.toHaveBeenCalled();
      expect(body.storageByDrive.map((d: { driveId: string }) => d.driveId)).toContain('owned-drive');
    });
  });

  describe('#2225 review (3rd pass) — largestFiles/recentFiles hide page metadata from inaccessible drives', () => {
    it('shows the real title/id when the representative page\'s drive is still accessible', async () => {
      vi.mocked(findUserFileRows).mockResolvedValue([
        { fileId: 'f1', sizeBytes: 100, mimeType: 'text/plain', createdAt: new Date(), driveId: 'shared', pageId: 'page-1', title: 'Real Title', pageDriveId: 'shared' },
      ]);
      vi.mocked(db.query.drives.findMany).mockResolvedValue([
        { id: 'shared', name: 'Shared Drive', ownerId: 'other-owner' },
      ] as never);
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);

      const request = new Request('https://example.com/api/storage/info');
      const res = await GET(request as never);
      const body = await res.json();

      expect(body.recentFiles[0]).toMatchObject({ id: 'page-1', title: 'Real Title' });
      expect(body.largestFiles[0]).toMatchObject({ id: 'page-1', title: 'Real Title' });
    });

    it('falls back to fileId/"Untitled file" when the representative page\'s drive access is revoked, even though its byte-attribution drive is still owned', async () => {
      // The file's OWN driveId (creation drive) is owned and thus accessible,
      // but the representative page — picked as the most-recently-created
      // live page — lives in a DIFFERENT (now-inaccessible) drive under
      // cross-drive dedup. The gate must key off pageDriveId, not driveId.
      vi.mocked(findUserFileRows).mockResolvedValue([
        { fileId: 'f1', sizeBytes: 100, mimeType: 'text/plain', createdAt: new Date(), driveId: 'owned-drive', pageId: 'page-1', title: 'Should Not Leak', pageDriveId: 'revoked-drive' },
      ]);
      vi.mocked(db.query.drives.findMany).mockResolvedValue([
        { id: 'owned-drive', name: 'Owned', ownerId: 'user_1' },
        { id: 'revoked-drive', name: 'Revoked', ownerId: 'other-owner' },
      ] as never);
      vi.mocked(getUserDriveAccess).mockImplementation(async (_userId, driveId) => driveId !== 'revoked-drive');

      const request = new Request('https://example.com/api/storage/info');
      const res = await GET(request as never);
      const body = await res.json();

      expect(body.recentFiles[0]).toMatchObject({ id: 'f1', title: 'Untitled file' });
      expect(body.largestFiles[0]).toMatchObject({ id: 'f1', title: 'Untitled file' });
      // The byte total is unaffected — only the display metadata is hidden.
      expect(body.fileTypeBreakdown.Text.totalSize).toBe(100);
    });

    it('unions pageDriveId into the drives access-check query, not just driveId', async () => {
      vi.mocked(findUserFileRows).mockResolvedValue([
        { fileId: 'f1', sizeBytes: 100, mimeType: 'text/plain', createdAt: new Date(), driveId: 'owned-drive', pageId: 'page-1', title: 't1', pageDriveId: 'dedup-drive' },
      ]);
      vi.mocked(db.query.drives.findMany).mockResolvedValue([]);

      const request = new Request('https://example.com/api/storage/info');
      await GET(request as never);

      expect(inArray).toHaveBeenCalledWith('id', expect.arrayContaining(['dedup-drive']));
    });
  });
});
