/**
 * Locks the tool-approval design against the AI SDK's own resume behaviour.
 *
 * PageSpace mints a NEW assistant message per turn, so the SDK's built-in
 * execute-on-resume (which emits the approved tool's output under the OLD
 * toolCallId into the NEW stream) would strand the result and re-run the tool
 * every later turn. The design therefore has the server execute the approved
 * call itself and persist a RESULT on the original row before the next
 * `streamText`. This test proves, against the real SDK, that once such a row is
 * what history contains, `generateText`/`streamText` never call the tool again —
 * for an executed approval and for a denial alike — and that the sanitizer
 * never lets a responded-without-result part through.
 *
 * If an SDK upgrade changes `collectToolApprovals` or `convertToModelMessages`,
 * this is the test that goes red first.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { convertToModelMessages, generateText, tool, type UIMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { sanitizeMessagesForModel } from '../message-utils';

const textOnlyModel = () =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'done' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });

const trashPage = (execute: ReturnType<typeof vi.fn>) =>
  tool({
    description: 'trash',
    inputSchema: z.object({ pageId: z.string() }),
    needsApproval: true,
    execute,
  });

const history = (toolPart: Record<string, unknown>): UIMessage[] => [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'trash it' }] },
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-trash_page',
        toolCallId: 'tc1',
        toolName: 'trash_page',
        input: { pageId: 'p1' },
        ...toolPart,
      } as unknown as UIMessage['parts'][number],
    ],
  },
];

describe('tool approvals vs the AI SDK resume step', () => {
  it('an approved call the server already executed (output-available + approval) is NOT executed again by the SDK', async () => {
    const execute = vi.fn(async () => ({ trashed: true }));
    const rows = history({ state: 'output-available', output: { trashed: true }, approval: { id: 'ap1', approved: true } });

    const sanitized = sanitizeMessagesForModel(rows);
    expect(sanitized[1].parts.map((p) => (p as { state?: string }).state)).toEqual(['output-available']);

    const messages = await convertToModelMessages(sanitized);
    const toolMessage = messages.find((m) => m.role === 'tool');
    expect(toolMessage).toBeTruthy();
    expect((toolMessage!.content as Array<{ type: string }>).some((p) => p.type === 'tool-result')).toBe(true);

    await generateText({ model: textOnlyModel(), messages, tools: { trash_page: trashPage(execute) } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('a denied call (output-denied) reaches the model as a tool-result and is never executed', async () => {
    const execute = vi.fn(async () => ({ trashed: true }));
    const rows = history({ state: 'output-denied', approval: { id: 'ap1', approved: false, reason: 'keep it' } });

    const sanitized = sanitizeMessagesForModel(rows);
    expect(sanitized[1].parts.map((p) => (p as { state?: string }).state)).toEqual(['output-denied']);

    const messages = await convertToModelMessages(sanitized);
    const toolMessage = messages.find((m) => m.role === 'tool');
    const result = (toolMessage!.content as Array<{ type: string; output?: { type: string; value?: unknown } }>).find((p) => p.type === 'tool-result');
    expect(result).toBeTruthy();
    expect(JSON.stringify(result!.output)).toContain('keep it');

    await generateText({ model: textOnlyModel(), messages, tools: { trash_page: trashPage(execute) } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('the shape that WOULD trigger the SDK resume step — approval-responded with no result — never survives the sanitizer', () => {
    const rows = history({ state: 'approval-responded', approval: { id: 'ap1', approved: true } });
    const sanitized = sanitizeMessagesForModel(rows);
    expect(sanitized[1].parts).toEqual([]);
  });

  it('control: the SDK DOES execute an approved-without-result part (why the sanitizer and the server-side execution exist)', async () => {
    // Bypass the sanitizer on purpose: this is the trap, demonstrated.
    const execute = vi.fn(async () => ({ trashed: true }));
    const messages = await convertToModelMessages(history({ state: 'approval-responded', approval: { id: 'ap1', approved: true } }));
    await generateText({ model: textOnlyModel(), messages, tools: { trash_page: trashPage(execute) } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
