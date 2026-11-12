import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentBlockedError } from '@pagespace/lib/content-safety/policy';
import { contentBlockedResponseFor, contentCopyRefusedResponse, refuseBlockedAttachments } from '../content-blocked-response';

const mockFindBlockedUploads = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/content-safety/upload-gate', () => ({
  findBlockedUploads: mockFindBlockedUploads,
}));

const mockLoadFileStoragePaths = vi.hoisted(() => vi.fn());
const mockAuditRequest = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: mockAuditRequest }));
vi.mock('../stored-content-hash', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stored-content-hash')>()),
  loadFileStoragePaths: mockLoadFileStoragePaths,
}));
vi.mock('@pagespace/db/db', () => ({ db: {} }));

beforeEach(() => {
  vi.clearAllMocks();
  mockFindBlockedUploads.mockResolvedValue(new Set());
  mockLoadFileStoragePaths.mockResolvedValue(new Map());
});

const HASH = 'd'.repeat(64);

describe('contentBlockedResponseFor', () => {
  it('maps a ContentBlockedError to a neutral 422', async () => {
    const res = contentBlockedResponseFor(new ContentBlockedError(HASH));

    expect(res?.status).toBe(422);
    expect(await res?.json()).toEqual({ error: "This file can't be uploaded" });
  });

  it('never leaks the blocked hash', async () => {
    const res = contentBlockedResponseFor(new ContentBlockedError(HASH));

    expect(JSON.stringify(await res?.json())).not.toContain(HASH);
  });

  it('returns null for any other error, so the caller keeps its own handling', () => {
    expect(contentBlockedResponseFor(new Error('db down'))).toBeNull();
    expect(contentBlockedResponseFor('nope')).toBeNull();
    expect(contentBlockedResponseFor(undefined)).toBeNull();
  });
});

describe('contentCopyRefusedResponse', () => {
  it('is a neutral 422 worded for a copy, naming no page and no reason', async () => {
    const res = contentCopyRefusedResponse();

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "One or more files can't be copied" });
  });
});

describe('refuseBlockedAttachments', () => {
  const request = new Request('http://localhost/api/channels/page-1/messages', { method: 'POST' });
  const input = { request, userId: 'user-1', details: { targetType: 'page', targetId: 'page-1' } };
  const HASH_1 = '1'.repeat(64);
  const HASH_2 = '2'.repeat(64);
  const context = {
    entryPoint: 'attachment.send',
    userId: 'user-1',
    request,
    details: { targetType: 'page', targetId: 'page-1' },
  };

  it('returns the neutral 422 when any attached file is blocked', async () => {
    mockFindBlockedUploads.mockResolvedValue(new Set([HASH_2]));

    const res = await refuseBlockedAttachments({ ...input, fileIds: [HASH_1, HASH_2] });

    expect(res?.status).toBe(422);
    expect(await res?.json()).toEqual({ error: "This file can't be uploaded" });
  });

  it('checks every attachment in one call, with the request and target for the audit event', async () => {
    await refuseBlockedAttachments({ ...input, fileIds: [HASH_1, HASH_2] });

    expect(mockFindBlockedUploads).toHaveBeenCalledTimes(1);
    expect(mockFindBlockedUploads).toHaveBeenCalledWith([HASH_1, HASH_2], context);
    expect(mockLoadFileStoragePaths).not.toHaveBeenCalled();
  });

  it('resolves a legacy file id through its storagePath, in bare or files/<hash>/original form', async () => {
    mockLoadFileStoragePaths.mockResolvedValue(
      new Map([['legacy-1', `files/${HASH_1.toUpperCase()}/original`], ['legacy-2', HASH_2]]),
    );

    await refuseBlockedAttachments({ ...input, fileIds: ['legacy-1', 'legacy-2'] });

    expect(mockLoadFileStoragePaths).toHaveBeenCalledWith(['legacy-1', 'legacy-2']);
    expect(mockFindBlockedUploads).toHaveBeenCalledWith([HASH_1, HASH_2], context);
  });

  it('refuses a legacy file whose resolved hash is blocked', async () => {
    mockLoadFileStoragePaths.mockResolvedValue(new Map([['legacy-1', `files/${HASH_1}/original`]]));
    mockFindBlockedUploads.mockResolvedValue(new Set([HASH_1]));

    const res = await refuseBlockedAttachments({ ...input, fileIds: ['legacy-1'] });

    expect(res?.status).toBe(422);
  });

  it('fails closed and audits when a stored file cannot be tied to a content hash', async () => {
    mockLoadFileStoragePaths.mockResolvedValue(new Map([['legacy-1', 'uploads/2021/cat.png'], ['legacy-2', null]]));

    const res = await refuseBlockedAttachments({ ...input, fileIds: ['legacy-1', 'legacy-2'] });

    expect(res?.status).toBe(422);
    expect(mockFindBlockedUploads).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledTimes(2);
    expect(mockAuditRequest).toHaveBeenCalledWith(request, {
      eventType: 'content.upload.blocked',
      userId: 'user-1',
      resourceType: 'file',
      resourceId: 'legacy-1',
      riskScore: 0.5,
      details: { targetType: 'page', targetId: 'page-1', entryPoint: 'attachment.send', reason: 'unverifiable_file_reference' },
    });
  });

  it('leaves an id with no files row to the send\'s own validation', async () => {
    expect(await refuseBlockedAttachments({ ...input, fileIds: ['no-such-file'] })).toBeNull();
    expect(mockAuditRequest).not.toHaveBeenCalled();
  });

  it('returns null when nothing is blocked', async () => {
    expect(await refuseBlockedAttachments({ ...input, fileIds: [HASH_1] })).toBeNull();
  });

  it('returns null without querying when there are no attachments', async () => {
    expect(await refuseBlockedAttachments({ ...input, fileIds: [] })).toBeNull();
    expect(mockFindBlockedUploads).not.toHaveBeenCalled();
  });
});
