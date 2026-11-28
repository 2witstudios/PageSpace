import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Effect seams (pure core is left real) -------------------------------------
const mockResolveUploadQuotaTarget = vi.fn();
const mockCheckUploadQuotaTarget = vi.fn();
const mockReserveConcurrentUploadSlot = vi.fn();
const mockUpdateStorageUsage = vi.fn();
vi.mock('@pagespace/lib/services/storage-limits', () => ({
  resolveUploadQuotaTarget: (...a: unknown[]) => mockResolveUploadQuotaTarget(...a),
  checkUploadQuotaTarget: (...a: unknown[]) => mockCheckUploadQuotaTarget(...a),
  reserveConcurrentUploadSlot: (...a: unknown[]) => mockReserveConcurrentUploadSlot(...a),
  chargeStorageForStore: (...a: unknown[]) => mockUpdateStorageUsage(...a),
  // Real (pure) impl: charge iff the files row was newly inserted (M8).
  shouldChargeForStore: (inserted: boolean) => inserted,
}));

const mockReleasePendingUpload = vi.fn();
vi.mock('@pagespace/lib/services/pending-uploads', () => ({
  releasePendingUpload: (...a: unknown[]) => mockReleasePendingUpload(...a),
}));

const mockAcquire = vi.fn();
const mockRelease = vi.fn();
const mockGetSlotMetadata = vi.fn();
const mockVerifySlotOwner = vi.fn();
vi.mock('@pagespace/lib/services/upload-semaphore', () => ({
  uploadSemaphore: {
    acquireUploadSlot: (...a: unknown[]) => mockAcquire(...a),
    releaseUploadSlot: (...a: unknown[]) => mockRelease(...a),
    getSlotMetadata: (...a: unknown[]) => mockGetSlotMetadata(...a),
    verifySlotOwner: (...a: unknown[]) => mockVerifySlotOwner(...a),
  },
}));

const mockCheckObjectExists = vi.fn();
const mockIssuePresignedPutUrl = vi.fn();
const mockDeleteStoredObject = vi.fn();
vi.mock('../s3-effects', () => ({
  checkObjectExists: (...a: unknown[]) => mockCheckObjectExists(...a),
  issuePresignedPutUrl: (...a: unknown[]) => mockIssuePresignedPutUrl(...a),
  deleteStoredObject: (...a: unknown[]) => mockDeleteStoredObject(...a),
}));

const mockPromoteStagedUpload = vi.fn();
vi.mock('../promote-staged-upload', () => ({
  promoteStagedUpload: (...a: unknown[]) => mockPromoteStagedUpload(...a),
}));

const mockVerifyAttachmentBytes = vi.fn();
vi.mock('../attachment-verify-effect', () => ({
  verifyAttachmentBytes: (...a: unknown[]) => mockVerifyAttachmentBytes(...a),
}));

const mockSaveFileRecordAndLink = vi.fn();
vi.mock('@pagespace/lib/services/attachment-upload-repository', () => ({
  attachmentUploadRepository: {
    saveFileRecordAndLink: (...a: unknown[]) => mockSaveFileRecordAndLink(...a),
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

const mockIsUploadBlocked = vi.fn();
vi.mock('@pagespace/lib/content-safety/upload-gate', () => ({
  isUploadBlocked: (...a: unknown[]) => mockIsUploadBlocked(...a),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({}),
  logFileActivity: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { presignAttachment, completeAttachment, cancelAttachment } from '../attachment-direct';
import type { AttachmentTarget } from '@pagespace/lib/services/attachment-upload-core';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';

const HASH = 'a'.repeat(64);
const PAGE_TARGET: AttachmentTarget = { type: 'page', pageId: 'page-1', driveId: 'drive-1' };
const CONV_TARGET: AttachmentTarget = { type: 'conversation', conversationId: 'conv-1' };
const req = () => new Request('http://localhost/api/channels/page-1/upload/presign', { method: 'POST' });

function presignArgs(over: Partial<Parameters<typeof presignAttachment>[0]> = {}) {
  return {
    userId: 'user-1',
    target: PAGE_TARGET,
    request: req(),
    contentHash: HASH,
    filename: 'photo.png',
    mimeType: 'image/png',
    fileSize: 1024,
    ...over,
  };
}

const USER_TARGET = {
  payer: { kind: 'user', userId: 'user-1' },
  quota: { tier: 'free', usedBytes: 0, quotaBytes: 500 * 1024 * 1024 },
};

describe('presignAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveUploadQuotaTarget.mockResolvedValue(USER_TARGET);
    mockCheckUploadQuotaTarget.mockResolvedValue({ allowed: true });
    mockCheckObjectExists.mockResolvedValue(false);
    mockAcquire.mockResolvedValue('job-1');
    mockIssuePresignedPutUrl.mockResolvedValue('https://tigris/put');
    mockReserveConcurrentUploadSlot.mockResolvedValue(true);
    mockReleasePendingUpload.mockResolvedValue(undefined);
    mockIsUploadBlocked.mockResolvedValue(false);
  });

  it('signs the PUT for the job staging key, never the served content-addressed key', async () => {
    await presignAttachment(presignArgs());
    expect(mockIssuePresignedPutUrl).toHaveBeenCalledWith('uploads/staging/job-1', expect.anything(), expect.anything(), expect.anything());
    expect(mockIssuePresignedPutUrl.mock.calls.map((c) => c[0])).not.toContain(`files/${HASH}/original`);
  });

  it('issues a presigned URL and reserves a target-bound slot', async () => {
    const res = await presignAttachment(presignArgs());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ url: 'https://tigris/put', jobId: 'job-1' });
    expect(mockAcquire).toHaveBeenCalledWith('user-1', 'free', 1024, expect.objectContaining({
      contentHash: HASH,
      driveId: 'drive-1',
      attachmentTarget: PAGE_TARGET,
    }));
    expect(mockReserveConcurrentUploadSlot).toHaveBeenCalledWith('job-1', 'user-1', 1024);
  });

  it('reserves driveId "" for a conversation target', async () => {
    await presignAttachment(presignArgs({ target: CONV_TARGET }));
    expect(mockAcquire).toHaveBeenCalledWith('user-1', 'free', 1024, expect.objectContaining({
      driveId: '',
      attachmentTarget: CONV_TARGET,
    }));
  });

  it('signals dedup without issuing a PUT URL when the object already exists', async () => {
    mockCheckObjectExists.mockResolvedValue(true);
    const res = await presignAttachment(presignArgs());
    expect(res.body).toMatchObject({ alreadyExists: true, jobId: 'job-1' });
    expect(mockIssuePresignedPutUrl).not.toHaveBeenCalled();
  });

  it('rejects a malformed content hash with 400 before reserving a slot', async () => {
    const res = await presignAttachment(presignArgs({ contentHash: 'nope' }));
    expect(res.status).toBe(400);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('returns 413 when the storage quota check fails', async () => {
    mockCheckUploadQuotaTarget.mockResolvedValue({ allowed: false, reason: 'Insufficient storage' });
    const res = await presignAttachment(presignArgs());
    expect(res.status).toBe(413);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('WAL-9 (partial) resolves the drive quota once and checks against that same read (#2719 review P2-2)', async () => {
    const orgTarget = { payer: { kind: 'org', orgId: 'org-1' }, quota: { tier: 'business', usedBytes: 0, quotaBytes: 50 * 1024 ** 3 } };
    mockResolveUploadQuotaTarget.mockResolvedValue(orgTarget);

    const res = await presignAttachment(presignArgs());

    expect(res.status).toBe(200);
    expect(mockResolveUploadQuotaTarget).toHaveBeenCalledTimes(1);
    expect(mockResolveUploadQuotaTarget).toHaveBeenCalledWith('user-1', 'drive-1');
    expect(mockCheckUploadQuotaTarget).toHaveBeenCalledTimes(1);
    expect(mockCheckUploadQuotaTarget).toHaveBeenCalledWith(orgTarget, 1024);
    expect(mockAcquire).toHaveBeenCalledWith('user-1', 'business', 1024, expect.anything());
  });

  it('returns 500 when the uploader has no storage quota', async () => {
    mockResolveUploadQuotaTarget.mockResolvedValue(null);
    const res = await presignAttachment(presignArgs());
    expect(res.status).toBe(500);
    expect(mockCheckUploadQuotaTarget).not.toHaveBeenCalled();
  });

  it('returns 429 when no upload slot is available', async () => {
    mockAcquire.mockResolvedValue(null);
    const res = await presignAttachment(presignArgs());
    expect(res.status).toBe(429);
  });

  it('#2154/#2225: returns 429 and releases the semaphore slot when the atomic reservation is denied', async () => {
    mockReserveConcurrentUploadSlot.mockResolvedValue(false);
    const res = await presignAttachment(presignArgs());
    expect(res.status).toBe(429);
    expect(mockRelease).toHaveBeenCalledWith('job-1');
  });

  it('releases the slot if issuing the presigned URL throws', async () => {
    mockIssuePresignedPutUrl.mockRejectedValue(new Error('s3 down'));
    await expect(presignAttachment(presignArgs())).rejects.toThrow('s3 down');
    expect(mockRelease).toHaveBeenCalledWith('job-1');
    expect(mockReleasePendingUpload).toHaveBeenCalledWith('job-1');
  });

  describe('content blocklist', () => {
    it('refuses a blocked hash with a neutral 422, before touching storage or reserving a slot', async () => {
      mockIsUploadBlocked.mockResolvedValue(true);

      const res = await presignAttachment(presignArgs());

      expect(res).toEqual({ status: 422, body: { error: "This file can't be uploaded" } });
      expect(mockCheckObjectExists).not.toHaveBeenCalled();
      expect(mockAcquire).not.toHaveBeenCalled();
      expect(mockIssuePresignedPutUrl).not.toHaveBeenCalled();
    });

    it('checks the canonical hash and records the channel target', async () => {
      const args = presignArgs({ contentHash: HASH.toUpperCase() });

      await presignAttachment(args);

      expect(mockIsUploadBlocked).toHaveBeenCalledWith({
        contentHash: HASH,
        userId: 'user-1',
        entryPoint: 'attachment.presign',
        request: args.request,
        details: { targetType: 'page', targetId: 'page-1' },
      });
    });

    it('records the conversation target for a DM attachment', async () => {
      await presignAttachment(presignArgs({ target: CONV_TARGET }));

      expect(mockIsUploadBlocked).toHaveBeenCalledWith(
        expect.objectContaining({ details: { targetType: 'conversation', targetId: 'conv-1' } }),
      );
    });

    it('leaves an unblocked hash unaffected', async () => {
      const res = await presignAttachment(presignArgs());

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ url: 'https://tigris/put', jobId: 'job-1' });
    });
  });
});

describe('completeAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSlotMetadata.mockReturnValue({ contentHash: HASH, fileSize: 1024, mimeType: 'image/png', driveId: 'drive-1', attachmentTarget: PAGE_TARGET });
    mockVerifyAttachmentBytes.mockResolvedValue({ ok: true, detectedMime: 'image/png', size: 1024 });
    mockPromoteStagedUpload.mockResolvedValue({ status: 'promoted' });
    mockSaveFileRecordAndLink.mockResolvedValue({ inserted: true });
    mockReleasePendingUpload.mockResolvedValue(undefined);
    mockUpdateStorageUsage.mockResolvedValue(undefined);
    mockIsUploadBlocked.mockResolvedValue(false);
  });

  function completeArgs(over: Partial<Parameters<typeof completeAttachment>[0]> = {}) {
    return { actor: credentialActor('user-1', null), target: PAGE_TARGET, request: req(), jobId: 'job-1', filename: 'photo.png', ...over };
  }

  it('creates the file row + link with the verified MIME and returns the attachment', async () => {
    mockVerifyAttachmentBytes.mockResolvedValue({ ok: true, detectedMime: 'application/pdf', size: 1024 });
    const res = await completeAttachment(completeArgs());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, file: { id: HASH, mimeType: 'application/pdf', contentHash: HASH } });
    expect(mockSaveFileRecordAndLink).toHaveBeenCalledWith(expect.objectContaining({
      fileRecord: expect.objectContaining({ id: HASH, driveId: 'drive-1', mimeType: 'application/pdf' }),
      target: PAGE_TARGET,
      userId: 'user-1',
    }));
    expect(mockRelease).toHaveBeenCalledWith('job-1');
  });

  it('publishes the staged bytes through the verified promotion before the processor verify and any row', async () => {
    const order: string[] = [];
    mockPromoteStagedUpload.mockImplementation(async () => { order.push('promote'); return { status: 'promoted' }; });
    mockVerifyAttachmentBytes.mockImplementation(async () => { order.push('verify'); return { ok: true, detectedMime: 'image/png', size: 1024 }; });
    mockSaveFileRecordAndLink.mockImplementation(async () => { order.push('save'); return { inserted: true }; });

    await completeAttachment(completeArgs());

    expect(mockPromoteStagedUpload).toHaveBeenCalledWith({ jobId: 'job-1', contentHash: HASH, maxBytes: 1024, servedKey: `files/${HASH}/original` });
    expect(order).toEqual(['promote', 'verify', 'save']);
  });

  it('given staged bytes that do not match the declared hash, should refuse before the processor verify, creating nothing', async () => {
    mockPromoteStagedUpload.mockResolvedValue({ status: 'mismatch' });

    const res = await completeAttachment(completeArgs());

    expect(res).toEqual({ status: 422, body: { error: 'Uploaded file failed integrity verification' } });
    expect(mockVerifyAttachmentBytes).not.toHaveBeenCalled();
    expect(mockSaveFileRecordAndLink).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledWith('job-1');
    expect(mockReleasePendingUpload).toHaveBeenCalledWith('job-1');
  });

  it('given no staged object (dedup fast-path), should go on to the processor verify of the served object', async () => {
    mockPromoteStagedUpload.mockResolvedValue({ status: 'no_staging' });

    const res = await completeAttachment(completeArgs());

    expect(res.status).toBe(200);
    expect(mockVerifyAttachmentBytes).toHaveBeenCalled();
  });

  it('given the promotion throws, should release both reservations and answer a retryable 503', async () => {
    mockPromoteStagedUpload.mockRejectedValue(new Error('s3 down'));

    const res = await completeAttachment(completeArgs());

    expect(res.status).toBe(503);
    expect(mockSaveFileRecordAndLink).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledWith('job-1');
    expect(mockReleasePendingUpload).toHaveBeenCalledWith('job-1');
  });

  it('returns 403 for an unknown/expired jobId', async () => {
    mockGetSlotMetadata.mockReturnValue(null);
    const res = await completeAttachment(completeArgs());
    expect(res.status).toBe(403);
    expect(mockSaveFileRecordAndLink).not.toHaveBeenCalled();
  });

  it('returns 403 when the slot is bound to a different target', async () => {
    mockGetSlotMetadata.mockReturnValue({ contentHash: HASH, fileSize: 1024, mimeType: 'image/png', driveId: '', attachmentTarget: CONV_TARGET });
    const res = await completeAttachment(completeArgs({ target: PAGE_TARGET }));
    expect(res.status).toBe(403);
    expect(mockSaveFileRecordAndLink).not.toHaveBeenCalled();
  });

  it('returns 403 when the slot has no attachment binding (page-file slot replay)', async () => {
    mockGetSlotMetadata.mockReturnValue({ contentHash: HASH, fileSize: 1024, mimeType: 'image/png', driveId: 'drive-1' });
    const res = await completeAttachment(completeArgs());
    expect(res.status).toBe(403);
  });

  it('rejects and releases the slot when byte verification fails, creating no rows', async () => {
    mockVerifyAttachmentBytes.mockResolvedValue({ ok: false, status: 422, error: 'integrity' });
    const res = await completeAttachment(completeArgs());
    expect(res.status).toBe(422);
    expect(mockSaveFileRecordAndLink).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledWith('job-1');
    expect(mockReleasePendingUpload).toHaveBeenCalledWith('job-1');
  });

  it('charges storage with no driveId for a conversation target', async () => {
    mockGetSlotMetadata.mockReturnValue({ contentHash: HASH, fileSize: 2048, mimeType: 'image/png', driveId: '', attachmentTarget: CONV_TARGET });
    mockVerifyAttachmentBytes.mockResolvedValue({ ok: true, detectedMime: 'image/png', size: 2048 });
    await completeAttachment(completeArgs({ target: CONV_TARGET }));
    expect(mockSaveFileRecordAndLink).toHaveBeenCalledWith(expect.objectContaining({ fileRecord: expect.objectContaining({ driveId: null }) }));
    expect(mockUpdateStorageUsage).toHaveBeenCalledWith('user-1', null, 2048, expect.objectContaining({ eventType: 'upload' }));
  });

  it('persists and charges the verifier-authoritative size, not the client presign size', async () => {
    // Slot (client-declared) says 5000 bytes, but the processor read 1024 — e.g. a
    // dedup hit against a smaller pre-existing object. The verified size must win.
    mockGetSlotMetadata.mockReturnValue({ contentHash: HASH, fileSize: 5000, mimeType: 'image/png', driveId: 'drive-1', attachmentTarget: PAGE_TARGET });
    mockVerifyAttachmentBytes.mockResolvedValue({ ok: true, detectedMime: 'image/png', size: 1024 });
    const res = await completeAttachment(completeArgs());
    expect(res.body).toMatchObject({ file: { size: 1024 } });
    expect(mockSaveFileRecordAndLink).toHaveBeenCalledWith(expect.objectContaining({ fileRecord: expect.objectContaining({ sizeBytes: 1024 }) }));
    expect(mockUpdateStorageUsage).toHaveBeenCalledWith('user-1', expect.anything(), 1024, expect.anything());
  });

  it('M8: does not charge storage on a dedup completion (files row already existed)', async () => {
    mockSaveFileRecordAndLink.mockResolvedValue({ inserted: false });
    const res = await completeAttachment(completeArgs());
    expect(res.status).toBe(200);
    expect(mockSaveFileRecordAndLink).toHaveBeenCalled();
    expect(mockUpdateStorageUsage).not.toHaveBeenCalled();
  });

  it('releases the slot and returns a retryable 503 when the verify call throws', async () => {
    mockVerifyAttachmentBytes.mockRejectedValue(new Error('processor unreachable'));
    const res = await completeAttachment(completeArgs());
    expect(res.status).toBe(503);
    expect(mockSaveFileRecordAndLink).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledWith('job-1');
    expect(mockReleasePendingUpload).toHaveBeenCalledWith('job-1');
  });

  describe('content blocklist', () => {
    it('refuses a blocked hash with a neutral 422 and links nothing', async () => {
      mockIsUploadBlocked.mockResolvedValue(true);

      const res = await completeAttachment(completeArgs());

      expect(res).toEqual({ status: 422, body: { error: "This file can't be uploaded" } });
      expect(mockVerifyAttachmentBytes).not.toHaveBeenCalled();
      expect(mockSaveFileRecordAndLink).not.toHaveBeenCalled();
      expect(mockUpdateStorageUsage).not.toHaveBeenCalled();
    });

    it('releases the reserved slot and pending-upload row when it refuses', async () => {
      mockIsUploadBlocked.mockResolvedValue(true);

      await completeAttachment(completeArgs());

      expect(mockRelease).toHaveBeenCalledWith('job-1');
      expect(mockReleasePendingUpload).toHaveBeenCalledWith('job-1');
    });

    it('releases the reserved slot and pending-upload row when the lookup throws, and rethrows', async () => {
      mockIsUploadBlocked.mockRejectedValue(new Error('db down'));

      await expect(completeAttachment(completeArgs())).rejects.toThrow('db down');

      expect(mockRelease).toHaveBeenCalledWith('job-1');
      expect(mockReleasePendingUpload).toHaveBeenCalledWith('job-1');
      expect(mockVerifyAttachmentBytes).not.toHaveBeenCalled();
    });

    it('checks the hash reserved at presign', async () => {
      const args = completeArgs();

      await completeAttachment(args);

      expect(mockIsUploadBlocked).toHaveBeenCalledWith({
        contentHash: HASH,
        userId: 'user-1',
        entryPoint: 'attachment.complete',
        request: args.request,
        details: { targetType: 'page', targetId: 'page-1' },
      });
    });

    it('does not consult the blocklist for a slot bound to another target', async () => {
      mockGetSlotMetadata.mockReturnValue({ contentHash: HASH, fileSize: 1024, mimeType: 'image/png', driveId: '', attachmentTarget: CONV_TARGET });

      const res = await completeAttachment(completeArgs());

      expect(res.status).toBe(403);
      expect(mockIsUploadBlocked).not.toHaveBeenCalled();
    });

    it('leaves an unblocked hash unaffected', async () => {
      const res = await completeAttachment(completeArgs());

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, file: { id: HASH } });
    });
  });
});

describe('cancelAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReleasePendingUpload.mockResolvedValue(undefined);
  });

  it('releases an owned slot', async () => {
    mockVerifySlotOwner.mockReturnValue(true);
    const res = await cancelAttachment({ userId: 'user-1', jobId: 'job-1' });
    expect(res.status).toBe(200);
    expect(mockRelease).toHaveBeenCalledWith('job-1');
  });

  it("deletes the job's staging object, and still succeeds if that fails", async () => {
    mockVerifySlotOwner.mockReturnValue(true);
    mockDeleteStoredObject.mockRejectedValue(new Error('s3 down'));
    const res = await cancelAttachment({ userId: 'user-1', jobId: 'job-1' });
    expect(res.status).toBe(200);
    expect(mockDeleteStoredObject).toHaveBeenCalledWith('uploads/staging/job-1');
  });

  it('returns 403 and releases nothing for a slot the user does not own', async () => {
    mockVerifySlotOwner.mockReturnValue(false);
    const res = await cancelAttachment({ userId: 'user-1', jobId: 'job-1' });
    expect(res.status).toBe(403);
    expect(mockRelease).not.toHaveBeenCalled();
  });
});
