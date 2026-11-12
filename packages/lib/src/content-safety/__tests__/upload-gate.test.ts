import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsHashBlocked = vi.fn();
vi.mock('../blocklist', () => ({
  isHashBlocked: (...a: unknown[]) => mockIsHashBlocked(...a),
}));

const mockAudit = vi.fn();
const mockAuditRequest = vi.fn();
vi.mock('../../audit/audit-log', () => ({
  audit: (...a: unknown[]) => mockAudit(...a),
  auditRequest: (...a: unknown[]) => mockAuditRequest(...a),
}));

const mockWarn = vi.fn();
vi.mock('../../logging/logger-config', () => ({
  loggers: { security: { warn: (...a: unknown[]) => mockWarn(...a) } },
}));

import { assertUploadNotBlocked, isUploadBlocked } from '../upload-gate';
import { ContentBlockedError } from '../policy';

const HASH = 'c'.repeat(64);
const request = () => new Request('http://localhost/api/upload/presign', { method: 'POST' });

describe('isUploadBlocked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsHashBlocked.mockResolvedValue(false);
  });

  it('lets an unblocked hash through without auditing', async () => {
    const blocked = await isUploadBlocked({ contentHash: HASH, userId: 'user-1', entryPoint: 'upload.presign', request: request() });

    expect(blocked).toBe(false);
    expect(mockAuditRequest).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('reports a blocked hash and records the attempt with request metadata', async () => {
    mockIsHashBlocked.mockResolvedValue(true);
    const req = request();

    const blocked = await isUploadBlocked({
      contentHash: HASH,
      userId: 'user-1',
      entryPoint: 'upload.presign',
      request: req,
      details: { driveId: 'drive-1' },
    });

    expect(blocked).toBe(true);
    expect(mockAuditRequest).toHaveBeenCalledWith(req, {
      eventType: 'authz.access.denied',
      userId: 'user-1',
      resourceType: 'file',
      resourceId: HASH,
      riskScore: 0.9,
      details: { reason: 'content_blocked', entryPoint: 'upload.presign', driveId: 'drive-1' },
    });
    expect(mockWarn).toHaveBeenCalledWith(
      'Blocked content upload refused',
      expect.objectContaining({ contentHash: HASH, userId: 'user-1', entryPoint: 'upload.presign' }),
    );
  });

  it('audits without request metadata when there is no request (server-side writers)', async () => {
    mockIsHashBlocked.mockResolvedValue(true);

    const blocked = await isUploadBlocked({ contentHash: HASH, userId: 'user-1', entryPoint: 'image-generation' });

    expect(blocked).toBe(true);
    expect(mockAuditRequest).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'authz.access.denied', resourceId: HASH, userId: 'user-1' }),
    );
  });

  it('records an attempt with no known user', async () => {
    mockIsHashBlocked.mockResolvedValue(true);

    await isUploadBlocked({ contentHash: HASH, entryPoint: 'chat-attachment' });

    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: undefined, resourceId: HASH }));
  });
});

describe('assertUploadNotBlocked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves for an unblocked hash', async () => {
    mockIsHashBlocked.mockResolvedValue(false);
    await expect(assertUploadNotBlocked({ contentHash: HASH, entryPoint: 'image-generation' })).resolves.toBeUndefined();
  });

  it('throws ContentBlockedError for a blocked hash, after recording the attempt', async () => {
    mockIsHashBlocked.mockResolvedValue(true);

    const attempt = assertUploadNotBlocked({ contentHash: HASH, userId: 'user-1', entryPoint: 'image-generation' });

    await expect(attempt).rejects.toBeInstanceOf(ContentBlockedError);
    await expect(attempt).rejects.toMatchObject({ contentHash: HASH });
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });
});
