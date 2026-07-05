import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCheckObjectExists = vi.fn();
const mockIssuePresignedPutUrl = vi.fn();

vi.mock('@/lib/upload/s3-effects', () => ({
  checkObjectExists: (...args: unknown[]) => mockCheckObjectExists(...args),
  issuePresignedPutUrl: (...args: unknown[]) => mockIssuePresignedPutUrl(...args),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { buildChatAttachmentKey, uploadChatAttachment } from '../chat-attachment-storage';

beforeEach(() => {
  vi.clearAllMocks();
  mockIssuePresignedPutUrl.mockResolvedValue('https://signed.example.com/put');
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
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

  it('given the object already exists, should skip the presigned PUT entirely (dedup)', async () => {
    mockCheckObjectExists.mockResolvedValue(true);

    const result = await uploadChatAttachment(buffer, mediaType);

    expect(mockIssuePresignedPutUrl).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.storageKey.startsWith('files/')).toBe(false);
    expect(result.storageKey).toBe(buildChatAttachmentKey(result.contentHash));
  });

  it('given the object does not exist, should issue a presigned PUT and upload the bytes', async () => {
    mockCheckObjectExists.mockResolvedValue(false);

    const result = await uploadChatAttachment(buffer, mediaType);

    expect(mockIssuePresignedPutUrl).toHaveBeenCalledWith(
      result.storageKey,
      mediaType,
      buffer.byteLength,
      expect.any(Number),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://signed.example.com/put',
      expect.objectContaining({
        method: 'PUT',
        body: buffer,
        headers: expect.objectContaining({ 'Content-Type': mediaType }),
      }),
    );
  });

  it('given the same bytes twice, should produce the same content-addressed storage key', async () => {
    mockCheckObjectExists.mockResolvedValue(false);

    const first = await uploadChatAttachment(buffer, mediaType);
    const second = await uploadChatAttachment(Buffer.from('hello world'), mediaType);

    expect(second.storageKey).toBe(first.storageKey);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it('given the PUT response is not ok, should throw', async () => {
    mockCheckObjectExists.mockResolvedValue(false);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(uploadChatAttachment(buffer, mediaType)).rejects.toThrow();
  });

  it('given a buffer over the 4MB cap, should throw without touching S3', async () => {
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1);

    await expect(uploadChatAttachment(oversized, mediaType)).rejects.toThrow(/exceeds/i);

    expect(mockCheckObjectExists).not.toHaveBeenCalled();
    expect(mockIssuePresignedPutUrl).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('given a buffer exactly at the 4MB cap, should upload normally', async () => {
    mockCheckObjectExists.mockResolvedValue(false);
    const atLimit = Buffer.alloc(4 * 1024 * 1024);

    const result = await uploadChatAttachment(atLimit, mediaType);

    expect(result.storageKey).toBe(buildChatAttachmentKey(result.contentHash));
    expect(mockFetch).toHaveBeenCalled();
  });
});
