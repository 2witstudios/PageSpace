import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCopyStoredObject = vi.fn();
const mockDigestStoredObject = vi.fn();
const mockDeleteStoredObject = vi.fn();
vi.mock('../s3-effects', () => ({
  copyStoredObject: (...args: unknown[]) => mockCopyStoredObject(...args),
  digestStoredObject: (...args: unknown[]) => mockDigestStoredObject(...args),
  deleteStoredObject: (...args: unknown[]) => mockDeleteStoredObject(...args),
}));

import { promoteStagedUpload } from '../promote-staged-upload';

const HASH = 'a'.repeat(64);
const SERVED = `files/${HASH}/original`;
const STAGING = 'uploads/staging/job-1';
const HOLDING = 'uploads/verifying/job-1';
const args = { jobId: 'job-1', contentHash: HASH, maxBytes: 100, servedKey: SERVED };

beforeEach(() => {
  vi.clearAllMocks();
  mockCopyStoredObject.mockResolvedValue('copied');
  mockDeleteStoredObject.mockResolvedValue(undefined);
  mockDigestStoredObject.mockResolvedValue({ status: 'ok', sha256: HASH, size: 10 });
});

describe('promoteStagedUpload', () => {
  it('given staged bytes that match, should hash a server-only copy and publish exactly that copy to the served key', async () => {
    const order: string[] = [];
    mockCopyStoredObject.mockImplementation(async (from: string, to: string) => { order.push(`copy:${from}->${to}`); return 'copied'; });
    mockDigestStoredObject.mockImplementation(async (key: string) => { order.push(`digest:${key}`); return { status: 'ok', sha256: HASH, size: 10 }; });
    mockDeleteStoredObject.mockImplementation(async (key: string) => { order.push(`delete:${key}`); });

    expect(await promoteStagedUpload(args)).toEqual({ status: 'promoted' });
    expect(order).toEqual([
      `copy:${STAGING}->${HOLDING}`,
      `delete:${STAGING}`,
      `digest:${HOLDING}`,
      `copy:${HOLDING}->${SERVED}`,
      `delete:${HOLDING}`,
    ]);
    expect(mockDigestStoredObject).toHaveBeenCalledWith(HOLDING, 100);
  });

  it('never hashes or publishes from the client-writable staging key itself', async () => {
    await promoteStagedUpload(args);
    expect(mockDigestStoredObject).not.toHaveBeenCalledWith(STAGING, expect.anything());
    expect(mockCopyStoredObject).not.toHaveBeenCalledWith(STAGING, SERVED);
  });

  it('given no staged object, should report it and touch nothing else', async () => {
    mockCopyStoredObject.mockResolvedValueOnce('missing');

    expect(await promoteStagedUpload(args)).toEqual({ status: 'no_staging' });
    expect(mockDigestStoredObject).not.toHaveBeenCalled();
    expect(mockDeleteStoredObject).not.toHaveBeenCalled();
  });

  it.each([
    ['different bytes', { status: 'ok', sha256: 'b'.repeat(64), size: 10 }],
    ['oversize bytes', { status: 'oversize' }],
    ['a vanished holding copy', { status: 'missing' }],
  ])('given %s, should refuse, delete only the per-job keys, and never write or delete the served key', async (_label, digest) => {
    mockDigestStoredObject.mockResolvedValue(digest);

    expect(await promoteStagedUpload(args)).toEqual({ status: 'mismatch' });
    expect(mockCopyStoredObject).toHaveBeenCalledTimes(1);
    expect(mockDeleteStoredObject.mock.calls.map((c) => c[0]).sort()).toEqual([HOLDING, STAGING].sort());
    expect(mockDeleteStoredObject).not.toHaveBeenCalledWith(SERVED);
  });

  it('given a storage error mid-way, should clean up the per-job keys and rethrow', async () => {
    mockDigestStoredObject.mockRejectedValue(new Error('s3 down'));

    await expect(promoteStagedUpload(args)).rejects.toThrow('s3 down');
    expect(mockDeleteStoredObject).toHaveBeenCalledWith(HOLDING);
    expect(mockDeleteStoredObject).not.toHaveBeenCalledWith(SERVED);
  });
});
