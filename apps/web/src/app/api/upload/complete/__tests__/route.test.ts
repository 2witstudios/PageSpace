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

const mockTransaction = vi.fn();
const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockFilesFindFirst = vi.fn();
// Default files-row insert result: a single row (this completion inserted it →
// fileWasInserted=true). Individual tests override for dedup/claim scenarios.
let filesInsertReturning: Array<{ id: string }> = [];

vi.mock('@pagespace/db/db', () => ({
  db: {
    transaction: (...args: unknown[]) => mockTransaction(...args),
    query: {
      pages: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
  desc: vi.fn(),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: 'pages',
  drives: 'drives',
}));

vi.mock('@pagespace/db/schema/storage', () => ({
  files: 'files',
  filePages: 'filePages',
}));

vi.mock('@pagespace/lib/utils/enums', () => ({
  PageType: { FILE: 'FILE' },
}));

vi.mock('@pagespace/lib/services/storage-limits', () => ({
  updateStorageUsage: vi.fn(),
  // Real (pure) impl: charge iff the files row was newly inserted.
  shouldChargeForStore: (inserted: boolean) => inserted,
}));

vi.mock('@pagespace/lib/services/pending-uploads', () => ({
  releasePendingUpload: vi.fn(),
}));

vi.mock('@pagespace/lib/services/upload-semaphore', () => ({
  uploadSemaphore: {
    getSlotMetadata: vi.fn(),
    releaseUploadSlot: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({}),
  logFileActivity: vi.fn(),
}));

vi.mock('@/lib/upload/processor-effects', () => ({
  enqueueProcessorJob: vi.fn(),
}));

const mockCheckObjectExists = vi.fn();
vi.mock('@/lib/upload/s3-effects', () => ({
  checkObjectExists: (...args: unknown[]) => mockCheckObjectExists(...args),
}));

vi.mock('@pagespace/lib/services/upload-validation', () => ({
  buildS3Key: (hash: string) => `files/${hash}/original`,
  // Real (pure) impl of the H3 atomic link gate.
  canLinkExistingFileRow: ({ fileWasInserted, ownedByCaller, callerAlreadyReferences }: { fileWasInserted: boolean; ownedByCaller: boolean; callerAlreadyReferences: boolean }) =>
    fileWasInserted || ownedByCaller || callerAlreadyReferences,
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { getUserDrivePermissions } from '@pagespace/lib/permissions/permissions';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { updateStorageUsage } from '@pagespace/lib/services/storage-limits';
import { releasePendingUpload } from '@pagespace/lib/services/pending-uploads';
import { enqueueProcessorJob } from '@/lib/upload/processor-effects';

// Captures the values passed to tx.insert(pages).values(...) for assertion
let capturedPageValues: Record<string, unknown> | undefined;

// resolveUploadPosition runs on the transaction executor, so the tx must expose
// the same query mocks as db.query.
const txQuery = {
  pages: {
    findFirst: (...args: unknown[]) => mockFindFirst(...args),
    findMany: (...args: unknown[]) => mockFindMany(...args),
  },
  files: {
    findFirst: (...args: unknown[]) => mockFilesFindFirst(...args),
  },
};

function makeTxImpl() {
  return async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      query: txQuery,
      insert: (table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          if (table === 'pages') capturedPageValues = vals;
          return {
            returning: vi.fn().mockResolvedValue([MOCK_PAGE]),
            // files insert: onConflictDoNothing().returning({id}) → filesInsertReturning.
            onConflictDoNothing: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(filesInsertReturning) }),
            onConflictDoUpdate: vi.fn().mockResolvedValue([]),
          };
        },
      }),
    };
    return fn(tx);
  };
}

const VALID_HASH = 'b'.repeat(64);
const MOCK_JOB_ID = 'user-1-slot-xyz';

function makeAuth(userId = 'user-1') {
  return { userId, tokenType: 'session' as const, tokenVersion: 0, sessionId: 's', role: 'user' as const, adminRoleVersion: 0 };
}

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Only jobId/title/parentId are read from the body now; the rest is trusted slot metadata.
const VALID_BODY = {
  jobId: MOCK_JOB_ID,
  title: 'photo.jpg',
  parentId: null,
};

// Default: the common new-upload path. The files-row insert succeeds in the tx
// (filesInsertReturning has a row → fileWasInserted=true), so the H3 link gate
// allows it regardless of references.
const SLOT_META = { contentHash: VALID_HASH, driveId: 'drive-1', fileSize: 2048, mimeType: 'image/jpeg', callerAlreadyReferences: false };

const MOCK_PAGE = { id: 'page-abc', title: 'photo.jpg', type: 'FILE', driveId: 'drive-1', contentHash: VALID_HASH };

beforeEach(() => {
  vi.clearAllMocks();
  capturedPageValues = undefined;
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(makeAuth());
  vi.mocked(getUserDrivePermissions).mockResolvedValue({ hasAccess: true, isOwner: true, isAdmin: false, isMember: false, canEdit: true });
  vi.mocked(uploadSemaphore.getSlotMetadata).mockReturnValue(SLOT_META);
  vi.mocked(enqueueProcessorJob).mockResolvedValue(undefined);
  vi.mocked(releasePendingUpload).mockResolvedValue(undefined);

  // Default sibling lookups: empty list (new page lands at position 0).
  mockFindFirst.mockResolvedValue(undefined);
  mockFindMany.mockResolvedValue([]);
  // Default: the files-row insert succeeds (first physical store → fileWasInserted).
  filesInsertReturning = [{ id: VALID_HASH }];
  mockFilesFindFirst.mockResolvedValue(undefined);
  // Default: the uploaded object is present in storage.
  mockCheckObjectExists.mockResolvedValue(true);

  mockTransaction.mockImplementation(makeTxImpl());
});

describe('POST /api/upload/complete', () => {
  describe('authentication', () => {
    it('returns 401 when the request is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: new Response(null, { status: 401 }) } as never);
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(401);
    });
  });

  describe('jobId verification', () => {
    it('returns 403 when the jobId has no reserved slot for the user', async () => {
      vi.mocked(uploadSemaphore.getSlotMetadata).mockReturnValue(null);
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(403);
    });

    it('uses the slot metadata (not the request body) for the trusted upload params', async () => {
      // Body lies about the drive; the route must use the reserved drive-1 instead.
      const res = await POST(makeRequest({ ...VALID_BODY, driveId: 'attacker-drive', contentHash: 'f'.repeat(64) }));
      expect(res.status).toBe(200);
      expect(capturedPageValues?.driveId).toBe('drive-1');
      expect(capturedPageValues?.contentHash).toBe(VALID_HASH);
    });

    it('returns 400 when required fields are missing', async () => {
      const { jobId: _, ...incomplete } = VALID_BODY;
      const res = await POST(makeRequest(incomplete));
      expect(res.status).toBe(400);
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

    it('does not create a page record when drive access is denied', async () => {
      vi.mocked(getUserDrivePermissions).mockResolvedValue(null);
      await POST(makeRequest(VALID_BODY));
      expect(mockTransaction).not.toHaveBeenCalled();
    });
  });

  describe('object verification', () => {
    it('returns 409 and creates no page when the uploaded object is missing from storage', async () => {
      mockCheckObjectExists.mockResolvedValue(false);
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(409);
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('releases the slot when the object is missing', async () => {
      mockCheckObjectExists.mockResolvedValue(false);
      await POST(makeRequest(VALID_BODY));
      expect(uploadSemaphore.releaseUploadSlot).toHaveBeenCalledWith(MOCK_JOB_ID);
    });
  });

  describe('parent validation', () => {
    it('returns 400 when the parent page belongs to a different drive', async () => {
      mockFindFirst.mockResolvedValueOnce({ id: 'parent-x', driveId: 'other-drive', isTrashed: false });
      const res = await POST(makeRequest({ ...VALID_BODY, parentId: 'parent-x' }));
      expect(res.status).toBe(400);
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('returns 400 when the parent page is trashed', async () => {
      mockFindFirst.mockResolvedValueOnce({ id: 'parent-x', driveId: 'drive-1', isTrashed: true });
      const res = await POST(makeRequest({ ...VALID_BODY, parentId: 'parent-x' }));
      expect(res.status).toBe(400);
    });

    it('accepts a parent in the reserved drive', async () => {
      // 1st findFirst = parent lookup; 2nd = sibling append lookup (none).
      mockFindFirst
        .mockResolvedValueOnce({ id: 'parent-x', driveId: 'drive-1', isTrashed: false })
        .mockResolvedValueOnce(undefined);
      const res = await POST(makeRequest({ ...VALID_BODY, parentId: 'parent-x' }));
      expect(res.status).toBe(200);
      expect(capturedPageValues?.parentId).toBe('parent-x');
    });
  });

  describe('page record', () => {
    it('stores the raw content hash in filePath, not the S3 key', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(capturedPageValues?.filePath).toBe(VALID_HASH);
    });
  });

  describe('happy path', () => {
    it('returns 200 with the created page', async () => {
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.page).toBeDefined();
    });

    it('releases the upload slot after successful insert', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(uploadSemaphore.releaseUploadSlot).toHaveBeenCalledWith(MOCK_JOB_ID);
    });

    it('releases the pending-upload reservation after successful insert', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(releasePendingUpload).toHaveBeenCalledWith(MOCK_JOB_ID);
    });

    it('enqueues the processor job after the DB transaction commits', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(enqueueProcessorJob).toHaveBeenCalledWith('user-1', 'drive-1', expect.any(String));
    });

    it('does not enqueue the processor job inside the DB transaction', async () => {
      const callOrder: string[] = [];
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: txQuery,
          insert: () => ({
            values: () => ({
              returning: vi.fn().mockResolvedValue([MOCK_PAGE]),
              onConflictDoNothing: () => ({ returning: vi.fn().mockResolvedValue([{ id: VALID_HASH }]) }),
              onConflictDoUpdate: vi.fn().mockResolvedValue([]),
            }),
          }),
        };
        const result = await fn(tx);
        callOrder.push('tx-complete');
        return result;
      });
      vi.mocked(enqueueProcessorJob).mockImplementation(async () => {
        callOrder.push('enqueue');
      });

      await POST(makeRequest(VALID_BODY));
      const txIdx = callOrder.indexOf('tx-complete');
      const enqIdx = callOrder.indexOf('enqueue');
      expect(txIdx).toBeLessThan(enqIdx);
    });
  });

  describe('tree ordering (position)', () => {
    it('appends after the last sibling (last.position + 1) by default', async () => {
      mockFindFirst.mockResolvedValue({ id: 'last', position: 5 });
      await POST(makeRequest(VALID_BODY));
      expect(capturedPageValues?.position).toBe(6);
    });

    it('uses position 0 for the first page in an empty sibling list', async () => {
      mockFindFirst.mockResolvedValue(undefined);
      await POST(makeRequest(VALID_BODY));
      expect(capturedPageValues?.position).toBe(0);
    });

    it('inserts at the midpoint before a target node', async () => {
      mockFindMany.mockResolvedValue([
        { id: 'a', position: 2 },
        { id: 'sibling', position: 4 },
      ]);
      await POST(makeRequest({ ...VALID_BODY, position: 'before', afterNodeId: 'sibling' }));
      expect(capturedPageValues?.position).toBe(3); // (2 + 4) / 2
    });

    it('anchors below the target when inserting before the first sibling (no position-0 collision)', async () => {
      mockFindMany.mockResolvedValue([{ id: 'first', position: 0 }]);
      await POST(makeRequest({ ...VALID_BODY, position: 'before', afterNodeId: 'first' }));
      expect(capturedPageValues?.position).toBe(-0.5); // ((0 - 1) + 0) / 2
    });

    it('inserts at the midpoint after a target node', async () => {
      mockFindMany.mockResolvedValue([
        { id: 'sibling', position: 4 },
        { id: 'b', position: 8 },
      ]);
      await POST(makeRequest({ ...VALID_BODY, position: 'after', afterNodeId: 'sibling' }));
      expect(capturedPageValues?.position).toBe(6); // (4 + 8) / 2
    });

    it('falls back to appending when afterNodeId is not among the siblings', async () => {
      // 'ghost' isn't in the sibling set, so resolution appends after the last.
      mockFindMany.mockResolvedValue([{ id: 'a', position: 2 }]);
      mockFindFirst.mockResolvedValue({ id: 'last', position: 9 });
      await POST(makeRequest({ ...VALID_BODY, position: 'before', afterNodeId: 'ghost' }));
      expect(capturedPageValues?.position).toBe(10);
    });
  });

  describe('H3 — atomic cross-tenant claim defense at finalize', () => {
    it('rejects (409, rolled back) when an existing files row is owned by another tenant and the caller does not reference it', async () => {
      // files insert conflicts (row already exists), owned by a different user,
      // caller does not reference → the in-tx ownership claim throws → 409.
      filesInsertReturning = [];
      mockFilesFindFirst.mockResolvedValue({ createdBy: 'other-tenant' });
      vi.mocked(uploadSemaphore.getSlotMetadata).mockReturnValue({ ...SLOT_META, callerAlreadyReferences: false });

      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(409);
      expect(uploadSemaphore.releaseUploadSlot).toHaveBeenCalledWith(MOCK_JOB_ID);
      expect(releasePendingUpload).toHaveBeenCalledWith(MOCK_JOB_ID);
      // No storage charge for a rejected claim.
      expect(updateStorageUsage).not.toHaveBeenCalled();
    });

    it('allows a referencing caller to link a pre-existing (foreign-owned) object (legit dedup)', async () => {
      filesInsertReturning = [];
      mockFilesFindFirst.mockResolvedValue({ createdBy: 'other-tenant' });
      vi.mocked(uploadSemaphore.getSlotMetadata).mockReturnValue({ ...SLOT_META, callerAlreadyReferences: true });

      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(200);
    });

    it('allows the caller to re-link a pre-existing object they own (createdBy === caller)', async () => {
      filesInsertReturning = [];
      mockFilesFindFirst.mockResolvedValue({ createdBy: 'user-1' });
      vi.mocked(uploadSemaphore.getSlotMetadata).mockReturnValue({ ...SLOT_META, callerAlreadyReferences: false });

      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(200);
    });
  });

  describe('M8 — charge only on first physical store', () => {
    it('charges storage when the files row was newly inserted', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(updateStorageUsage).toHaveBeenCalledWith('user-1', 2048, expect.objectContaining({ eventType: 'upload' }));
    });

    it('does NOT charge storage on a legit dedup completion (files row already existed, caller references)', async () => {
      // Row already exists (insert conflict → []), caller already references it
      // so the link is allowed, but no new bytes were stored → no charge.
      filesInsertReturning = [];
      mockFilesFindFirst.mockResolvedValue({ createdBy: 'user-1' });
      await POST(makeRequest(VALID_BODY));
      expect(updateStorageUsage).not.toHaveBeenCalled();
    });
  });

  describe('slot leak prevention', () => {
    it('releases the slot even when the processor job enqueue fails', async () => {
      vi.mocked(enqueueProcessorJob).mockRejectedValue(new Error('processor down'));
      await POST(makeRequest(VALID_BODY));
      // Response may vary but slot must be released
      expect(uploadSemaphore.releaseUploadSlot).toHaveBeenCalledWith(MOCK_JOB_ID);
    });
  });
});
