import { describe, it, expect } from 'vitest';
import { toModelOutputForReadPage, degradeVisualContentToMetadata } from '../read-page-vision-output';

describe('toModelOutputForReadPage', () => {
  it('given a visual_content_delivered output, should map it to a content ToolResultOutput with a text part and an image-data part', () => {
    const output = {
      success: true,
      type: 'visual_content_delivered',
      pageId: 'page-1',
      title: 'diagram.png',
      mimeType: 'image/jpeg',
      message: 'Delivered visual content: "diagram.png" (image/jpeg)',
      imageBase64: 'ZmFrZS1iYXNlNjQ=',
      sizeBytes: 1234,
      metadata: { processingStatus: 'visual', originalFileName: 'diagram.png', presetUsed: 'ai-vision' },
    };

    const result = toModelOutputForReadPage(output);

    expect(result).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: output.message },
        { type: 'image-data', data: output.imageBase64, mediaType: output.mimeType },
      ],
    });
  });

  it('given a visual_content_metadata output (no image bytes), should pass it through as a json ToolResultOutput unchanged', () => {
    const output = {
      success: true,
      type: 'visual_content_metadata',
      pageId: 'page-2',
      title: 'diagram.png',
      message: 'Found visual content: "diagram.png" (image/png)',
      mimeType: 'image/png',
      sizeBytes: 5000,
      summary: 'This is a visual file that requires vision capabilities to process',
      stats: { documentType: 'VISUAL', mimeType: 'image/png', sizeBytes: 5000, sizeMB: '0.00' },
      metadata: { requiresVisionModel: true, processingStatus: 'visual', originalFileName: 'diagram.png' },
    };

    const result = toModelOutputForReadPage(output);

    expect(result).toEqual({ type: 'json', value: output });
  });

  it('given a visual_requires_vision_model output, should pass it through as a json ToolResultOutput unchanged', () => {
    const output = {
      success: true,
      type: 'visual_requires_vision_model',
      title: 'diagram.png',
      mimeType: 'image/png',
      message: 'This is a visual file (image/png). To view its content, please switch to a vision-capable model.',
      suggestedModels: ['openai/gpt-5.4'],
      metadata: { fileType: 'image/png', requiresVision: true },
    };

    const result = toModelOutputForReadPage(output);

    expect(result).toEqual({ type: 'json', value: output });
  });

  it('given a plain text-page read result with no visual type field, should pass it through as a json ToolResultOutput unchanged', () => {
    const output = { success: true, content: '1 | hello world', title: 'notes.md' };

    const result = toModelOutputForReadPage(output);

    expect(result).toEqual({ type: 'json', value: output });
  });

  it('given an error result, should pass it through as a json ToolResultOutput unchanged', () => {
    const output = { success: false, error: 'File is still being processed', status: 'processing' };

    const result = toModelOutputForReadPage(output);

    expect(result).toEqual({ type: 'json', value: output });
  });
});

describe('degradeVisualContentToMetadata', () => {
  it('given a visual_content_delivered output, should strip the image bytes and return a visual_content_metadata shape', () => {
    const output = {
      success: true,
      type: 'visual_content_delivered',
      pageId: 'page-1',
      title: 'diagram.png',
      mimeType: 'image/jpeg',
      message: 'Delivered visual content: "diagram.png" (image/jpeg)',
      imageBase64: 'ZmFrZS1iYXNlNjQ=',
      sizeBytes: 1234,
      metadata: { processingStatus: 'visual', originalFileName: 'diagram.png', presetUsed: 'ai-vision' },
    };

    const result = degradeVisualContentToMetadata(output) as Record<string, unknown>;

    expect(result.type).toBe('visual_content_metadata');
    expect(result).not.toHaveProperty('imageBase64');
    expect(JSON.stringify(result)).not.toContain(output.imageBase64);
  });

  it('given a non-visual output, should return it unchanged', () => {
    const output = { success: true, content: '1 | hello world', title: 'notes.md' };

    const result = degradeVisualContentToMetadata(output);

    expect(result).toEqual(output);
  });
});
