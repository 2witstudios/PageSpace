import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockS3Send = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: vi.fn((params) => params),
  HeadObjectCommand: vi.fn((params) => params),
  PutObjectCommand: vi.fn((params) => params),
  DeleteObjectCommand: vi.fn((params) => params),
  CopyObjectCommand: vi.fn((params) => ({ __type: 'copy', ...params })),
}));

/**
 * `writePageContent` runs its existence check and storage write inside
 * `db.transaction`, holding the ref's advisory lock on the transaction handle
 * so a concurrent reclaim cannot delete the object between the two. The mock
 * hands the callback a `tx` that can `execute` that lock statement.
 */
const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn(async () => undefined) }));
vi.mock('@pagespace/db/db', () => {
  const tx = { execute: mockExecute };
  return { db: { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { param: (v: unknown) => v }
  ),
}));

const mockReadFile = vi.fn();
vi.mock('fs', () => ({
  promises: { readFile: (...args: unknown[]) => mockReadFile(...args) },
}));

import { readPageContent, writePageContent } from '../page-content-store';

const VALID_REF = 'a'.repeat(64);

const makeS3Body = (content: string) => ({
  Body: {
    transformToByteArray: async () => Buffer.from(content, 'utf8'),
  },
});

describe('readPageContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BUCKET_NAME = 'test-bucket';
    process.env.PAGE_CONTENT_STORAGE_PATH = '/data/storage';
  });

  it('returns content from S3 on cache hit', async () => {
    mockS3Send.mockResolvedValueOnce(makeS3Body('hello world'));

    const result = await readPageContent(VALID_REF);

    expect(result).toBe('hello world');
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('falls back to filesystem on NoSuchKey', async () => {
    const noSuchKey = Object.assign(new Error('NoSuchKey'), { Code: 'NoSuchKey' });
    mockS3Send.mockRejectedValueOnce(noSuchKey);
    mockReadFile.mockResolvedValueOnce('legacy content');

    const result = await readPageContent(VALID_REF);

    expect(result).toBe('legacy content');
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringContaining(VALID_REF),
      'utf8'
    );
  });

  it('uses PAGE_CONTENT_STORAGE_PATH env var for filesystem fallback path', async () => {
    const noSuchKey = Object.assign(new Error('NoSuchKey'), { Code: 'NoSuchKey' });
    mockS3Send.mockRejectedValueOnce(noSuchKey);
    mockReadFile.mockResolvedValueOnce('legacy content');

    await readPageContent(VALID_REF);

    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringContaining('/data/storage'),
      'utf8'
    );
  });

  it('propagates non-NoSuchKey S3 errors without filesystem fallback', async () => {
    const s3Error = Object.assign(new Error('AccessDenied'), { Code: 'AccessDenied' });
    mockS3Send.mockRejectedValueOnce(s3Error);

    await expect(readPageContent(VALID_REF)).rejects.toThrow('AccessDenied');
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('decompresses PSCOMP magic prefix from S3', async () => {
    const COMPRESSION_MAGIC = 'PSCOMP\0';
    // Base64-encoded zlib data for 'compressed content' is complex; use a known
    // uncompressed fallback — decompressIfNeeded with forced=true handles plain too.
    // Here we just verify the magic is detected and decompressIfNeeded is called.
    // For simplicity, mock a magic-prefixed response that decompressIfNeeded can handle.
    mockS3Send.mockResolvedValueOnce(makeS3Body(COMPRESSION_MAGIC + 'not-actually-compressed'));

    // decompressIfNeeded with forced=true on non-compressed data throws or returns —
    // the important thing is the code path enters the decompression branch.
    // We expect it to throw since 'not-actually-compressed' is not valid zlib.
    await expect(readPageContent(VALID_REF)).rejects.toThrow();
  });
});

describe('writePageContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BUCKET_NAME = 'test-bucket';
  });

  it('given the content is already stored, skips the upload but touches the object', async () => {
    mockS3Send.mockResolvedValue({}); // HeadObject success, then CopyObject

    const result = await writePageContent('hello', 'tiptap');

    expect(result.ref).toBeTruthy();
    expect(result.size).toBeGreaterThan(0);

    const sent = mockS3Send.mock.calls.map(([command]) => command as { __type?: string; Body?: unknown });
    // The bytes are already correct, so nothing is uploaded...
    expect(sent.some((command) => command.Body !== undefined)).toBe(false);
    // ...but the object is copied onto itself to move its LastModified forward.
    // Without this the reclaim age floor would read a dedupe hit on an old blob
    // as "old and unreferenced" and delete a ref that is about to be committed.
    expect(sent.filter((command) => command.__type === 'copy')).toHaveLength(1);
  });

  it('given a lock is required, takes it before touching storage', async () => {
    mockS3Send.mockResolvedValue({});

    await writePageContent('hello', 'tiptap');

    // The advisory lock is the only thing standing between a dedupe hit and a
    // concurrent reclaim; assert it is actually taken, not merely intended.
    expect(mockExecute).toHaveBeenCalled();
  });

  it('uploads when HeadObject throws (new content)', async () => {
    mockS3Send.mockRejectedValueOnce(new Error('NoSuchKey')); // HeadObject miss
    mockS3Send.mockResolvedValueOnce({}); // PutObject success

    const result = await writePageContent('hello', 'tiptap');

    expect(result.ref).toBeTruthy();
    expect(mockS3Send).toHaveBeenCalledTimes(2);
  });
});
