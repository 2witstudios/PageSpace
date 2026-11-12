import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindBlockedHashes = vi.fn();
vi.mock('../blocklist', () => ({
  findBlockedHashes: (...a: unknown[]) => mockFindBlockedHashes(...a),
}));

const mockAudit = vi.fn();
const mockAuditRequest = vi.fn();
vi.mock('../../audit/audit-log', () => ({
  audit: (...a: unknown[]) => mockAudit(...a),
  auditRequest: (...a: unknown[]) => mockAuditRequest(...a),
}));

import { assertUploadNotBlocked, findBlockedUploads, isUploadBlocked } from '../upload-gate';
import { ContentBlockedError } from '../policy';

const HASH = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);
const request = () => new Request('http://localhost/api/upload/presign', { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindBlockedHashes.mockResolvedValue(new Set());
});

describe('isUploadBlocked', () => {
  it('lets an unblocked hash through without auditing', async () => {
    const blocked = await isUploadBlocked({ contentHash: HASH, userId: 'user-1', entryPoint: 'upload.presign', request: request() });

    expect(blocked).toBe(false);
    expect(mockAuditRequest).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('reports a blocked hash and records the attempt under its own event type, with request metadata', async () => {
    mockFindBlockedHashes.mockResolvedValue(new Set([HASH]));
    const req = request();

    const blocked = await isUploadBlocked({
      contentHash: HASH,
      userId: 'user-1',
      entryPoint: 'upload.presign',
      request: req,
      details: { driveId: 'drive-1' },
    });

    expect(blocked).toBe(true);
    expect(mockAuditRequest).toHaveBeenCalledTimes(1);
    expect(mockAuditRequest).toHaveBeenCalledWith(req, {
      eventType: 'content.upload.blocked',
      userId: 'user-1',
      resourceType: 'file',
      resourceId: HASH,
      riskScore: 0.9,
      details: { driveId: 'drive-1', entryPoint: 'upload.presign' },
    });
  });

  it("does not let a caller's details overwrite the entry point", async () => {
    mockFindBlockedHashes.mockResolvedValue(new Set([HASH]));

    await isUploadBlocked({ contentHash: HASH, entryPoint: 'upload.complete', details: { entryPoint: 'spoofed' } });

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ details: { entryPoint: 'upload.complete' } }),
    );
  });

  it('audits without request metadata when there is no request (server-side writers)', async () => {
    mockFindBlockedHashes.mockResolvedValue(new Set([HASH]));

    const blocked = await isUploadBlocked({ contentHash: HASH, userId: 'user-1', entryPoint: 'image-generation' });

    expect(blocked).toBe(true);
    expect(mockAuditRequest).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'content.upload.blocked', resourceId: HASH, userId: 'user-1' }),
    );
  });

  it('records an attempt with no known user', async () => {
    mockFindBlockedHashes.mockResolvedValue(new Set([HASH]));

    await isUploadBlocked({ contentHash: HASH, entryPoint: 'chat-attachment' });

    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: undefined, resourceId: HASH }));
  });
});

describe('findBlockedUploads', () => {
  it('checks a batch with one blocklist query and audits each blocked hash once', async () => {
    mockFindBlockedHashes.mockResolvedValue(new Set([OTHER]));

    const blocked = await findBlockedUploads([HASH, OTHER], { entryPoint: 'page.copy', userId: 'user-1' });

    expect(blocked).toEqual(new Set([OTHER]));
    expect(mockFindBlockedHashes).toHaveBeenCalledTimes(1);
    expect(mockFindBlockedHashes).toHaveBeenCalledWith([HASH, OTHER]);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ resourceId: OTHER }));
  });

  it('audits nothing when nothing is blocked', async () => {
    expect(await findBlockedUploads([HASH, OTHER], { entryPoint: 'page.copy' })).toEqual(new Set());
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('assertUploadNotBlocked', () => {
  it('resolves for an unblocked hash', async () => {
    await expect(assertUploadNotBlocked({ contentHash: HASH, entryPoint: 'image-generation' })).resolves.toBeUndefined();
  });

  it('throws ContentBlockedError for a blocked hash, after recording the attempt', async () => {
    mockFindBlockedHashes.mockResolvedValue(new Set([HASH]));

    const attempt = assertUploadNotBlocked({ contentHash: HASH, userId: 'user-1', entryPoint: 'image-generation' });

    await expect(attempt).rejects.toBeInstanceOf(ContentBlockedError);
    await expect(attempt).rejects.toMatchObject({ contentHash: HASH });
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });
});
