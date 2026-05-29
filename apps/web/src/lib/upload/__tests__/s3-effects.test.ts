import { describe, it, expect, vi, beforeEach } from 'vitest';

const putObjectCtor = vi.fn();
const headObjectCtor = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      putObjectCtor(input);
      this.input = input;
    }
  },
  HeadObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      headObjectCtor(input);
      this.input = input;
    }
  },
}));

const mockGetSignedUrl = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

const mockSend = vi.fn();
vi.mock('@/lib/presigned-url', () => ({
  getS3Client: () => ({ send: mockSend }),
  getS3Bucket: () => 'test-bucket',
}));

import { issuePresignedPutUrl, checkObjectExists } from '../s3-effects';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSignedUrl.mockResolvedValue('https://signed.example.com/put');
});

describe('issuePresignedPutUrl', () => {
  it('pins the exact byte length on the signed command so a larger upload is rejected', async () => {
    await issuePresignedPutUrl('files/abc/original', 'image/jpeg', 4096, 900);
    expect(putObjectCtor).toHaveBeenCalledWith(
      expect.objectContaining({ ContentLength: 4096 }),
    );
  });

  it('does not pass a Conditions field that the PUT command would silently drop', async () => {
    await issuePresignedPutUrl('files/abc/original', 'image/jpeg', 4096, 900);
    const passed = putObjectCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(passed).not.toHaveProperty('Conditions');
  });

  it('signs with the requested TTL', async () => {
    await issuePresignedPutUrl('files/abc/original', 'image/jpeg', 4096, 600);
    expect(mockGetSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { expiresIn: 600 },
    );
  });
});

describe('checkObjectExists', () => {
  it('returns true when HeadObject succeeds', async () => {
    mockSend.mockResolvedValue({});
    expect(await checkObjectExists('files/abc/original')).toBe(true);
  });

  it('returns false when the object is not found', async () => {
    const notFound = Object.assign(new Error('not found'), { name: 'NotFound' });
    mockSend.mockRejectedValue(notFound);
    expect(await checkObjectExists('files/abc/original')).toBe(false);
  });

  it('rethrows unexpected errors instead of treating them as missing', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('boom'), { name: 'AccessDenied' }));
    await expect(checkObjectExists('files/abc/original')).rejects.toThrow('boom');
  });
});
