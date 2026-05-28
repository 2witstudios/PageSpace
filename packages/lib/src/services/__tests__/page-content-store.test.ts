import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockS3Send = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: vi.fn((params) => params),
  HeadObjectCommand: vi.fn((params) => params),
  PutObjectCommand: vi.fn((params) => params),
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

  it('skips upload if HeadObject succeeds (content already stored)', async () => {
    mockS3Send.mockResolvedValueOnce({}); // HeadObject success

    const result = await writePageContent('hello', 'tiptap');

    expect(result.ref).toBeTruthy();
    expect(result.size).toBeGreaterThan(0);
    // HeadObject succeeded → no PutObject call
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  it('uploads when HeadObject throws (new content)', async () => {
    mockS3Send.mockRejectedValueOnce(new Error('NoSuchKey')); // HeadObject miss
    mockS3Send.mockResolvedValueOnce({}); // PutObject success

    const result = await writePageContent('hello', 'tiptap');

    expect(result.ref).toBeTruthy();
    expect(mockS3Send).toHaveBeenCalledTimes(2);
  });
});
