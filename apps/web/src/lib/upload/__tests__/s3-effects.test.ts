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
  GetObjectCommand: class {
    kind = 'get';
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  DeleteObjectCommand: class {
    kind = 'delete';
    input: unknown;
    constructor(input: unknown) {
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

import { createHash } from 'crypto';
import { issuePresignedPutUrl, checkObjectExists, putObject, digestStoredObject, deleteStoredObject } from '../s3-effects';

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

describe('putObject', () => {
  it('sends a PutObjectCommand with the bucket, key, body, and content type', async () => {
    mockSend.mockResolvedValue({});
    const body = Buffer.from('hello');

    await putObject('chat-attachments/abc/original', body, 'image/png');

    expect(putObjectCtor).toHaveBeenCalledWith({
      Bucket: 'test-bucket',
      Key: 'chat-attachments/abc/original',
      Body: body,
      ContentType: 'image/png',
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed send', async () => {
    mockSend.mockRejectedValue(new Error('S3 unavailable'));
    await expect(putObject('key', Buffer.from('x'), 'image/png')).rejects.toThrow('S3 unavailable');
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

describe('digestStoredObject', () => {
  const chunks = [Buffer.from('hello '), Buffer.from('world')];
  const sha256 = createHash('sha256').update('hello world').digest('hex');
  async function* stream(parts: Buffer[], onEnd?: () => void) {
    try {
      for (const part of parts) yield new Uint8Array(part);
    } finally {
      onEnd?.();
    }
  }

  it('given a stored object, should stream it and return its sha256 and size, reading the key it was given', async () => {
    mockSend.mockResolvedValue({ Body: stream(chunks) });

    const result = await digestStoredObject('files/k/original', 1024);

    expect(result).toEqual({ status: 'ok', sha256, size: 11 });
    expect(mockSend.mock.calls[0][0]).toMatchObject({ kind: 'get', input: { Bucket: 'test-bucket', Key: 'files/k/original' } });
  });

  it('given an object larger than the bound, should stop reading and report oversize', async () => {
    let closed = false;
    mockSend.mockResolvedValue({ Body: stream([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)], () => { closed = true; }) });

    expect(await digestStoredObject('k', 10)).toEqual({ status: 'oversize' });
    expect(closed).toBe(true);
  });

  it('given exactly the bound, should accept it', async () => {
    mockSend.mockResolvedValue({ Body: stream(chunks) });
    expect(await digestStoredObject('k', 11)).toMatchObject({ status: 'ok', size: 11 });
  });

  it('given a missing object, should report missing', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('nope'), { name: 'NoSuchKey' }));
    expect(await digestStoredObject('k', 10)).toEqual({ status: 'missing' });
  });

  it('given any other storage error, should throw', async () => {
    mockSend.mockRejectedValue(new Error('timeout'));
    await expect(digestStoredObject('k', 10)).rejects.toThrow('timeout');
  });
});

describe('deleteStoredObject', () => {
  it('should delete exactly the given key', async () => {
    mockSend.mockResolvedValue({});
    await deleteStoredObject('files/k/original');
    expect(mockSend.mock.calls[0][0]).toMatchObject({ kind: 'delete', input: { Bucket: 'test-bucket', Key: 'files/k/original' } });
  });
});
