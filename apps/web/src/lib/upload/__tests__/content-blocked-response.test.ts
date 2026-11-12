import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentBlockedError } from '@pagespace/lib/content-safety/policy';
import { contentBlockedResponseFor, refuseBlockedAttachments } from '../content-blocked-response';

const mockFindBlockedUploads = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/content-safety/upload-gate', () => ({
  findBlockedUploads: mockFindBlockedUploads,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockFindBlockedUploads.mockResolvedValue(new Set());
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

describe('refuseBlockedAttachments', () => {
  const request = new Request('http://localhost/api/channels/page-1/messages', { method: 'POST' });
  const input = { request, userId: 'user-1', details: { targetType: 'page', targetId: 'page-1' } };

  it('returns the neutral 422 when any attached file is blocked', async () => {
    mockFindBlockedUploads.mockResolvedValue(new Set(['file-2']));

    const res = await refuseBlockedAttachments({ ...input, fileIds: ['file-1', 'file-2'] });

    expect(res?.status).toBe(422);
    expect(await res?.json()).toEqual({ error: "This file can't be uploaded" });
  });

  it('checks every attachment in one call, with the request and target for the audit event', async () => {
    await refuseBlockedAttachments({ ...input, fileIds: ['file-1', 'file-2'] });

    expect(mockFindBlockedUploads).toHaveBeenCalledTimes(1);
    expect(mockFindBlockedUploads).toHaveBeenCalledWith(['file-1', 'file-2'], {
      entryPoint: 'attachment.send',
      userId: 'user-1',
      request,
      details: { targetType: 'page', targetId: 'page-1' },
    });
  });

  it('returns null when nothing is blocked', async () => {
    expect(await refuseBlockedAttachments({ ...input, fileIds: ['file-1'] })).toBeNull();
  });

  it('returns null without querying when there are no attachments', async () => {
    expect(await refuseBlockedAttachments({ ...input, fileIds: [] })).toBeNull();
    expect(mockFindBlockedUploads).not.toHaveBeenCalled();
  });
});
