import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCheckObjectExists = vi.fn();
const mockPutObject = vi.fn();

vi.mock('@/lib/upload/s3-effects', () => ({
  checkObjectExists: (...args: unknown[]) => mockCheckObjectExists(...args),
  putObject: (...args: unknown[]) => mockPutObject(...args),
}));

import { buildChatAttachmentKey, uploadChatAttachment, parseChatAttachmentStorageKey } from '../chat-attachment-storage';

beforeEach(() => {
  vi.clearAllMocks();
  mockPutObject.mockResolvedValue(undefined);
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
