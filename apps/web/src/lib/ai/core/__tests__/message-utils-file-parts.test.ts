import { describe, it, expect } from 'vitest';
import { convertDbMessageToUIMessage } from '../message-utils';

/**
 * Tests for file-part round-trip through convertDbMessageToUIMessage.
 * Validates that structured content with file parts is correctly
 * reconstructed into UIMessage format.
 */
describe('convertDbMessageToUIMessage with file parts', () => {
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

  it('given structured content with file parts, should reconstruct file parts in order', () => {
    const structuredContent = JSON.stringify({
      textParts: ['Look at this image:'],
      fileParts: [
        { url: 'data:image/png;base64,abc123', mediaType: 'image/png', filename: 'screenshot.png' },
      ],
      partsOrder: [
        { index: 0, type: 'text' },
        { index: 1, type: 'file' },
      ],
      originalContent: 'Look at this image:',
    });

    const result = convertDbMessageToUIMessage({
      ...baseMeta,
      content: structuredContent,
    });

    expect(result.parts).toHaveLength(2);
    expect(result.parts[0]).toEqual({ type: 'text', text: 'Look at this image:' });
    expect(result.parts[1]).toEqual({
      type: 'file',
      url: 'data:image/png;base64,abc123',
      mediaType: 'image/png',
      filename: 'screenshot.png',
    });
  });

  it('given multiple interleaved text and file parts, should preserve ordering', () => {
    const structuredContent = JSON.stringify({
      textParts: ['First text', 'Second text'],
      fileParts: [
        { url: 'data:image/jpeg;base64,jpg1', mediaType: 'image/jpeg', filename: 'photo.jpg' },
        { url: 'data:image/png;base64,png2', mediaType: 'image/png', filename: 'chart.png' },
      ],
      partsOrder: [
        { index: 0, type: 'text' },
        { index: 1, type: 'file' },
        { index: 2, type: 'text' },
        { index: 3, type: 'file' },
      ],
      originalContent: 'First text Second text',
    });

    const result = convertDbMessageToUIMessage({
      ...baseMeta,
      content: structuredContent,
    });

    expect(result.parts).toHaveLength(4);
    expect(result.parts[0].type).toBe('text');
    expect(result.parts[1].type).toBe('file');
    expect(result.parts[2].type).toBe('text');
    expect(result.parts[3].type).toBe('file');

    // Verify file data
    const filePart1 = result.parts[1] as { type: string; url: string; filename: string };
    expect(filePart1.url).toBe('data:image/jpeg;base64,jpg1');
    expect(filePart1.filename).toBe('photo.jpg');

    const filePart2 = result.parts[3] as { type: string; url: string; filename: string };
    expect(filePart2.url).toBe('data:image/png;base64,png2');
    expect(filePart2.filename).toBe('chart.png');
  });

  it('given plain text content (no structured data), should return single text part', () => {
    const result = convertDbMessageToUIMessage({
      ...baseMeta,
      content: 'Just plain text',
    });

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toEqual({ type: 'text', text: 'Just plain text' });
  });

  it('given structured content without fileParts, should handle backward compatibility', () => {
    const structuredContent = JSON.stringify({
      textParts: ['Hello world'],
      partsOrder: [{ index: 0, type: 'text' }],
      originalContent: 'Hello world',
    });

    const result = convertDbMessageToUIMessage({
      ...baseMeta,
      content: structuredContent,
    });

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toEqual({ type: 'text', text: 'Hello world' });
  });

  it('given structured content with file parts but missing optional fields, should handle gracefully', () => {
    const structuredContent = JSON.stringify({
      textParts: [],
      fileParts: [
        { url: 'data:image/webp;base64,webpdata' },
      ],
      partsOrder: [
        { index: 0, type: 'file' },
      ],
      originalContent: '',
    });

    const result = convertDbMessageToUIMessage({
      ...baseMeta,
      content: structuredContent,
    });

    expect(result.parts).toHaveLength(1);
    const filePart = result.parts[0] as { type: string; url: string; mediaType?: string; filename?: string };
    expect(filePart.type).toBe('file');
    expect(filePart.url).toBe('data:image/webp;base64,webpdata');
    expect(filePart.mediaType).toBeUndefined();
    expect(filePart.filename).toBeUndefined();
  });

  it('given null content, should return empty text part', () => {
    const result = convertDbMessageToUIMessage({
      ...baseMeta,
      content: null as unknown as string,
    });

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toEqual({ type: 'text', text: '' });
  });
});
