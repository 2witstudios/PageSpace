import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCheckObjectExists = vi.fn();
const mockPutObject = vi.fn();

vi.mock('@/lib/upload/s3-effects', () => ({
  checkObjectExists: (...args: unknown[]) => mockCheckObjectExists(...args),
  putObject: (...args: unknown[]) => mockPutObject(...args),
}));

const mockGetSignedUrl = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

vi.mock('@/lib/presigned-url', () => ({
  getS3Client: () => ({}),
  getS3Bucket: () => 'test-bucket',
}));

import {
  buildChatAttachmentKey,
  uploadChatAttachment,
  parseChatAttachmentStorageKey,
  parseChatAttachmentContentHash,
  hashAttachmentBuffer,
  getChatAttachmentUrl,
  isChatAttachmentStorageKey,
} from '../chat-attachment-storage';

beforeEach(() => {
  vi.clearAllMocks();
  mockPutObject.mockResolvedValue(undefined);
  mockGetSignedUrl.mockResolvedValue('https://signed.example.com/get');
});

describe('buildChatAttachmentKey', () => {
  it('given a content hash, should build a key outside the global files/ prefix', () => {
    const key = buildChatAttachmentKey('abc123');
    expect(key.startsWith('files/')).toBe(false);
    expect(key).toBe('chat-attachments/abc123/original');
  });
});

describe('uploadChatAttachment', () => {
  const buffer = Buffer.from('hello world');
  const mediaType = 'image/png';

  it('given the object already exists, should skip the PUT entirely (dedup)', async () => {
    mockCheckObjectExists.mockResolvedValue(true);

    const result = await uploadChatAttachment(buffer, mediaType);

    expect(mockPutObject).not.toHaveBeenCalled();
    expect(result.storageKey.startsWith('files/')).toBe(false);
    expect(result.storageKey).toBe(buildChatAttachmentKey(result.contentHash));
  });

  it('given the object does not exist, should PUT the bytes directly to S3', async () => {
    mockCheckObjectExists.mockResolvedValue(false);

    const result = await uploadChatAttachment(buffer, mediaType);

    expect(mockPutObject).toHaveBeenCalledWith(result.storageKey, buffer, mediaType);
  });

  it('given the same bytes twice, should produce the same content-addressed storage key', async () => {
    mockCheckObjectExists.mockResolvedValue(false);

    const first = await uploadChatAttachment(buffer, mediaType);
    const second = await uploadChatAttachment(Buffer.from('hello world'), mediaType);

    expect(second.storageKey).toBe(first.storageKey);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it('given the PUT rejects, should propagate the error', async () => {
    mockCheckObjectExists.mockResolvedValue(false);
    mockPutObject.mockRejectedValue(new Error('S3 unavailable'));

    await expect(uploadChatAttachment(buffer, mediaType)).rejects.toThrow('S3 unavailable');
  });

  it('given a buffer over the 4MB cap, should throw without touching S3', async () => {
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1);

    await expect(uploadChatAttachment(oversized, mediaType)).rejects.toThrow(/exceeds/i);

    expect(mockCheckObjectExists).not.toHaveBeenCalled();
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it('given a buffer exactly at the 4MB cap, should upload normally', async () => {
    mockCheckObjectExists.mockResolvedValue(false);
    const atLimit = Buffer.alloc(4 * 1024 * 1024);

    const result = await uploadChatAttachment(atLimit, mediaType);

    expect(result.storageKey).toBe(buildChatAttachmentKey(result.contentHash));
    expect(mockPutObject).toHaveBeenCalled();
  });
});

describe('parseChatAttachmentStorageKey', () => {
  it('given a presigned GET URL for a chat attachment, should recover the storage key', () => {
    const url = 'https://bucket.example.com/chat-attachments/' +
      'a'.repeat(64) +
      '/original?X-Amz-Signature=abc&X-Amz-Expires=3600';

    expect(parseChatAttachmentStorageKey(url)).toBe(`chat-attachments/${'a'.repeat(64)}/original`);
  });

  it('given a path-style S3 URL with a bucket prefix, should still recover the storage key', () => {
    const url = 'https://s3.example.com/my-bucket/chat-attachments/' +
      'b'.repeat(64) +
      '/original?X-Amz-Signature=abc';

    expect(parseChatAttachmentStorageKey(url)).toBe(`chat-attachments/${'b'.repeat(64)}/original`);
  });

  it('given an arbitrary external URL, should return null', () => {
    expect(parseChatAttachmentStorageKey('https://example.com/img.png')).toBeNull();
  });

  it('given a data: URL, should return null', () => {
    expect(parseChatAttachmentStorageKey('data:image/png;base64,aGVsbG8=')).toBeNull();
  });

  it('given a hash of the wrong length, should return null', () => {
    const url = 'https://bucket.example.com/chat-attachments/deadbeef/original';
    expect(parseChatAttachmentStorageKey(url)).toBeNull();
  });
});

describe('parseChatAttachmentContentHash', () => {
  const HASH = 'ab'.repeat(32);

  it('given a storage key, should return the content hash inside it', () => {
    expect(parseChatAttachmentContentHash(buildChatAttachmentKey(HASH))).toBe(HASH);
  });

  it('given a presigned URL for a chat attachment, should return the content hash', () => {
    expect(parseChatAttachmentContentHash(`https://bucket.example.com/chat-attachments/${HASH}/original?X-Amz-Signature=x`)).toBe(HASH);
  });

  it('given anything else, should return null', () => {
    expect(parseChatAttachmentContentHash('https://example.com/cat.png')).toBeNull();
    expect(parseChatAttachmentContentHash(`files/${HASH}/original`)).toBeNull();
  });
});

describe('hashAttachmentBuffer', () => {
  it('should be the sha256 hex of the bytes — the hash the storage key is built from', () => {
    expect(hashAttachmentBuffer(Buffer.from('hello world'))).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
  });
});

describe('getChatAttachmentUrl — key scope', () => {
  const HASH = 'a'.repeat(64);
  const OWN_KEY = `chat-attachments/${HASH}/original`;

  it('given a key this module minted, should sign a GET for exactly that key', async () => {
    const url = await getChatAttachmentUrl(OWN_KEY);

    expect(url).toBe('https://signed.example.com/get');
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    const command = mockGetSignedUrl.mock.calls[0][1] as { input: { Bucket: string; Key: string } };
    expect(command.input).toEqual({ Bucket: 'test-bucket', Key: OWN_KEY });
  });

  it('given the key uploadChatAttachment returns, should accept it (mint and check agree)', async () => {
    mockCheckObjectExists.mockResolvedValue(true);
    const { storageKey } = await uploadChatAttachment(Buffer.from('hello world'), 'image/png');

    expect(isChatAttachmentStorageKey(storageKey)).toBe(true);
  });

  const refused: Array<[string, unknown]> = [
    ["another tenant's page file", `files/${HASH}/original`],
    ['a processor cache object', `cache/${HASH}/ai-vision`],
    ['an avatar', 'avatars/user-1/avatar.png'],
    ['a valid prefix followed by /../ traversal', `chat-attachments/${HASH}/original/../../../files/${HASH}/original`],
    ['traversal in place of the hash', `chat-attachments/../files/${HASH}/original`],
    ['a non-hex hash', `chat-attachments/${'g'.repeat(64)}/original`],
    ['an uppercase-hex hash', `chat-attachments/${'A'.repeat(64)}/original`],
    ['a short hash', 'chat-attachments/deadbeef/original'],
    ['a long hash', `chat-attachments/${'a'.repeat(65)}/original`],
    ['a different leaf', `chat-attachments/${HASH}/thumbnail`],
    ['a leading path segment', `files/${OWN_KEY}`],
    ['a leading slash', `/${OWN_KEY}`],
    ['a trailing suffix', `${OWN_KEY}/extra`],
    ['a trailing newline', `${OWN_KEY}\n`],
    ['a full URL containing a valid key', `https://bucket.example.com/${OWN_KEY}`],
    ['a query string after a valid key', `${OWN_KEY}?versionId=1`],
    ['an empty string', ''],
    ['a non-string', { toString: () => OWN_KEY }],
  ];

  it.each(refused)('given %s, should throw without signing anything', async (_label, key) => {
    expect(isChatAttachmentStorageKey(key)).toBe(false);
    await expect(getChatAttachmentUrl(key as string)).rejects.toThrow(/refusing to sign/i);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});
