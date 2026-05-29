import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r !== null && typeof r === 'object' && 'error' in r),
  checkMCPCreateScope: vi.fn(() => null),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserDrivePermissions: vi.fn(),
}));

const mockTransaction = vi.fn();

vi.mock('@pagespace/db/db', () => ({
  db: {
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
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
  updateActiveUploads: vi.fn(),
  updateStorageUsage: vi.fn(),
}));

vi.mock('@pagespace/lib/services/upload-semaphore', () => ({
  uploadSemaphore: {
    verifySlotOwner: vi.fn(),
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

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { getUserDrivePermissions } from '@pagespace/lib/permissions/permissions';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { updateActiveUploads } from '@pagespace/lib/services/storage-limits';
import { enqueueProcessorJob } from '@/lib/upload/processor-effects';

// Captures the values passed to tx.insert(pages).values(...) for assertion
let capturedPageValues: Record<string, unknown> | undefined;

function makeTxImpl() {
  return async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert: (table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          if (table === 'pages') capturedPageValues = vals;
          return {
            returning: vi.fn().mockResolvedValue([MOCK_PAGE]),
            onConflictDoNothing: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: VALID_HASH }]) }),
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

const VALID_BODY = {
  jobId: MOCK_JOB_ID,
  contentHash: VALID_HASH,
  driveId: 'drive-1',
  title: 'photo.jpg',
  mimeType: 'image/jpeg',
  fileSize: 2048,
  parentId: null,
};

const MOCK_PAGE = { id: 'page-abc', title: 'photo.jpg', type: 'FILE', driveId: 'drive-1', contentHash: VALID_HASH };

beforeEach(() => {
  vi.clearAllMocks();
  capturedPageValues = undefined;
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(makeAuth());
  vi.mocked(getUserDrivePermissions).mockResolvedValue({ hasAccess: true, isOwner: true, isAdmin: false, isMember: false, canEdit: true });
  vi.mocked(uploadSemaphore.verifySlotOwner).mockReturnValue(true);
  vi.mocked(enqueueProcessorJob).mockResolvedValue(undefined);
  vi.mocked(updateActiveUploads).mockResolvedValue(undefined);

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
    it('returns 403 when jobId does not belong to the authenticated user', async () => {
      vi.mocked(uploadSemaphore.verifySlotOwner).mockReturnValue(false);
      const res = await POST(makeRequest(VALID_BODY));
      expect(res.status).toBe(403);
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

    it('decrements activeUploads after successful insert', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(updateActiveUploads).toHaveBeenCalledWith('user-1', -1);
    });

    it('enqueues the processor job after the DB transaction commits', async () => {
      await POST(makeRequest(VALID_BODY));
      expect(enqueueProcessorJob).toHaveBeenCalledWith('user-1', 'drive-1', expect.any(String));
    });

    it('does not enqueue the processor job inside the DB transaction', async () => {
      const callOrder: string[] = [];
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
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

  describe('slot leak prevention', () => {
    it('releases the slot even when the processor job enqueue fails', async () => {
      vi.mocked(enqueueProcessorJob).mockRejectedValue(new Error('processor down'));
      await POST(makeRequest(VALID_BODY));
      // Response may vary but slot must be released
      expect(uploadSemaphore.releaseUploadSlot).toHaveBeenCalledWith(MOCK_JOB_ID);
    });
  });
});
