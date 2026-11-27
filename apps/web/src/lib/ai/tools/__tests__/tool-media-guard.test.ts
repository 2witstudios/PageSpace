import { describe, it, expect } from 'vitest';
import type { Tool } from 'ai';
import { guardToolResultMedia } from '../tool-media-guard';
import { toModelOutputForReadPage } from '../read-page-vision-output';
import { toModelOutputForBrowserScreenshot } from '../browser-tools';

const SHOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const screenshot = { success: true, page: { url: 'https://example.com', title: 'Example' }, mediaType: 'image/png', imageBase64: SHOT };
const pageImage = {
  success: true, type: 'visual_content_delivered', pageId: 'p1', title: 'diagram.png', mimeType: 'image/jpeg',
  originalMimeType: 'image/png', message: 'Delivered', imageBase64: SHOT, sizeBytes: 10, metadata: {},
};

const tools = (): Record<string, Tool> => ({
  read_page: { toModelOutput: ({ output }: { output: unknown }) => toModelOutputForReadPage(output) } as unknown as Tool,
  browser_screenshot: { toModelOutput: ({ output }: { output: unknown }) => toModelOutputForBrowserScreenshot(output) } as unknown as Tool,
  list_pages: { description: 'untouched' } as unknown as Tool,
});

const replay = async (tool: Tool, output: unknown) =>
  JSON.stringify(await tool.toModelOutput!({ toolCallId: 't', input: {}, output } as never));

describe('guardToolResultMedia', () => {
  const noMedia = { hasVision: true, hasPdfInput: false, hasToolResultMedia: false };
  const noVision = { hasVision: false, hasPdfInput: false, hasToolResultMedia: true };
  const full = { hasVision: true, hasPdfInput: true, hasToolResultMedia: true };

  for (const [label, caps] of [['a provider without tool-result media', noMedia], ['a model without vision', noVision]] as const) {
    it(`never replays a saved screenshot as base64 for ${label}`, async () => {
      const guarded = guardToolResultMedia(tools(), caps);
      const sent = await replay(guarded.browser_screenshot, screenshot);
      expect(sent).not.toContain(SHOT);
      expect(sent).toMatch(/screenshot/i);
    });

    it(`never replays a saved read_page image as base64 for ${label}`, async () => {
      const guarded = guardToolResultMedia(tools(), caps);
      expect(await replay(guarded.read_page, pageImage)).not.toContain(SHOT);
    });
  }

  it('replays both as images when the model and provider take tool-result media', async () => {
    const guarded = guardToolResultMedia(tools(), full);
    expect(await replay(guarded.browser_screenshot, screenshot)).toContain('image-data');
    expect(await replay(guarded.read_page, pageImage)).toContain('image-data');
  });

  it('leaves other tools and absent media tools alone', () => {
    const set = tools();
    const guarded = guardToolResultMedia(set, noMedia);
    expect(guarded.list_pages).toBe(set.list_pages);
    expect(guardToolResultMedia({ list_pages: set.list_pages }, noMedia)).toEqual({ list_pages: set.list_pages });
  });
});
