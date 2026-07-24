import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Effect seams (pure core is left real) -------------------------------------
const mockGetUserStorageQuota = vi.fn();
const mockCheckStorageQuota = vi.fn();
const mockCheckConcurrentUploads = vi.fn();
const mockUpdateStorageUsage = vi.fn();
vi.mock('@pagespace/lib/services/storage-limits', () => ({
  getUserStorageQuota: (...a: unknown[]) => mockGetUserStorageQuota(...a),
  checkStorageQuota: (...a: unknown[]) => mockCheckStorageQuota(...a),
  checkConcurrentUploads: (...a: unknown[]) => mockCheckConcurrentUploads(...a),
  updateStorageUsage: (...a: unknown[]) => mockUpdateStorageUsage(...a),
  // Real (pure) impl: charge iff the files row was newly inserted (M8).
  shouldChargeForStore: (inserted: boolean) => inserted,
}));

const mockRegisterPendingUpload = vi.fn();
const mockReleasePendingUpload = vi.fn();
vi.mock('@pagespace/lib/services/pending-uploads', () => ({
  registerPendingUpload: (...a: unknown[]) => mockRegisterPendingUpload(...a),
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
vi.mock('../s3-effects', () => ({
  checkObjectExists: (...a: unknown[]) => mockCheckObjectExists(...a),
  issuePresignedPutUrl: (...a: unknown[]) => mockIssuePresignedPutUrl(...a),
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
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({}),
  logFileActivity: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { presignAttachment, completeAttachment, cancelAttachment } from '../attachment-direct';
import type { AttachmentTarget } from '@pagespace/lib/services/attachment-upload-core';

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

describe('presignAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserStorageQuota.mockResolvedValue({ tier: 'free', usedBytes: 0, quotaBytes: 500 * 1024 * 1024 });
    mockCheckStorageQuota.mockResolvedValue({ allowed: true });
    mockCheckConcurrentUploads.mockResolvedValue(true);
    mockCheckObjectExists.mockResolvedValue(false);
    mockAcquire.mockResolvedValue('job-1');
    mockIssuePresignedPutUrl.mockResolvedValue('https://tigris/put');
    mockRegisterPendingUpload.mockResolvedValue(undefined);
    mockReleasePendingUpload.mockResolvedValue(undefined);
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
    expect(mockRegisterPendingUpload).toHaveBeenCalledWith('job-1', 'user-1', 1024);
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
    mockCheckStorageQuota.mockResolvedValue({ allowed: false, reason: 'Insufficient storage' });
    const res = await presignAttachment(presignArgs());
    expect(res.status).toBe(413);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('returns 429 when no upload slot is available', async () => {
    mockAcquire.mockResolvedValue(null);
    const res = await presignAttachment(presignArgs());
    expect(res.status).toBe(429);
  });

  it('#2154: returns 429 and never reserves a semaphore slot when the cross-process concurrency gate rejects', async () => {
    mockCheckConcurrentUploads.mockResolvedValue(false);
    const res = await presignAttachment(presignArgs());
    expect(res.status).toBe(429);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('releases the slot if issuing the presigned URL throws', async () => {
    mockIssuePresignedPutUrl.mockRejectedValue(new Error('s3 down'));
    await expect(presignAttachment(presignArgs())).rejects.toThrow('s3 down');
    expect(mockRelease).toHaveBeenCalledWith('job-1');
    expect(mockReleasePendingUpload).toHaveBeenCalledWith('job-1');
  });
});

describe('completeAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSlotMetadata.mockReturnValue({ contentHash: HASH, fileSize: 1024, mimeType: 'image/png', driveId: 'drive-1', attachmentTarget: PAGE_TARGET });
    mockVerifyAttachmentBytes.mockResolvedValue({ ok: true, detectedMime: 'image/png', size: 1024 });
    mockSaveFileRecordAndLink.mockResolvedValue({ inserted: true });
    mockReleasePendingUpload.mockResolvedValue(undefined);
    mockUpdateStorageUsage.mockResolvedValue(undefined);
  });

  function completeArgs(over: Partial<Parameters<typeof completeAttachment>[0]> = {}) {
    return { userId: 'user-1', target: PAGE_TARGET, request: req(), jobId: 'job-1', filename: 'photo.png', ...over };
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
    expect(mockUpdateStorageUsage).toHaveBeenCalledWith('user-1', 2048, expect.objectContaining({ driveId: undefined }));
  });

  it('persists and charges the verifier-authoritative size, not the client presign size', async () => {
    // Slot (client-declared) says 5000 bytes, but the processor read 1024 — e.g. a
    // dedup hit against a smaller pre-existing object. The verified size must win.
    mockGetSlotMetadata.mockReturnValue({ contentHash: HASH, fileSize: 5000, mimeType: 'image/png', driveId: 'drive-1', attachmentTarget: PAGE_TARGET });
    mockVerifyAttachmentBytes.mockResolvedValue({ ok: true, detectedMime: 'image/png', size: 1024 });
    const res = await completeAttachment(completeArgs());
    expect(res.body).toMatchObject({ file: { size: 1024 } });
    expect(mockSaveFileRecordAndLink).toHaveBeenCalledWith(expect.objectContaining({ fileRecord: expect.objectContaining({ sizeBytes: 1024 }) }));
    expect(mockUpdateStorageUsage).toHaveBeenCalledWith('user-1', 1024, expect.anything());
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

  it('returns 403 and releases nothing for a slot the user does not own', async () => {
    mockVerifySlotOwner.mockReturnValue(false);
    const res = await cancelAttachment({ userId: 'user-1', jobId: 'job-1' });
    expect(res.status).toBe(403);
    expect(mockRelease).not.toHaveBeenCalled();
  });
});
