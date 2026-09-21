import { describe, expect, it, vi } from 'vitest';
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
      onSettle: vi.fn().mockResolvedValue(undefined),
      estimateTokens: () => 1,
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
  });

  // Callback ORDER is pinned against the real SDK in side-question.real-sdk.test.ts;
  // this covers the one branch a single tool-free step cannot reach there.
  it('an abort after completed steps bills their summed usage, and later callbacks never bill again', async () => {
    const streamText = vi.fn().mockReturnValue({ toTextStreamResponse: () => new Response('answer'), steps: new Promise(() => {}) });
    const onSettle = vi.fn().mockResolvedValue(undefined);
    createSideQuestionStream({ model: {} as never, question: 'q', snapshot: 's', abortSignal: new AbortController().signal, onSettle, estimateTokens: () => 1, streamText });
    const options = streamText.mock.calls[0][0];
    const step = { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };

    await options.onAbort({ steps: [step, step] });
    await options.onFinish({ totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, steps: [] });
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledWith({ outcome: 'aborted', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, estimated: false, steps: [step, step] });
  });
});
