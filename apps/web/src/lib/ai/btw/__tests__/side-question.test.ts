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
    expect(snapshot).toContain('Current plan');
    expect(snapshot).not.toContain('must not leak');
    expect(snapshot).not.toContain('partial');
  });

  it('uses a separate abort signal and tool-free model call without persistence hooks', async () => {
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
      prompt: expect.stringContaining('safe context'),
    }));
    expect(streamText.mock.calls[0][0]).not.toHaveProperty('onFinish');
    expect(streamText.mock.calls[0][0]).not.toHaveProperty('onChunk');
  });
});
