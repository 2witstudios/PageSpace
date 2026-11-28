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
const HOLDING_PREFIX = 'uploads/verifying/job-1/';
const isHolding = (key: unknown) => typeof key === 'string' && key.startsWith(HOLDING_PREFIX);
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
    const holding = mockDigestStoredObject.mock.calls[0][0] as string;
    expect(isHolding(holding)).toBe(true);
    expect(order).toEqual([
      `copy:${STAGING}->${holding}`,
      `delete:${STAGING}`,
      `digest:${holding}`,
      `copy:${holding}->${SERVED}`,
      `delete:${holding}`,
    ]);
    expect(mockDigestStoredObject).toHaveBeenCalledWith(holding, 100);
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
    const deleted = mockDeleteStoredObject.mock.calls.map((c) => c[0]);
    expect(deleted).toHaveLength(2);
    expect(deleted).toContain(STAGING);
    expect(deleted.some(isHolding)).toBe(true);
    expect(mockDeleteStoredObject).not.toHaveBeenCalledWith(SERVED);
  });

  it('given the holding copy vanished before publication, should not report it published', async () => {
    mockCopyStoredObject.mockResolvedValueOnce('copied').mockResolvedValueOnce('missing');

    await expect(promoteStagedUpload(args)).rejects.toThrow(/holding copy/);
  });

  it('given a storage error mid-way, should clean up the per-job keys and rethrow', async () => {
    mockDigestStoredObject.mockRejectedValue(new Error('s3 down'));

    await expect(promoteStagedUpload(args)).rejects.toThrow('s3 down');
    expect(mockDeleteStoredObject.mock.calls.some((c) => isHolding(c[0]))).toBe(true);
    expect(mockDeleteStoredObject).not.toHaveBeenCalledWith(SERVED);
  });
  it('given two completions of one job interleaved with a re-PUT, should publish only bytes that were hashed (no shared holding key)', async () => {
    const CLEAN = HASH;
    const BLOCKED = 'b'.repeat(64);
    // In-memory store: key -> the sha256 of the bytes stored there.
    const store = new Map<string, string>([[STAGING, CLEAN]]);
    let releaseA: () => void = () => undefined;
    const aHashed = new Promise<void>((resolve) => { releaseA = resolve; });
    let digestCalls = 0;
    let resumeA: () => void = () => undefined;

    mockCopyStoredObject.mockImplementation(async (from: string, to: string) => {
      const bytes = store.get(from);
      if (bytes === undefined) return 'missing';
      store.set(to, bytes);
      return 'copied';
    });
    mockDeleteStoredObject.mockImplementation(async (key: string) => { store.delete(key); });
    mockDigestStoredObject.mockImplementation(async (key: string) => {
      digestCalls += 1;
      const sha256 = store.get(key);
      if (digestCalls === 1) {
        // Completion A has hashed its holding copy; pause it before it publishes.
        releaseA();
        await new Promise<void>((resolve) => { resumeA = resolve; });
      }
      return sha256 === undefined ? { status: 'missing' } : { status: 'ok', sha256, size: 10 };
    });

    const a = promoteStagedUpload(args);
    await aHashed;
    // The client re-PUTs blocked bytes to staging, and completion B runs in full.
    store.set(STAGING, BLOCKED);
    const b = await promoteStagedUpload(args);
    resumeA();
    const aResult = await a;

    expect(b).toEqual({ status: 'mismatch' });
    expect(aResult).toEqual({ status: 'promoted' });
    expect(store.get(SERVED)).toBe(CLEAN);
  });
});
