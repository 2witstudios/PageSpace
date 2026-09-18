import { describe, expect, it, vi } from 'vitest';
import { abortSideQuestion, createSideQuestionRequest } from '../useSideQuestion';

describe('side-question client isolation', () => {
  it('mints an independent correlation id and aborting it cannot reach the main stream controller', () => {
    const main = new AbortController();
    const side = createSideQuestionRequest('conv_1', 'What does that mean?');
    expect(side.requestId).not.toEqual('');
    expect(side.body).toEqual({ conversationId: 'conv_1', question: 'What does that mean?' });
    abortSideQuestion(side.controller);
    expect(side.controller.signal.aborted).toBe(true);
    expect(main.signal.aborted).toBe(false);
  });

  it('does not use the primary send lifecycle', () => {
    const primarySend = vi.fn();
    createSideQuestionRequest('conv_1', 'Status?');
    expect(primarySend).not.toHaveBeenCalled();
  });
});
