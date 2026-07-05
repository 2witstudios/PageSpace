import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';

const mockUploadChatAttachment = vi.fn();
const mockGetChatAttachmentUrl = vi.fn();

vi.mock('@/lib/upload/chat-attachment-storage', () => ({
  uploadChatAttachment: (...args: unknown[]) => mockUploadChatAttachment(...args),
  getChatAttachmentUrl: (...args: unknown[]) => mockGetChatAttachmentUrl(...args),
}));

import { extractStructuredContentFromParts, convertDbMessageToUIMessage } from '../message-utils';

beforeEach(() => {
  vi.clearAllMocks();
  mockUploadChatAttachment.mockResolvedValue({
    storageKey: 'chat-attachments/deadbeef/original',
    contentHash: 'deadbeef',
  });
  mockGetChatAttachmentUrl.mockResolvedValue('https://signed.example.com/get/deadbeef');
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
      fileParts: [{ storageKey: 'chat-attachments/deadbeef/original', mediaType: 'image/png', filename: 'a.png' }],
      partsOrder: [{ index: 0, type: 'file' }],
      originalContent: '',
    });

    const result = await convertDbMessageToUIMessage({ ...baseMeta, content: structuredContent });

    expect(mockGetChatAttachmentUrl).toHaveBeenCalledWith('chat-attachments/deadbeef/original');
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
});
