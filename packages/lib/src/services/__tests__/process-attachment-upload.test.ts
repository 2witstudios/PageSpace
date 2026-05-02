import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Database boundary mocks ----------------------------------------------------
const mockDmConversationsFindFirst = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      dmConversations: {
        findFirst: (...args: unknown[]) => mockDmConversationsFindFirst(...args),
      },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: string, value: unknown) => ({ field, value })),
}));
vi.mock('@pagespace/db/schema/social', () => ({
  dmConversations: { id: 'dm_conversations.id' },
}));
vi.mock('@pagespace/db/schema/storage', () => ({
  files: { id: 'files.id' },
  filePages: { fileId: 'file_pages.fileId' },
  fileConversations: { fileId: 'file_conversations.fileId' },
}));

// --- Repository seam (the unit boundary we assert against) ----------------------
const mockSaveFileRecord = vi.fn();
const mockLinkFileToTarget = vi.fn();
vi.mock('../attachment-upload-repository', () => ({
  attachmentUploadRepository: {
    saveFileRecord: (...args: unknown[]) => mockSaveFileRecord(...args),
    linkFileToTarget: (...args: unknown[]) => mockLinkFileToTarget(...args),
  },
}));

// --- Token issuer (delegated to the createUploadServiceToken mock for page) -----
const mockCreateUploadServiceToken = vi.fn();
vi.mock('../validated-service-token', () => {
  class PermissionDeniedError extends Error {
    readonly code = 'PERMISSION_DENIED' as const;
    constructor(message: string) {
      super(message);
      this.name = 'PermissionDeniedError';
    }
  }
  function isPermissionDeniedError(error: unknown): error is PermissionDeniedError {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: unknown }).code === 'PERMISSION_DENIED'
    );
  }
  return {
    createUploadServiceToken: (...args: unknown[]) => mockCreateUploadServiceToken(...args),
    PermissionDeniedError,
    isPermissionDeniedError,
  };
});

const mockCreateSession = vi.fn().mockResolvedValue('ps_svc_conversation-token');
vi.mock('../../auth/session-service', () => ({
  sessionService: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
  },
}));

// --- Storage / quota / semaphore / memory ---------------------------------------
// Mock paths resolve relative to THIS test file (src/services/__tests__/).
// They must match the SUT's import specifiers AFTER resolution, so paths here use
// `../` to reach src/services/ where the SUT lives.
const mockCheckStorageQuota = vi.fn();
const mockGetUserStorageQuota = vi.fn();
const mockUpdateStorageUsage = vi.fn();
vi.mock('../storage-limits', () => ({
  checkStorageQuota: (...args: unknown[]) => mockCheckStorageQuota(...args),
  updateStorageUsage: (...args: unknown[]) => mockUpdateStorageUsage(...args),
  getUserStorageQuota: (...args: unknown[]) => mockGetUserStorageQuota(...args),
  formatBytes: (n: number) => `${n}B`,
}));

const mockAcquireUploadSlot = vi.fn();
const mockReleaseUploadSlot = vi.fn();
vi.mock('../upload-semaphore', () => ({
  uploadSemaphore: {
    acquireUploadSlot: (...args: unknown[]) => mockAcquireUploadSlot(...args),
    releaseUploadSlot: (...args: unknown[]) => mockReleaseUploadSlot(...args),
  },
}));

const mockCheckMemoryMiddleware = vi.fn();
vi.mock('../memory-monitor', () => ({
  checkMemoryMiddleware: (...args: unknown[]) => mockCheckMemoryMiddleware(...args),
}));

// --- Audit + activity -----------------------------------------------------------
const mockAuditRequest = vi.fn();
vi.mock('../../audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));

const mockGetActorInfo = vi.fn().mockResolvedValue({ actorEmail: 'u@u', actorDisplayName: 'U' });
const mockLogFileActivity = vi.fn();
vi.mock('../../monitoring/activity-logger', () => ({
  getActorInfo: (...args: unknown[]) => mockGetActorInfo(...args),
  logFileActivity: (...args: unknown[]) => mockLogFileActivity(...args),
}));

vi.mock('../../utils/file-security', () => ({
  sanitizeFilenameForHeader: (name: string) => name,
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

// --- Imports under test ---------------------------------------------------------
import { processAttachmentUpload, type AttachmentTarget } from '../attachment-upload';

// --- Helpers --------------------------------------------------------------------
const FAKE_HASH = 'h'.repeat(64);
const PROCESSOR_OK = {
  ok: true,
  status: 200,
  json: async () => ({ contentHash: FAKE_HASH, size: 1024 }),
};

function buildRequest(file: File): Request {
  const fd = new FormData();
  fd.append('file', file);
  // Construct via a Request — Next's NextRequest is structurally compatible for
  // the formData() / headers() surface this code touches.
  return new Request('http://localhost/upload', { method: 'POST', body: fd });
}

function makeFile(name = 'hello.png', type = 'image/png', size = 1024): File {
  const blob = new Blob([new Uint8Array(size)], { type });
  return new File([blob], name, { type });
}

const PAGE_TARGET: AttachmentTarget = { type: 'page', pageId: 'page-1', driveId: 'drive-1' };
const CONV_TARGET: AttachmentTarget = { type: 'conversation', conversationId: 'conv-1' };

function setHappyPathDefaults() {
  mockCheckMemoryMiddleware.mockResolvedValue({ allowed: true });
  mockCheckStorageQuota.mockResolvedValue({ allowed: true });
  mockGetUserStorageQuota.mockResolvedValue({
    tier: 'free',
    usedBytes: 100,
    quotaBytes: 1_000_000,
  });
  mockAcquireUploadSlot.mockResolvedValue('slot-1');
  mockCreateUploadServiceToken.mockResolvedValue({
    token: 'ps_svc_page-token',
    grantedScopes: ['files:write'],
  });
  mockCreateSession.mockResolvedValue('ps_svc_conv-token');
  mockSaveFileRecord.mockResolvedValue(undefined);
  mockLinkFileToTarget.mockResolvedValue(undefined);
  mockUpdateStorageUsage.mockResolvedValue(undefined);
  mockDmConversationsFindFirst.mockResolvedValue({
    id: 'conv-1',
    participant1Id: 'user-1',
    participant2Id: 'user-2',
  });
  globalThis.fetch = vi.fn().mockResolvedValue(PROCESSOR_OK) as unknown as typeof fetch;
}

describe('processAttachmentUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setHappyPathDefaults();
  });

  describe('happy path — page target', () => {
    it('inserts file row scoped to the drive and a filePages linkage (no fileConversations)', async () => {
      const request = buildRequest(makeFile('a.png', 'image/png', 1024));
      const res = await processAttachmentUpload({
        request,
        target: PAGE_TARGET,
        userId: 'user-1',
      });

      expect(res.status).toBe(200);
      // File row carries the real driveId
      expect(mockSaveFileRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          id: FAKE_HASH,
          driveId: 'drive-1',
          createdBy: 'user-1',
          sizeBytes: 1024,
          mimeType: 'image/png',
          storagePath: FAKE_HASH,
        })
      );
      // Linkage goes through linkFileToTarget with the page target
      expect(mockLinkFileToTarget).toHaveBeenCalledWith({
        target: PAGE_TARGET,
        fileId: FAKE_HASH,
        userId: 'user-1',
      });
    });
  });

  describe('happy path — conversation target', () => {
    it('inserts file row with NULL driveId and a fileConversations linkage (no filePages)', async () => {
      // Processor returns its own measured size; SUT must use that, not the client claim.
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ contentHash: FAKE_HASH, size: 2048 }),
      }) as unknown as typeof fetch;

      const request = buildRequest(makeFile('b.pdf', 'application/pdf', 2048));
      const res = await processAttachmentUpload({
        request,
        target: CONV_TARGET,
        userId: 'user-1',
      });

      expect(res.status).toBe(200);
      // DM files have no drive
      expect(mockSaveFileRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          id: FAKE_HASH,
          driveId: null,
          createdBy: 'user-1',
          sizeBytes: 2048,
          mimeType: 'application/pdf',
        })
      );
      // Linkage goes through linkFileToTarget with the conversation target
      expect(mockLinkFileToTarget).toHaveBeenCalledWith({
        target: CONV_TARGET,
        fileId: FAKE_HASH,
        userId: 'user-1',
      });
      // Page token mint must not be called for conversation flow
      expect(mockCreateUploadServiceToken).not.toHaveBeenCalled();
      // Conversation-bound session token IS minted
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceType: 'conversation',
          resourceId: 'conv-1',
        })
      );
    });
  });

  describe('quota & semaphore enforcement', () => {
    it('returns 413 and does not mint a token or hold a semaphore slot when quota is exceeded', async () => {
      mockCheckStorageQuota.mockResolvedValueOnce({
        allowed: false,
        reason: 'Quota exceeded',
        quota: { used: 0, quota: 0 },
      });

      const request = buildRequest(makeFile());
      const res = await processAttachmentUpload({ request, target: PAGE_TARGET, userId: 'user-1' });

      expect(res.status).toBe(413);
      // Token mint should never be reached
      expect(mockCreateUploadServiceToken).not.toHaveBeenCalled();
      expect(mockCreateSession).not.toHaveBeenCalled();
      // Slot was never acquired in the first place
      expect(mockAcquireUploadSlot).not.toHaveBeenCalled();
      expect(mockReleaseUploadSlot).not.toHaveBeenCalled();
    });

    it('returns 429 when the upload semaphore is exhausted', async () => {
      mockAcquireUploadSlot.mockResolvedValueOnce(null);

      const request = buildRequest(makeFile());
      const res = await processAttachmentUpload({ request, target: PAGE_TARGET, userId: 'user-1' });

      expect(res.status).toBe(429);
      expect(mockCreateUploadServiceToken).not.toHaveBeenCalled();
    });

    it('releases the semaphore slot when the processor returns an error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'boom' }),
      }) as unknown as typeof fetch;

      const request = buildRequest(makeFile());
      const res = await processAttachmentUpload({ request, target: PAGE_TARGET, userId: 'user-1' });

      expect(res.status).toBe(500);
      // Slot was acquired and then released exactly once on the error path
      expect(mockAcquireUploadSlot).toHaveBeenCalledTimes(1);
      expect(mockReleaseUploadSlot).toHaveBeenCalledWith('slot-1');
    });
  });

  describe('response shape parity', () => {
    it('returns the same response keys for page and conversation targets', async () => {
      const reqA = buildRequest(makeFile('a.png', 'image/png', 256));
      const resA = await processAttachmentUpload({ request: reqA, target: PAGE_TARGET, userId: 'user-1' });
      const bodyA = await resA.json();

      const reqB = buildRequest(makeFile('b.png', 'image/png', 256));
      const resB = await processAttachmentUpload({ request: reqB, target: CONV_TARGET, userId: 'user-1' });
      const bodyB = await resB.json();

      // Top-level shape must match — the consumer (useAttachmentUpload) cannot branch on target type.
      expect(Object.keys(bodyA).sort()).toEqual(Object.keys(bodyB).sort());
      expect(bodyA.success).toBe(true);
      expect(bodyB.success).toBe(true);
      // File sub-shape must match
      expect(Object.keys(bodyA.file).sort()).toEqual(Object.keys(bodyB.file).sort());
    });
  });
});
