import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { toModelOutputForReadPage, degradeVisualContentToMetadata, guardReadPageToolForVision, visualToolResultScreenParts } from '../read-page-vision-output';

describe('toModelOutputForReadPage', () => {
  it('given a visual_content_delivered output, should map it to a content ToolResultOutput with a text part and an image-data part', () => {
    const output = {
      success: true,
      type: 'visual_content_delivered',
      pageId: 'page-1',
      title: 'diagram.png',
      mimeType: 'image/jpeg',
      originalMimeType: 'image/png',
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
      originalMimeType: 'image/png',
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

  it('given a visual_content_delivered output whose delivered bytes were re-encoded to a different format than the original upload, should report the ORIGINAL mimeType, not the delivered preset mimeType', () => {
    // The processor always re-encodes ai-vision/ai-chat presets as jpeg regardless of
    // the source format, so a PNG upload's delivered mimeType is 'image/jpeg' — the
    // degraded result must still tell the model the file is really a PNG.
    const output = {
      success: true,
      type: 'visual_content_delivered',
      pageId: 'page-1',
      title: 'diagram.png',
      mimeType: 'image/jpeg',
      originalMimeType: 'image/png',
      message: 'Delivered visual content: "diagram.png" (image/jpeg)',
      imageBase64: 'ZmFrZS1iYXNlNjQ=',
      sizeBytes: 1234,
      metadata: { processingStatus: 'visual', originalFileName: 'diagram.png', presetUsed: 'ai-vision' },
    };

    const result = degradeVisualContentToMetadata(output) as Record<string, unknown>;

    expect(result.mimeType).toBe('image/png');
    expect((result.stats as Record<string, unknown>).mimeType).toBe('image/png');
    expect(result.message).toContain('image/png');
  });

  it('given a non-visual output, should return it unchanged', () => {
    const output = { success: true, content: '1 | hello world', title: 'notes.md' };

    const result = degradeVisualContentToMetadata(output);

    expect(result).toEqual(output);
  });
});

describe('guardReadPageToolForVision', () => {
  const staleVisualOutput = {
    success: true,
    type: 'visual_content_delivered',
    pageId: 'page-1',
    title: 'diagram.png',
    mimeType: 'image/jpeg',
    originalMimeType: 'image/png',
    message: 'Delivered visual content: "diagram.png" (image/jpeg)',
    imageBase64: 'ZmFrZS1iYXNlNjQ=',
    sizeBytes: 1234,
    metadata: { processingStatus: 'visual', originalFileName: 'diagram.png', presetUsed: 'ai-vision' },
  };

  const makeReadPageTool = () => ({
    description: 'Read the content of any page',
    toModelOutput: ({ output }: { toolCallId: string; input: unknown; output: unknown }) =>
      toModelOutputForReadPage(output),
    execute: async () => ({}),
  });

  it('given hasVision: true, should leave the tool behavior unchanged for a stale image tool result', () => {
    const guarded = guardReadPageToolForVision(makeReadPageTool(), { hasVision: true, hasPdfInput: false, hasToolResultMedia: true });

    const result = guarded.toModelOutput!({ toolCallId: '1', input: {}, output: staleVisualOutput });

    expect(result).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: staleVisualOutput.message },
        { type: 'image-data', data: staleVisualOutput.imageBase64, mediaType: staleVisualOutput.mimeType },
      ],
    });
  });

  it('given hasVision: false, should degrade a stale image tool result to metadata-only instead of an image content part', () => {
    const guarded = guardReadPageToolForVision(makeReadPageTool(), { hasVision: false, hasPdfInput: false, hasToolResultMedia: true });

    const result = guarded.toModelOutput!({ toolCallId: '1', input: {}, output: staleVisualOutput }) as {
      type: string;
      value: Record<string, unknown>;
    };

    expect(result.type).toBe('json');
    expect(result.value.type).toBe('visual_content_metadata');
    expect(JSON.stringify(result)).not.toContain(staleVisualOutput.imageBase64);
  });
});

const pdfPartsOutput = {
  success: true,
  type: 'visual_parts_delivered',
  pageId: 'page-pdf',
  title: 'Exhibits.pdf',
  originalMimeType: 'application/pdf',
  message: 'Delivered "Exhibits.pdf" as a PDF (12 pages).',
  parts: [{ kind: 'file', mediaType: 'application/pdf', data: 'JVBERi0xLjQ=', filename: 'Exhibits.pdf' }],
  sizeBytes: 9,
  metadata: { processingStatus: 'visual', delivery: 'pdf' },
};

const pageImagesOutput = {
  success: true,
  type: 'visual_parts_delivered',
  pageId: 'page-pdf',
  title: 'Exhibits.pdf',
  originalMimeType: 'application/pdf',
  message: 'Showing pages 2-3 of 12 from "Exhibits.pdf" as images.',
  parts: [
    { kind: 'image', mediaType: 'image/jpeg', data: '/9j/AAAA', pdfPage: 2 },
    { kind: 'image', mediaType: 'image/jpeg', data: '/9j/BBBB', pdfPage: 3 },
  ],
  sizeBytes: 9,
  metadata: { processingStatus: 'visual', delivery: 'page-images' },
};

describe('toModelOutputForReadPage — visual_parts_delivered', () => {
  it('given a native PDF part, should map it to a file-data content part', () => {
    expect(toModelOutputForReadPage(pdfPartsOutput)).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: pdfPartsOutput.message },
        { type: 'file-data', data: 'JVBERi0xLjQ=', mediaType: 'application/pdf', filename: 'Exhibits.pdf' },
      ],
    });
  });

  it('given rasterized PDF pages, should label each image with its page number', () => {
    expect(toModelOutputForReadPage(pageImagesOutput)).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: pageImagesOutput.message },
        { type: 'text', text: 'Page 2:' },
        { type: 'image-data', data: '/9j/AAAA', mediaType: 'image/jpeg' },
        { type: 'text', text: 'Page 3:' },
        { type: 'image-data', data: '/9j/BBBB', mediaType: 'image/jpeg' },
      ],
    });
  });
});

describe('degradeVisualContentToMetadata — visual_parts_delivered', () => {
  it('given delivered parts, should strip every byte and return visual_content_metadata with the original type', () => {
    const result = degradeVisualContentToMetadata(pageImagesOutput) as Record<string, unknown>;
    expect(result.type).toBe('visual_content_metadata');
    expect(result.mimeType).toBe('application/pdf');
    expect(JSON.stringify(result)).not.toContain('/9j/AAAA');
  });
});

describe('guardReadPageToolForVision — PDF parts', () => {
  const makeReadPageTool = () => ({
    toModelOutput: ({ output }: { toolCallId: string; input: unknown; output: unknown }) =>
      toModelOutputForReadPage(output),
  });

  it('given a vision model with PDF input, should re-send a stale native PDF unchanged', () => {
    const guarded = guardReadPageToolForVision(makeReadPageTool(), { hasVision: true, hasPdfInput: true, hasToolResultMedia: true });
    const result = guarded.toModelOutput!({ toolCallId: '1', input: {}, output: pdfPartsOutput }) as { type: string };
    expect(result.type).toBe('content');
    expect(JSON.stringify(result)).toContain('file-data');
  });

  it('given a vision model without PDF input, should not re-send a stale native PDF part', () => {
    const guarded = guardReadPageToolForVision(makeReadPageTool(), { hasVision: true, hasPdfInput: false, hasToolResultMedia: true });
    const result = guarded.toModelOutput!({ toolCallId: '1', input: {}, output: pdfPartsOutput }) as {
      type: string;
      value: Record<string, unknown>;
    };
    expect(result.type).toBe('json');
    expect(result.value.type).toBe('visual_content_metadata');
    expect(JSON.stringify(result)).not.toContain('JVBERi0xLjQ=');
    expect(JSON.stringify(result.value.metadata)).toContain('pages');
  });

  it('given a vision model without PDF input, should still re-send stale page images', () => {
    const guarded = guardReadPageToolForVision(makeReadPageTool(), { hasVision: true, hasPdfInput: false, hasToolResultMedia: true });
    const result = guarded.toModelOutput!({ toolCallId: '1', input: {}, output: pageImagesOutput }) as { type: string };
    expect(result.type).toBe('content');
    expect(JSON.stringify(result)).toContain('/9j/AAAA');
  });

  it('given a vision model on a provider without tool-result media, should degrade stale page images to metadata', () => {
    const guarded = guardReadPageToolForVision(makeReadPageTool(), { hasVision: true, hasPdfInput: false, hasToolResultMedia: false });
    const result = guarded.toModelOutput!({ toolCallId: '1', input: {}, output: pageImagesOutput }) as { type: string };
    expect(result.type).toBe('json');
    expect(JSON.stringify(result)).not.toContain('/9j/AAAA');
  });

  it('given a model without vision, should degrade stale page images to metadata', () => {
    const guarded = guardReadPageToolForVision(makeReadPageTool(), { hasVision: false, hasPdfInput: false, hasToolResultMedia: true });
    const result = guarded.toModelOutput!({ toolCallId: '1', input: {}, output: pageImagesOutput }) as { type: string };
    expect(result.type).toBe('json');
    expect(JSON.stringify(result)).not.toContain('/9j/AAAA');
  });
});

describe('visualToolResultScreenParts — visual_parts_delivered', () => {
  const asMessage = (output: unknown): UIMessage => ({
    id: 'm1',
    role: 'assistant',
    parts: [{ type: 'tool-read_page', toolCallId: 'c1', state: 'output-available', input: {}, output } as unknown as UIMessage['parts'][number]],
  });

  it('given a client-supplied multi-part result, should screen the bytes of every part', () => {
    const { parts, undecodable } = visualToolResultScreenParts([asMessage(pageImagesOutput), asMessage(pdfPartsOutput)]);
    expect(undecodable).toBe(false);
    expect(parts.map((p) => p.url)).toEqual([
      'data:application/octet-stream;base64,/9j/AAAA',
      'data:application/octet-stream;base64,/9j/BBBB',
      'data:application/octet-stream;base64,JVBERi0xLjQ=',
    ]);
  });

  it('given a part whose bytes are not strict base64, should report it undecodable', () => {
    const bad = { ...pageImagesOutput, parts: [{ kind: 'image', mediaType: 'image/jpeg', data: 'not base64!', pdfPage: 1 }] };
    expect(visualToolResultScreenParts([asMessage(bad)]).undecodable).toBe(true);
  });

  it('given a whole-PDF part of ~13 MB base64, should screen it without overflowing the stack', () => {
    const big = Buffer.alloc(10 * 1024 * 1024, 7).toString('base64');
    const output = { ...pdfPartsOutput, parts: [{ kind: 'file', mediaType: 'application/pdf', data: big, filename: 'big.pdf' }] };
    const { parts, undecodable } = visualToolResultScreenParts([asMessage(output)]);
    expect(undecodable).toBe(false);
    expect(parts).toHaveLength(1);
  });

  it.each([
    ['a length that is not a multiple of 4', 'abcde'],
    ['padding in the middle', 'ab==abcd'],
    ['three padding characters', 'a==='],
    ['a URL-safe character', 'ab-_'],
  ])('given %s, should report it undecodable', (_label, data) => {
    const bad = { ...pageImagesOutput, parts: [{ kind: 'image', mediaType: 'image/jpeg', data, pdfPage: 1 }] };
    expect(visualToolResultScreenParts([asMessage(bad)]).undecodable).toBe(true);
  });

  it('given a part whose data is not a string, should report it undecodable rather than skip it', () => {
    const bad = { ...pageImagesOutput, parts: [{ kind: 'image', mediaType: 'image/jpeg', data: 42, pdfPage: 1 }] };
    expect(visualToolResultScreenParts([asMessage(bad)]).undecodable).toBe(true);
  });
});
