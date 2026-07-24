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
  getBatchPagePermissions: vi.fn().mockResolvedValue(new Map()),
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
import { getUserDriveAccess, getBatchPagePermissions } from '@pagespace/lib/permissions/permissions';
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
      vi.mocked(reconcileStorageUsage).mockResolvedValue({ outcome: 'reconciled', previousUsage: 0, actualUsage: 0, difference: 0 } as never);

      const request = new Request('https://example.com/api/storage/info?reconcile=true');
      const res = await GET(request as never);

      expect(res.status).toBe(200);
      expect(validateAdminAccess).toHaveBeenCalledWith('user_1', 3);
      expect(reconcileStorageUsage).toHaveBeenCalledWith('user_1');
    });

    it('handles a lock_busy reconcile outcome without erroring', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({ id: 'user_1', role: 'admin', adminRoleVersion: 3 } as never);
      vi.mocked(validateAdminAccess).mockResolvedValue({ isValid: true } as never);
      vi.mocked(reconcileStorageUsage).mockResolvedValue({ outcome: 'lock_busy' } as never);

      const request = new Request('https://example.com/api/storage/info?reconcile=true');
      const res = await GET(request as never);

      expect(res.status).toBe(200);
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
        { fileId: 'f1', sizeBytes: 10, mimeType: 'text/plain', createdAt: new Date(), driveId: null, pageId: null, title: null },
      ]);

      const request = new Request('https://example.com/api/storage/info');
      await GET(request as never);

      expect(or).not.toHaveBeenCalled();
      expect(inArray).not.toHaveBeenCalled();
      expect(eq).toHaveBeenCalledWith('ownerId', 'user_1');
    });

    it('unions owned drives with every drive a referenced file lives in', async () => {
      vi.mocked(findUserFileRows).mockResolvedValue([
        { fileId: 'f1', sizeBytes: 10, mimeType: 'text/plain', createdAt: new Date(), driveId: 'shared-drive-1', pageId: 'p1', title: 't1' },
        { fileId: 'f2', sizeBytes: 20, mimeType: 'text/plain', createdAt: new Date(), driveId: 'shared-drive-1', pageId: 'p2', title: 't2' },
        { fileId: 'f3', sizeBytes: 30, mimeType: 'text/plain', createdAt: new Date(), driveId: null, pageId: null, title: null },
      ]);

      const request = new Request('https://example.com/api/storage/info');
      await GET(request as never);

      // Deduplicated: 'shared-drive-1' appears once despite two files referencing it.
      expect(inArray).toHaveBeenCalledWith('id', ['shared-drive-1']);
      expect(or).toHaveBeenCalled();
    });

    it('re-checks current access for non-owned candidate drives and excludes ones the user has lost access to', async () => {
      vi.mocked(findUserFileRows).mockResolvedValue([
        { fileId: 'f1', sizeBytes: 100, mimeType: 'text/plain', createdAt: new Date(), driveId: 'still-shared', pageId: 'p1', title: 't1' },
        { fileId: 'f2', sizeBytes: 200, mimeType: 'text/plain', createdAt: new Date(), driveId: 'access-revoked', pageId: 'p2', title: 't2' },
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
        { fileId: 'f1', sizeBytes: 100, mimeType: 'text/plain', createdAt: new Date(), driveId: 'owned-drive', pageId: 'p1', title: 't1' },
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

  describe('#2225 review (Codex round 4, P1) — largestFiles/recentFiles gate on page-level permission, not drive access', () => {
    const view = { canView: true, canEdit: false, canShare: false, canDelete: false };
    const deny = { canView: false, canEdit: false, canShare: false, canDelete: false };

    it('shows the real title/id when the user has explicit view permission on the representative page', async () => {
      vi.mocked(findUserFileRows).mockResolvedValue([
        { fileId: 'f1', sizeBytes: 100, mimeType: 'text/plain', createdAt: new Date(), driveId: 'shared', pageId: 'page-1', title: 'Real Title' },
      ]);
      vi.mocked(getBatchPagePermissions).mockResolvedValue(new Map([['page-1', view]]));

      const request = new Request('https://example.com/api/storage/info');
      const res = await GET(request as never);
      const body = await res.json();

      expect(getBatchPagePermissions).toHaveBeenCalledWith('user_1', ['page-1']);
      expect(body.recentFiles[0]).toMatchObject({ id: 'page-1', title: 'Real Title' });
      expect(body.largestFiles[0]).toMatchObject({ id: 'page-1', title: 'Real Title' });
    });

    it('falls back to fileId/"Untitled file" when the user has drive access but no page-level view permission on a private page', async () => {
      // The user is a member of (or otherwise has getUserDriveAccess for) the
      // file's drive — drive access alone must NOT be enough. A private page
      // with no explicit grant denies canView even to drive members.
      vi.mocked(findUserFileRows).mockResolvedValue([
        { fileId: 'f1', sizeBytes: 100, mimeType: 'text/plain', createdAt: new Date(), driveId: 'shared', pageId: 'page-1', title: 'Should Not Leak' },
      ]);
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
      vi.mocked(getBatchPagePermissions).mockResolvedValue(new Map([['page-1', deny]]));

      const request = new Request('https://example.com/api/storage/info');
      const res = await GET(request as never);
      const body = await res.json();

      expect(body.recentFiles[0]).toMatchObject({ id: 'f1', title: 'Untitled file' });
      expect(body.largestFiles[0]).toMatchObject({ id: 'f1', title: 'Untitled file' });
      // The byte total is unaffected — only the display metadata is hidden.
      expect(body.fileTypeBreakdown.Text.totalSize).toBe(100);
    });

    it('falls back to fileId/"Untitled file" when the page has no permission entry at all (nonexistent/trashed/no grant)', async () => {
      vi.mocked(findUserFileRows).mockResolvedValue([
        { fileId: 'f1', sizeBytes: 100, mimeType: 'text/plain', createdAt: new Date(), driveId: null, pageId: 'page-1', title: 'Should Not Leak' },
      ]);
      vi.mocked(getBatchPagePermissions).mockResolvedValue(new Map());

      const request = new Request('https://example.com/api/storage/info');
      const res = await GET(request as never);
      const body = await res.json();

      expect(body.recentFiles[0]).toMatchObject({ id: 'f1', title: 'Untitled file' });
    });

    it('batches the permission check over only the surfaced (top largest + top recent) pages, deduplicated', async () => {
      const files = Array.from({ length: 3 }, (_, i) => ({
        fileId: `f${i}`, sizeBytes: 100 + i, mimeType: 'text/plain', createdAt: new Date(2026, 0, i + 1),
        driveId: null, pageId: `page-${i}`, title: `t${i}`,
      }));
      vi.mocked(findUserFileRows).mockResolvedValue(files);
      vi.mocked(getBatchPagePermissions).mockResolvedValue(new Map());

      const request = new Request('https://example.com/api/storage/info');
      await GET(request as never);

      const [, pageIds] = vi.mocked(getBatchPagePermissions).mock.calls[0];
      expect(new Set(pageIds)).toEqual(new Set(['page-0', 'page-1', 'page-2']));
    });
  });
});
