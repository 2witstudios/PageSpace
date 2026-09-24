/**
 * Contract tests for /api/storage/check — security audit coverage
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

vi.mock('@pagespace/lib/audit/audit-log', () => ({
    audit: vi.fn(),
    auditRequest: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/services/storage-limits', () => ({
  resolveUploadQuotaTarget: vi.fn(),
  checkUploadQuotaTarget: vi.fn(),
  getUserStorageQuota: vi.fn(),
  STORAGE_TIERS: { free: { maxConcurrentUploads: 3 }, business: { maxConcurrentUploads: 10 } },
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserDrivePermissions: vi.fn(),
}));

vi.mock('@pagespace/lib/services/pending-uploads', () => ({
  countLiveUploadsForUser: vi.fn().mockResolvedValue(0),
}));

vi.mock('@pagespace/lib/services/upload-semaphore', () => ({
  uploadSemaphore: {
    canAcquireSlot: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@pagespace/lib/services/memory-monitor', () => ({
  checkMemoryMiddleware: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@/lib/validation/parse-body', () => ({
  safeParseBody: vi.fn().mockResolvedValue({ success: true, data: { fileSize: 1024 } }),
}));

import { GET, POST } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { countLiveUploadsForUser } from '@pagespace/lib/services/pending-uploads';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import {
  resolveUploadQuotaTarget,
  checkUploadQuotaTarget,
  getUserStorageQuota,
  type UploadQuotaTarget,
} from '@pagespace/lib/services/storage-limits';
import { getUserDrivePermissions } from '@pagespace/lib/permissions/permissions';
import { safeParseBody } from '@/lib/validation/parse-body';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** Lena, on Free, has used every byte of her 500 MiB personal quota. */
const PERSONAL_FULL: UploadQuotaTarget = {
  payer: { kind: 'user', userId: 'user_1' },
  quota: { userId: 'user_1', tier: 'free', quotaBytes: 500 * MiB, usedBytes: 500 * MiB, availableBytes: 0, utilizationPercent: 100, warningLevel: 'critical' },
};

/** Northwind's Business quota, with room. */
const ORG_WITH_ROOM: UploadQuotaTarget = {
  payer: { kind: 'org', orgId: 'org_northwind' },
  quota: { orgId: 'org_northwind', tier: 'business', quotaBytes: 50 * GiB, usedBytes: GiB, availableBytes: 49 * GiB, utilizationPercent: 2, warningLevel: 'none' },
};

/** The lib resolver's contract: an org drive resolves to its org, anything else to the uploader. */
const DRIVE_ORGS: Record<string, string> = { drive_org: 'org_northwind', drive_org_other: 'org_other' };
function fakeResolve(_userId: string, driveId: string | null | undefined): Promise<UploadQuotaTarget> {
  return Promise.resolve(driveId && DRIVE_ORGS[driveId] ? ORG_WITH_ROOM : PERSONAL_FULL);
}
/** The lib check's byte rule: the file must fit in what is left. */
function fakeCheck(target: UploadQuotaTarget | null, fileSize: number) {
  if (!target) return Promise.resolve({ allowed: false, reason: 'User not found' });
  return Promise.resolve(fileSize <= target.quota.availableBytes
    ? { allowed: true, quota: target.quota }
    : { allowed: false, reason: 'Insufficient storage', quota: target.quota, requiredBytes: fileSize });
}

const EDITOR = { hasAccess: true, isOwner: false, isAdmin: false, isMember: true, canEdit: true };
const VIEWER = { hasAccess: true, isOwner: false, isAdmin: false, isMember: true, canEdit: false };

function dropBody(body: { fileSize: number; driveId?: string }) {
  vi.mocked(safeParseBody).mockResolvedValue({ success: true, data: body } as never);
}

const postRequest = () => new Request('https://example.com/api/storage/check', {
  method: 'POST',
  body: JSON.stringify({ fileSize: 1024 }),
});

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess-1',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
});

describe('GET /api/storage/check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getUserStorageQuota).mockResolvedValue({ userId: 'user_1', tier: 'free', usedBytes: 0, quotaBytes: 1e9, availableBytes: 1e9, utilizationPercent: 0, warningLevel: 'none' });
    vi.mocked(resolveUploadQuotaTarget).mockImplementation(fakeResolve);
    vi.mocked(checkUploadQuotaTarget).mockResolvedValue({ allowed: true });
    vi.mocked(getUserDrivePermissions).mockResolvedValue(null);
    dropBody({ fileSize: 1024 });
  });

  it('logs audit event on successful storage check', async () => {
    const request = new Request('https://example.com/api/storage/check');
    await GET(request as never);

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.read', userId: 'user_1', resourceType: 'storage', resourceId: 'user_1' }
    );
  });

  it('does not log audit event when auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError());
    vi.mocked(isAuthError).mockReturnValue(true);

    const request = new Request('https://example.com/api/storage/check');
    await GET(request as never);

    expect(auditRequest).not.toHaveBeenCalled();
  });

  describe('#2225 review (Codex round 5) — reads the cross-process pending_uploads count, not the process-local semaphore', () => {
    it('reports canUpload true and echoes the live count when under the tier limit', async () => {
      vi.mocked(uploadSemaphore.canAcquireSlot).mockResolvedValue(true);
      vi.mocked(countLiveUploadsForUser).mockResolvedValue(2);

      const request = new Request('https://example.com/api/storage/check');
      const res = await GET(request as never);
      const body = await res.json();

      expect(countLiveUploadsForUser).toHaveBeenCalledWith('user_1');
      expect(body.activeUploads).toBe(2);
      expect(body.canUpload).toBe(true);
    });

    it('reports canUpload false once the live count reaches the tier limit', async () => {
      vi.mocked(uploadSemaphore.canAcquireSlot).mockResolvedValue(true);
      vi.mocked(countLiveUploadsForUser).mockResolvedValue(3);

      const request = new Request('https://example.com/api/storage/check');
      const res = await GET(request as never);
      const body = await res.json();

      expect(body.activeUploads).toBe(3);
      expect(body.canUpload).toBe(false);
    });

    it('reports canUpload false when this replica\'s global semaphore is exhausted even though the per-user count is under the tier limit (#2225 review — CodeRabbit round 7)', async () => {
      vi.mocked(uploadSemaphore.canAcquireSlot).mockResolvedValue(false);
      vi.mocked(countLiveUploadsForUser).mockResolvedValue(0);

      const request = new Request('https://example.com/api/storage/check');
      const res = await GET(request as never);
      const body = await res.json();

      expect(body.activeUploads).toBe(0);
      expect(body.canUpload).toBe(false);
    });
  });

  describe('POST /api/storage/check', () => {
    it('allows when both the local semaphore has global capacity and the cross-process count is under the tier limit', async () => {
      vi.mocked(uploadSemaphore.canAcquireSlot).mockResolvedValue(true);
      vi.mocked(countLiveUploadsForUser).mockResolvedValue(0);

      const res = await POST(postRequest() as never);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.allowed).toBe(true);
    });

    it('rejects with 429 when the cross-process per-user count is at the tier limit even though the local semaphore has global capacity', async () => {
      vi.mocked(uploadSemaphore.canAcquireSlot).mockResolvedValue(true);
      vi.mocked(countLiveUploadsForUser).mockResolvedValue(3);

      const res = await POST(postRequest() as never);
      const body = await res.json();

      expect(res.status).toBe(429);
      expect(body.allowed).toBe(false);
    });

    it('rejects with 429 when this replica\'s global semaphore is exhausted even though the per-user count is under the tier limit (#2225 review — Codex round 6)', async () => {
      vi.mocked(uploadSemaphore.canAcquireSlot).mockResolvedValue(false);
      vi.mocked(countLiveUploadsForUser).mockResolvedValue(0);

      const res = await POST(postRequest() as never);
      const body = await res.json();

      expect(res.status).toBe(429);
      expect(body.allowed).toBe(false);
    });
  });

  // #2719 review P1-1: the page-tree drop pre-checks the quota of the drive it drops into, so a
  // member whose personal quota is full can still drop into an org drive with room. A drive is
  // honoured only when the permissions seam says the caller can upload into it; anything else
  // fails CLOSED to the caller's personal quota, identically whether or not the drive exists.
  describe('WAL-9 (partial) POST /api/storage/check against the drop target drive', () => {
    beforeEach(() => {
      vi.mocked(checkUploadQuotaTarget).mockImplementation(fakeCheck);
      vi.mocked(uploadSemaphore.canAcquireSlot).mockResolvedValue(true);
      vi.mocked(countLiveUploadsForUser).mockResolvedValue(0);
    });

    it('allows a drop into an org drive with room when the personal quota is full', async () => {
      vi.mocked(getUserDrivePermissions).mockResolvedValue(EDITOR);
      dropBody({ fileSize: 10 * MiB, driveId: 'drive_org' });

      const res = await POST(postRequest() as never);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.allowed).toBe(true);
      expect(getUserDrivePermissions).toHaveBeenCalledWith('user_1', 'drive_org');
      expect(resolveUploadQuotaTarget).toHaveBeenCalledWith('user_1', 'drive_org');
      expect(body.quota).toMatchObject({ orgId: 'org_northwind' });
    });

    it('refuses a drop into a personal drive when the personal quota is full', async () => {
      vi.mocked(getUserDrivePermissions).mockResolvedValue({ ...EDITOR, isOwner: true, isMember: false });
      dropBody({ fileSize: 10 * MiB, driveId: 'drive_own' });

      const res = await POST(postRequest() as never);
      const body = await res.json();

      expect(res.status).toBe(413);
      expect(body.allowed).toBe(false);
      expect(body.quota).toMatchObject({ userId: 'user_1' });
    });

    it('refuses a drop naming an org drive the caller cannot access, checking the personal quota instead', async () => {
      vi.mocked(getUserDrivePermissions).mockResolvedValue(null);
      dropBody({ fileSize: 10 * MiB, driveId: 'drive_org_other' });

      const res = await POST(postRequest() as never);
      const body = await res.json();

      expect(res.status).toBe(413);
      expect(body.allowed).toBe(false);
      expect(resolveUploadQuotaTarget).toHaveBeenCalledWith('user_1', null);
      expect(resolveUploadQuotaTarget).not.toHaveBeenCalledWith('user_1', 'drive_org_other');
      expect(JSON.stringify(body)).not.toContain('org_other');
    });

    it('refuses a drop into an org drive the caller can only view: upload needs drive-wide edit, as presign does', async () => {
      vi.mocked(getUserDrivePermissions).mockResolvedValue(VIEWER);
      dropBody({ fileSize: 10 * MiB, driveId: 'drive_org' });

      const res = await POST(postRequest() as never);

      expect(res.status).toBe(413);
      expect(resolveUploadQuotaTarget).toHaveBeenCalledWith('user_1', null);
    });

    it('answers an inaccessible drive exactly as a drive that does not exist, and as no drive at all', async () => {
      vi.mocked(getUserDrivePermissions).mockResolvedValue(null);
      const answers: Array<{ status: number; body: unknown }> = [];
      for (const body of [{ fileSize: 10 * MiB, driveId: 'drive_org_other' }, { fileSize: 10 * MiB, driveId: 'no_such_drive' }, { fileSize: 10 * MiB }]) {
        dropBody(body);
        const res = await POST(postRequest() as never);
        answers.push({ status: res.status, body: await res.json() });
      }

      expect(answers[0]).toEqual(answers[2]);
      expect(answers[1]).toEqual(answers[2]);
    });

    it('does not ask the permissions seam when the drop names no drive', async () => {
      dropBody({ fileSize: 10 * MiB });

      await POST(postRequest() as never);

      expect(getUserDrivePermissions).not.toHaveBeenCalled();
      expect(resolveUploadQuotaTarget).toHaveBeenCalledWith('user_1', null);
    });

    it('checks the per-user concurrency limit against the uploader\'s own tier, as presign\'s atomic reserve does', async () => {
      vi.mocked(getUserDrivePermissions).mockResolvedValue(EDITOR);
      vi.mocked(countLiveUploadsForUser).mockResolvedValue(3);
      dropBody({ fileSize: 10 * MiB, driveId: 'drive_org' });

      const res = await POST(postRequest() as never);

      expect(res.status).toBe(429);
      expect(uploadSemaphore.canAcquireSlot).toHaveBeenCalledWith('user_1', 'business');
    });
  });
});
