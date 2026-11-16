import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';

const mockUploadChatAttachment = vi.fn();
const mockGetChatAttachmentUrl = vi.fn();

// A persisted key must be the exact shape the storage module mints, or
// reconstruct refuses to sign it — so the read-side fixtures use a real one and
// the real predicate.
const PERSISTED_KEY = `chat-attachments/${'d'.repeat(64)}/original`;

vi.mock('@/lib/upload/chat-attachment-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/upload/chat-attachment-storage')>()),
  uploadChatAttachment: (...args: unknown[]) => mockUploadChatAttachment(...args),
  getChatAttachmentUrl: (...args: unknown[]) => mockGetChatAttachmentUrl(...args),
}));

const mockFindBlockedUploads = vi.fn();
vi.mock('@pagespace/lib/content-safety/upload-gate', () => ({
  findBlockedUploads: (...args: unknown[]) => mockFindBlockedUploads(...args),
}));

import {
  extractStructuredContentFromParts,
  convertDbMessageToUIMessage,
  screenFilePartsAgainstBlocklist,
} from '../message-utils';

beforeEach(() => {
  vi.clearAllMocks();
  mockUploadChatAttachment.mockResolvedValue({
    storageKey: 'chat-attachments/deadbeef/original',
    contentHash: 'deadbeef',
  });
  mockGetChatAttachmentUrl.mockResolvedValue('https://signed.example.com/get/deadbeef');
  mockFindBlockedUploads.mockResolvedValue(new Set());
});

describe('extractStructuredContentFromParts — S3-backed file parts', () => {
  it('given a new data: URL file part, should upload it and persist a storageKey instead of raw base64', async () => {
    const filePart = {
      type: 'file' as const,
      url: 'data:image/png;base64,aGVsbG8gd29ybGQ=', // "hello world"
      mediaType: 'image/png',
      filename: 'screenshot.png',
    } as unknown as UIMessage['parts'][number];

    const content = await extractStructuredContentFromParts([filePart], '');
    const structured = JSON.parse(content);

    expect(structured.fileParts).toHaveLength(1);
    expect(structured.fileParts[0].storageKey).toBe('chat-attachments/deadbeef/original');
    expect(structured.fileParts[0].url).toBeUndefined();
    expect(content).not.toContain('aGVsbG8gd29ybGQ=');

    expect(mockUploadChatAttachment).toHaveBeenCalledTimes(1);
    const [buffer, mediaType] = mockUploadChatAttachment.mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect((buffer as Buffer).toString('utf-8')).toBe('hello world');
    expect(mediaType).toBe('image/png');
  });

  it('given a file part with an already-hosted (non-data) URL, should pass it through unchanged', async () => {
    const filePart = {
      type: 'file' as const,
      url: 'https://example.com/already-hosted.png',
      mediaType: 'image/png',
      filename: 'hosted.png',
    } as unknown as UIMessage['parts'][number];

    const content = await extractStructuredContentFromParts([filePart], '');
    const structured = JSON.parse(content);

    expect(structured.fileParts).toEqual([
      { url: 'https://example.com/already-hosted.png', mediaType: 'image/png', filename: 'hosted.png' },
    ]);
    expect(mockUploadChatAttachment).not.toHaveBeenCalled();
  });

  it('given a data: URL file part with no explicit mediaType, should persist the mediaType parsed from the data URL', async () => {
    const filePart = {
      type: 'file' as const,
      url: 'data:image/png;base64,aGVsbG8gd29ybGQ=',
      filename: 'screenshot.png',
    } as unknown as UIMessage['parts'][number];

    const content = await extractStructuredContentFromParts([filePart], '');
    const structured = JSON.parse(content);

    expect(structured.fileParts[0].mediaType).toBe('image/png');
    const [, uploadedMediaType] = mockUploadChatAttachment.mock.calls[0];
    expect(uploadedMediaType).toBe('image/png');
  });

  it('given a re-sent presigned chat-attachment URL (regenerate/resend), should recover and persist the storageKey instead of the expiring URL', async () => {
    const hash = 'd'.repeat(64);
    const filePart = {
      type: 'file' as const,
      url: `https://bucket.example.com/chat-attachments/${hash}/original?X-Amz-Signature=abc`,
      mediaType: 'image/png',
      filename: 'resent.png',
    } as unknown as UIMessage['parts'][number];

    const content = await extractStructuredContentFromParts([filePart], '');
    const structured = JSON.parse(content);

    expect(structured.fileParts).toEqual([
      { storageKey: `chat-attachments/${hash}/original`, mediaType: 'image/png', filename: 'resent.png' },
    ]);
    expect(mockUploadChatAttachment).not.toHaveBeenCalled();
  });
});

describe('convertDbMessageToUIMessage — S3-backed file parts', () => {
  const baseMeta = {
    id: 'msg-1',
    pageId: 'page-1',
    userId: 'user-1',
    role: 'user' as const,
    createdAt: new Date('2025-01-01'),
    isActive: true,
    editedAt: null,
    toolCalls: null,
    toolResults: null,
  };

  it('given a persisted storageKey file part, should regenerate a fresh presigned URL', async () => {
    const structuredContent = JSON.stringify({
      textParts: [],
      fileParts: [{ storageKey: PERSISTED_KEY, mediaType: 'image/png', filename: 'a.png' }],
      partsOrder: [{ index: 0, type: 'file' }],
      originalContent: '',
    });

    const result = await convertDbMessageToUIMessage({ ...baseMeta, content: structuredContent });

    expect(mockGetChatAttachmentUrl).toHaveBeenCalledWith(PERSISTED_KEY);
    expect(result.parts[0]).toEqual({
      type: 'file',
      url: 'https://signed.example.com/get/deadbeef',
      mediaType: 'image/png',
      filename: 'a.png',
    });
  });

  it('given a legacy persisted url file part (no storageKey), should pass the url through unchanged', async () => {
    const structuredContent = JSON.stringify({
      textParts: [],
      fileParts: [{ url: 'data:image/png;base64,legacydata', mediaType: 'image/png', filename: 'b.png' }],
      partsOrder: [{ index: 0, type: 'file' }],
      originalContent: '',
    });

    const result = await convertDbMessageToUIMessage({ ...baseMeta, content: structuredContent });

    expect(mockGetChatAttachmentUrl).not.toHaveBeenCalled();
    expect(result.parts[0]).toEqual({
      type: 'file',
      url: 'data:image/png;base64,legacydata',
      mediaType: 'image/png',
      filename: 'b.png',
    });
  });

  it('given the presigned URL regeneration fails, should fall back to originalContent text instead of leaking the raw structured JSON', async () => {
    mockGetChatAttachmentUrl.mockRejectedValue(new Error('S3 unavailable'));
    const structuredContent = JSON.stringify({
      textParts: [],
      fileParts: [{ storageKey: PERSISTED_KEY, mediaType: 'image/png', filename: 'a.png' }],
      partsOrder: [{ index: 0, type: 'file' }],
      originalContent: 'my message',
    });

    const result = await convertDbMessageToUIMessage({ ...baseMeta, content: structuredContent });

    expect(result.parts).toEqual([{ type: 'text', text: 'my message' }]);
    expect(JSON.stringify(result)).not.toContain('storageKey');
  });
});

describe('screenFilePartsAgainstBlocklist', () => {
  const HELLO_WORLD_SHA256 = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
  const ECHOED_HASH = 'ab'.repeat(32);
  type Part = UIMessage['parts'][number];

  const text = { type: 'text', text: 'look at this' } as Part;
  const newUpload = { type: 'file', url: 'data:image/png;base64,aGVsbG8gd29ybGQ=', mediaType: 'image/png' } as unknown as Part;
  const echoed = {
    type: 'file',
    url: `https://bucket.example.com/chat-attachments/${ECHOED_HASH}/original?X-Amz-Signature=x`,
    mediaType: 'image/png',
  } as unknown as Part;
  const hosted = { type: 'file', url: 'https://example.com/cat.png', mediaType: 'image/png' } as unknown as Part;

  it('given new uploads and echoed keys, should check every hash in ONE call, attributed to the sender', async () => {
    await screenFilePartsAgainstBlocklist([text, newUpload, echoed], { userId: 'user-1' });

    expect(mockFindBlockedUploads).toHaveBeenCalledTimes(1);
    expect(mockFindBlockedUploads).toHaveBeenCalledWith([HELLO_WORLD_SHA256, ECHOED_HASH], {
      entryPoint: 'chat-attachment',
      userId: 'user-1',
    });
  });

  it('given nothing blocked, should return the parts untouched', async () => {
    const parts = [text, newUpload, echoed];

    const result = await screenFilePartsAgainstBlocklist(parts);

    expect(result).toEqual({ parts, blockedHashes: [] });
  });

  it('given a blocked new upload, should drop that part and report its hash', async () => {
    mockFindBlockedUploads.mockResolvedValue(new Set([HELLO_WORLD_SHA256]));

    const result = await screenFilePartsAgainstBlocklist([text, newUpload, echoed]);

    expect(result.parts).toEqual([text, echoed]);
    expect(result.blockedHashes).toEqual([HELLO_WORLD_SHA256]);
  });

  it('given a blocked ECHOED key, should drop it — a reference to stored bytes is checked like the bytes', async () => {
    mockFindBlockedUploads.mockResolvedValue(new Set([ECHOED_HASH]));

    const result = await screenFilePartsAgainstBlocklist([text, echoed]);

    expect(result.parts).toEqual([text]);
    expect(result.blockedHashes).toEqual([ECHOED_HASH]);
  });

  it('given no file part that touches our storage, should not query the blocklist', async () => {
    const parts = [text, hosted];

    const result = await screenFilePartsAgainstBlocklist(parts);

    expect(result).toEqual({ parts, blockedHashes: [] });
    expect(mockFindBlockedUploads).not.toHaveBeenCalled();
  });

  it('given no user in scope, should attribute the check to nobody rather than null', async () => {
    await screenFilePartsAgainstBlocklist([echoed], { userId: null });

    expect(mockFindBlockedUploads).toHaveBeenCalledWith([ECHOED_HASH], { entryPoint: 'chat-attachment', userId: undefined });
  });
});
