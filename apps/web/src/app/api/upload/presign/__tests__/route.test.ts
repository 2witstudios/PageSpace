import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r !== null && typeof r === 'object' && 'error' in r),
  checkMCPCreateScope: vi.fn(() => null),
  isScopedMCPAuth: vi.fn(() => false), // Session/unscoped fixtures by default
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserDrivePermissions: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppDriveAccessLevel: vi.fn(),
}));

vi.mock('@pagespace/lib/services/storage-limits', () => ({
  getUserStorageQuota: vi.fn(),
  checkStorageQuota: vi.fn(),
  userReferencesContentHash: vi.fn(),
}));

vi.mock('@pagespace/lib/services/pending-uploads', () => ({
  registerPendingUpload: vi.fn(),
  releasePendingUpload: vi.fn(),
}));

vi.mock('@pagespace/lib/services/upload-semaphore', () => ({
  uploadSemaphore: { acquireUploadSlot: vi.fn(), releaseUploadSlot: vi.fn() },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

vi.mock('@/lib/upload/s3-effects', () => ({
  checkObjectExists: vi.fn(),
  issuePresignedPutUrl: vi.fn(),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions, checkMCPCreateScope } from '@/lib/auth';
import { getUserDrivePermissions } from '@pagespace/lib/permissions/permissions';
import { getUserStorageQuota, checkStorageQuota, userReferencesContentHash } from '@pagespace/lib/services/storage-limits';
import { registerPendingUpload } from '@pagespace/lib/services/pending-uploads';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { checkObjectExists, issuePresignedPutUrl } from '@/lib/upload/s3-effects';

const VALID_HASH = 'a'.repeat(64);
const MOCK_URL = 'https://tigris.example.com/files/aaa.../original?X-Amz-Signature=abc';
const MOCK_SLOT = 'user-1-slot-abc';

function makeAuth(userId = 'user-1') {
  return { userId, tokenType: 'session' as const, tokenVersion: 0, sessionId: 's', role: 'user' as const, adminRoleVersion: 0 };
}

function makeQuota(tier = 'free' as const) {
  return { userId: 'user-1', tier, quotaBytes: 500 * 1024 * 1024, usedBytes: 0, availableBytes: 500 * 1024 * 1024, utilizationPercent: 0, warningLevel: 'none' as const };
}

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/upload/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  contentHash: VALID_HASH,
  driveId: 'drive-1',
  filename: 'photo.jpg',
  mimeType: 'image/jpeg',
  fileSize: 1024,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(makeAuth());
  vi.mocked(getUserDrivePermissions).mockResolvedValue({ hasAccess: true, isOwner: true, isAdmin: false, isMember: false, canEdit: true });
  vi.mocked(getUserStorageQuota).mockResolvedValue(makeQuota());
  vi.mocked(checkStorageQuota).mockResolvedValue({ allowed: true });
  vi.mocked(checkObjectExists).mockResolvedValue(false);
  vi.mocked(issuePresignedPutUrl).mockResolvedValue(MOCK_URL);
  vi.mocked(uploadSemaphore.acquireUploadSlot).mockResolvedValue(MOCK_SLOT);
  vi.mocked(registerPendingUpload).mockResolvedValue(undefined);
  // Default: caller already references the hash, so the dedup fast-path stays
  // available for the existing dedup tests. H3-specific tests override this.
  vi.mocked(userReferencesContentHash).mockResolvedValue(true);
});

describe('POST /api/upload/presign', () => {
  describe('authentication', () => {
    it('returns 401 when the request is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: new Response(null, { status: 401 }) } as never);
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(401);
    });
  });

  describe('scoped MCP tokens', () => {
    it('returns the scope error when the MCP token is not scoped to the drive', async () => {
      vi.mocked(checkMCPCreateScope).mockReturnValueOnce(
        new Response(JSON.stringify({ error: 'scope' }), { status: 403 }) as never,
      );
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(403);
      expect(issuePresignedPutUrl).not.toHaveBeenCalled();
    });
  });

  describe('storage quota', () => {
    it('returns 413 when the remaining storage/file-count quota is exceeded', async () => {
      vi.mocked(checkStorageQuota).mockResolvedValue({ allowed: false, reason: 'Quota exceeded' });
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(413);
      expect(uploadSemaphore.acquireUploadSlot).not.toHaveBeenCalled();
    });
  });

  describe('drive access', () => {
    it('returns 404 when the drive does not exist', async () => {
      vi.mocked(getUserDrivePermissions).mockResolvedValue(null);
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(404);
    });

    it('returns 403 when the user cannot edit the drive', async () => {
      vi.mocked(getUserDrivePermissions).mockResolvedValue({ hasAccess: true, isOwner: false, isAdmin: false, isMember: true, canEdit: false });
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(403);
    });

    it('does not issue a presigned URL when drive access is denied', async () => {
      vi.mocked(getUserDrivePermissions).mockResolvedValue(null);
      await POST(makeRequest(VALID_BODY));
      expect(issuePresignedPutUrl).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('returns 400 when contentHash is not valid hex', async () => {
      const res = await POST(makeRequest({ ...VALID_BODY, contentHash: 'not-a-hash' }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/hex/i);
    });

    it('returns 400 when mimeType is blocked', async () => {
      const res = await POST(makeRequest({ ...VALID_BODY, mimeType: 'text/html' }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/not allowed/i);
    });

    it('returns 400 when required fields are missing', async () => {
      const { contentHash: _, ...incomplete } = VALID_BODY;
      const res = await POST(makeRequest(incomplete));
      expect(res.status).toBe(400);
    });

    it('returns 413 when file size exceeds the tier limit', async () => {
      vi.mocked(getUserStorageQuota).mockResolvedValue(makeQuota('free'));
      const overFreeLimit = { ...VALID_BODY, fileSize: 50 * 1024 * 1024 + 1 };
      const res = await POST(makeRequest(overFreeLimit));
      expect(res.status).toBe(413);
    });

    it('returns 500 when getUserStorageQuota returns null', async () => {
      vi.mocked(getUserStorageQuota).mockResolvedValue(null);
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(500);
    });
  });

  describe('deduplication', () => {
    it('returns alreadyExists true without issuing a URL when the object already exists in S3', async () => {
      vi.mocked(checkObjectExists).mockResolvedValue(true);
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.alreadyExists).toBe(true);
      expect(issuePresignedPutUrl).not.toHaveBeenCalled();
    });

    it('returns the S3 key so the client can call complete directly on dedup', async () => {
      vi.mocked(checkObjectExists).mockResolvedValue(true);
      const res = await POST(makeRequest(VALID_BODY));
      const body = await res.json();
      expect(body.key).toBe(`files/${VALID_HASH}/original`);
    });

    it('still reserves a slot and returns a jobId on dedup so the client can call complete', async () => {
      vi.mocked(checkObjectExists).mockResolvedValue(true);
      const res = await POST(makeRequest(VALID_BODY));
      const body = await res.json();
      expect(body.jobId).toBe(MOCK_SLOT);
      expect(uploadSemaphore.acquireUploadSlot).toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('issues a presigned PUT URL via issuePresignedPutUrl', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(200);
      expect(issuePresignedPutUrl).toHaveBeenCalledWith(
        `files/${VALID_HASH}/original`,
        'image/jpeg',
        1024,
        900,
      );
    });

    it('returns url, jobId, key, and expiresAt in the response', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      const body = await res.json();
      expect(body.url).toBe(MOCK_URL);
      expect(body.jobId).toBe(MOCK_SLOT);
      expect(body.key).toBe(`files/${VALID_HASH}/original`);
      expect(typeof body.expiresAt).toBe('string');
    });

    it('reserves an upload slot via acquireUploadSlot with the server-trusted H3 facts', async () => {
      vi.mocked(checkObjectExists).mockResolvedValue(false);
      vi.mocked(userReferencesContentHash).mockResolvedValue(false);
      await POST(makeRequest(VALID_BODY));
      expect(uploadSemaphore.acquireUploadSlot).toHaveBeenCalledWith('user-1', 'free', 1024, {
        contentHash: VALID_HASH,
        driveId: 'drive-1',
        fileSize: 1024,
        mimeType: 'image/jpeg',
        callerAlreadyReferences: false,
      });
    });

    it('registers a pending-upload reservation after acquiring the slot', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(registerPendingUpload).toHaveBeenCalledWith(MOCK_SLOT, 'user-1', 1024);
    });
  });

  describe('H3 — cross-tenant file claim defense', () => {
    it('honors the dedup fast-path when the object exists AND the caller already references the hash', async () => {
      vi.mocked(checkObjectExists).mockResolvedValue(true);
      vi.mocked(userReferencesContentHash).mockResolvedValue(true);
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.alreadyExists).toBe(true);
      expect(issuePresignedPutUrl).not.toHaveBeenCalled();
    });

    it('rejects (409) when the object exists but the caller does not reference the hash — no claim, no PUT URL', async () => {
      vi.mocked(checkObjectExists).mockResolvedValue(true);
      vi.mocked(userReferencesContentHash).mockResolvedValue(false);
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(409);
      // Never hand out a canonical-key PUT URL to a non-possessor (corruption risk).
      expect(issuePresignedPutUrl).not.toHaveBeenCalled();
      // Rejected before reserving a slot.
      expect(uploadSemaphore.acquireUploadSlot).not.toHaveBeenCalled();
    });

    it('issues a real PUT URL (no fast-path) when the object does not yet exist, even for a non-referencing caller', async () => {
      vi.mocked(checkObjectExists).mockResolvedValue(false);
      vi.mocked(userReferencesContentHash).mockResolvedValue(false);
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe(MOCK_URL);
      expect(body.alreadyExists).toBeUndefined();
    });

    it('checks references against the canonicalized (lowercased) hash', async () => {
      vi.mocked(checkObjectExists).mockResolvedValue(false);
      await POST(makeRequest({ ...VALID_BODY, contentHash: 'A'.repeat(64) }));
      expect(userReferencesContentHash).toHaveBeenCalledWith('user-1', 'a'.repeat(64), 'drive-1');
    });
  });

  describe('slot exhaustion', () => {
    it('returns 429 when no upload slot is available', async () => {
      vi.mocked(uploadSemaphore.acquireUploadSlot).mockResolvedValue(null);
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(429);
    });

    it('does not register a pending-upload reservation when slot acquisition fails', async () => {
      vi.mocked(uploadSemaphore.acquireUploadSlot).mockResolvedValue(null);
      await POST(makeRequest(VALID_BODY));
      expect(registerPendingUpload).not.toHaveBeenCalled();
    });
  });
});
