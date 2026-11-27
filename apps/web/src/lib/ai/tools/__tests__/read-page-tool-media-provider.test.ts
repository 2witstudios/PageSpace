/**
 * End to end through a real provider SDK: a delivered read_page result must never
 * reach a provider that cannot take tool-result media as base64 text.
 * @ai-sdk/openai-compatible (glm, lmstudio, azure_openai) JSON.stringifies a
 * `content` tool output, so the guard has to strip the bytes first.
 */
import { describe, it, expect } from 'vitest';
import { generateText, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { guardReadPageToolForVision, toModelOutputForReadPage } from '../read-page-vision-output';
import { getToolMediaCapabilities } from '../../core/vision-models';

const PAGE_BYTES = Buffer.alloc(300_000, 0xab).toString('base64');

const visualParts = {
  success: true,
  type: 'visual_parts_delivered',
  pageId: 'page-pdf',
  title: 'Exhibits.pdf',
  originalMimeType: 'application/pdf',
  message: 'Showing pages 1-2 of 12 from "Exhibits.pdf" as images.',
  parts: [
    { kind: 'image', mediaType: 'image/jpeg', data: PAGE_BYTES, pdfPage: 1 },
    { kind: 'image', mediaType: 'image/jpeg', data: PAGE_BYTES, pdfPage: 2 },
  ],
  sizeBytes: 600_000,
  metadata: { processingStatus: 'visual' },
};

/** Captures the request body the provider SDK would send. */
async function requestBodyFor(toolOutput: ReturnType<typeof toModelOutputForReadPage>): Promise<string> {
  let body = '';
  const provider = createOpenAICompatible({
    name: 'glm',
    baseURL: 'http://glm.invalid/v1',
    apiKey: 'test',
    fetch: async (_url, init) => {
      body = String(init?.body ?? '');
      return new Response(JSON.stringify({
        id: 'c1', object: 'chat.completion', created: 0, model: 'glm-5.3-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const messages: ModelMessage[] = [
    { role: 'user', content: 'look at the exhibits' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'read_page', input: { title: 'Exhibits.pdf' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'read_page', output: toolOutput }] },
  ];
  await generateText({ model: provider('glm-5.3-flash'), messages });
  return body;
}

describe('read_page media through a provider without tool-result media', () => {
  it('unguarded, the SDK would send the page bytes as base64 text (the evidence)', async () => {
    const body = await requestBodyFor(toModelOutputForReadPage(visualParts));
    expect(body).toContain(PAGE_BYTES.slice(0, 64));
  });

  it('guarded with the provider capability, never serializes base64', async () => {
    const tool = { toModelOutput: ({ output }: { toolCallId: string; input: unknown; output: unknown }) => toModelOutputForReadPage(output) };
    const guarded = guardReadPageToolForVision(tool, getToolMediaCapabilities('glm-5.3-flash', 'glm'));

    const output = await guarded.toModelOutput!({ toolCallId: 't1', input: {}, output: visualParts });
    const body = await requestBodyFor(output);

    expect(body).not.toContain(PAGE_BYTES.slice(0, 64));
    expect(body).toContain('visual_content_metadata');
  });
});
