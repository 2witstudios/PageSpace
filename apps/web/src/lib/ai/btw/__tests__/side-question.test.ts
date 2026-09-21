import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { buildSideQuestionSnapshot, createSideQuestionStream } from '../side-question';

describe('detached side questions', () => {
  it('snapshots only already-complete transcript/tool results and never writes or starts a primary lifecycle', async () => {
    const readMessages = vi.fn().mockResolvedValue([
      { role: 'user', status: 'complete', content: 'Main question', toolResults: null },
      { role: 'assistant', status: 'complete', content: 'Completed answer', toolResults: [{ output: 'done' }] },
      { role: 'assistant', status: 'streaming', content: 'must not leak', toolResults: [{ output: 'partial' }] },
    ]);
    const snapshot = await buildSideQuestionSnapshot({ conversationId: 'conv_1', readMessages, readPlan: vi.fn().mockResolvedValue('Current plan') });
    expect(snapshot).toContain('Completed answer');
    expect(snapshot).toContain('tool results: [{"output":"done"}]');
    expect(snapshot).toContain('Current plan');
    expect(snapshot).not.toContain('must not leak');
    expect(snapshot).not.toContain('partial');
  });

  it('keeps the newest completed messages and the plan when the transcript overflows the budget', async () => {
    const old = { role: 'user', status: 'complete', content: 'oldest message '.repeat(2000) };
    const newest = { role: 'assistant', status: 'complete', content: 'brand new answer', toolResults: null };
    const filler = (n: number) => ({ role: 'user', status: 'complete', content: `filler ${n} `.repeat(300) });
    const snapshot = await buildSideQuestionSnapshot({
      conversationId: 'conv_1',
      readMessages: vi.fn().mockResolvedValue([old, filler(1), filler(2), filler(3), filler(4), filler(5), filler(6), filler(7), filler(8), filler(9), filler(10), newest]),
      readPlan: vi.fn().mockResolvedValue('Current plan'),
    });
    expect(snapshot.length).toBeLessThanOrEqual(24_000);
    expect(snapshot).toContain('PLAN: Current plan');
    expect(snapshot).toContain('brand new answer');
    expect(snapshot).not.toContain('oldest message');
    expect(snapshot).not.toContain('filler 1 ');
  });

  it('uses a separate abort signal and a tool-free, system-policy model call without persistence hooks', async () => {
    const controller = new AbortController();
    const streamText = vi.fn().mockReturnValue({ toTextStreamResponse: () => new Response('answer') });
    const response = await createSideQuestionStream({
      model: {} as never,
      question: 'What changed?',
      snapshot: 'safe context',
      abortSignal: controller.signal,
      streamText,
    });
    expect(await response.text()).toBe('answer');
    expect(streamText).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: controller.signal,
      tools: undefined,
      system: expect.stringContaining('detached side question'),
      prompt: expect.stringContaining('<conversation_snapshot>\nsafe context\n</conversation_snapshot>'),
    }));
    expect(streamText.mock.calls[0][0].prompt).toContain('<side_question>\nWhat changed?\n</side_question>');
    // No persistence hooks: only the terminal metering callbacks, never a per-chunk writer.
    expect(streamText.mock.calls[0][0]).not.toHaveProperty('onChunk');
    expect(streamText.mock.calls[0][0]).not.toHaveProperty('onStepFinish');
  });

  describe('metering settlement (D-35)', () => {
    const setup = (totalUsage: Promise<unknown> = new Promise(() => {})) => {
      const onSettle = vi.fn().mockResolvedValue(undefined);
      const streamText = vi.fn().mockReturnValue({ totalUsage, toTextStreamResponse: () => new Response('answer') });
      createSideQuestionStream({ model: {} as never, question: 'q', snapshot: 's', abortSignal: new AbortController().signal, streamText, onSettle });
      const args = streamText.mock.calls[0][0] as {
        onFinish: (e: { totalUsage: unknown; steps: unknown[] }) => Promise<void>;
        onAbort: (e: { steps: Array<{ usage: unknown }> }) => Promise<void>;
      };
      return { onSettle, args };
    };

    it('given a finished stream, should settle once with the total usage and success', async () => {
      const { onSettle, args } = setup();
      await args.onFinish({ totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 }, steps: [] });
      expect(onSettle).toHaveBeenCalledTimes(1);
      expect(onSettle).toHaveBeenCalledWith({ success: true, usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 }, steps: [] });
    });

    it('given an aborted stream, should settle with the finished step usage and success false', async () => {
      const { onSettle, args } = setup();
      const steps = [{ usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }];
      await args.onAbort({ steps });
      expect(onSettle).toHaveBeenCalledWith({ success: false, usage: steps[0].usage, steps });
    });

    it('given no output (totalUsage rejects, onFinish never fires), should settle with success false', async () => {
      const { onSettle } = setup(Promise.reject(new Error('No output generated')));
      await vi.waitFor(() => expect(onSettle).toHaveBeenCalledWith({ success: false, usage: undefined, steps: [] }));
    });

    // Against the REAL streamText (mock provider only), so the callback-ordering
    // claim in createSideQuestionStream is tested, not assumed.
    const realModel = (emit: 'text' | 'throw' | 'slow') => new MockLanguageModelV3({
      doStream: async () => {
        if (emit === 'throw') throw new Error('provider down');
        return {
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: 't' });
              if (emit === 'slow') {
                // The provider is still generating (and charging) after the client has gone.
                for (let i = 0; i < 5; i += 1) {
                  await new Promise((r) => setTimeout(r, 20));
                  controller.enqueue({ type: 'text-delta', id: 't', delta: `part${i} ` });
                }
              }
              controller.enqueue({ type: 'text-delta', id: 't', delta: 'answer' });
              controller.enqueue({ type: 'text-end', id: 't' });
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop' as const, raw: 'stop' },
                usage: { inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } },
              });
              controller.close();
            },
          }),
        };
      },
    });

    it('given a real streamText that finishes, should settle once with its token usage', async () => {
      const onSettle = vi.fn().mockResolvedValue(undefined);
      const response = createSideQuestionStream({ model: realModel('text'), question: 'q', snapshot: 's', abortSignal: new AbortController().signal, onSettle });
      expect(await response.text()).toBe('answer');
      await vi.waitFor(() => expect(onSettle).toHaveBeenCalledTimes(1));
      expect(onSettle.mock.calls[0][0]).toMatchObject({ success: true, usage: { inputTokens: 11, outputTokens: 4 } });
    });

    it('given the client disconnects before reading anything, should still run the answer to completion and bill it (no free abort)', async () => {
      const onSettle = vi.fn().mockResolvedValue(undefined);
      const response = createSideQuestionStream({ model: realModel('slow'), question: 'q', snapshot: 's', abortSignal: new AbortController().signal, onSettle });
      await response.body?.cancel();
      await vi.waitFor(() => expect(onSettle).toHaveBeenCalledTimes(1));
      expect(onSettle.mock.calls[0][0]).toMatchObject({ success: true, usage: { inputTokens: 11, outputTokens: 4 } });
    });

    it('given a real streamText whose provider throws, should settle once with success false', async () => {
      const onSettle = vi.fn().mockResolvedValue(undefined);
      const response = createSideQuestionStream({ model: realModel('throw'), question: 'q', snapshot: 's', abortSignal: new AbortController().signal, onSettle });
      await response.text().catch(() => undefined);
      await vi.waitFor(() => expect(onSettle).toHaveBeenCalledTimes(1));
      expect(onSettle.mock.calls[0][0]).toMatchObject({ success: false });
    });

    it('given several terminal callbacks, should settle exactly once (no double charge)', async () => {
      const { onSettle, args } = setup();
      await args.onAbort({ steps: [] });
      await args.onFinish({ totalUsage: { inputTokens: 1 }, steps: [] });
      expect(onSettle).toHaveBeenCalledTimes(1);
    });
  });
});
