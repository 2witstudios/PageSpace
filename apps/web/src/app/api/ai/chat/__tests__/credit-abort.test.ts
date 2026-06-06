import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCalcStep, mockShouldAbort } = vi.hoisted(() => ({
  mockCalcStep: vi.fn<() => number>(),
  mockShouldAbort: vi.fn<() => boolean>(),
}));

vi.mock('@pagespace/lib/monitoring/chat-pricing', () => ({
  estimateChatHoldCentsForModel: vi.fn(),
  calcStepCostDollars: mockCalcStep,
  shouldAbortAfterStep: mockShouldAbort,
}));

vi.mock('@pagespace/lib/billing/credit-pricing', () => ({
  MAX_CHAT_INFLIGHT: 8,
  MARKUP_BPS: 15000,
  RESERVE_FLOOR_CENTS: 25,
}));

import { makeOnStepFinishHandler } from '../step-finish-handler';

beforeEach(() => vi.clearAllMocks());

describe('makeOnStepFinishHandler', () => {
  it('does NOT abort when accumulated cost stays within the balance', () => {
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, 'abort');

    mockCalcStep.mockReturnValue(0.001);
    mockShouldAbort.mockReturnValue(false);

    const handler = makeOnStepFinishHandler(controller, 1000, 'test-model');
    handler({ inputTokens: 100, outputTokens: 50 });
    handler({ inputTokens: 100, outputTokens: 50 });
    handler({ inputTokens: 100, outputTokens: 50 });

    expect(abortSpy).not.toHaveBeenCalled();
  });

  it('aborts exactly once when shouldAbortAfterStep returns true', () => {
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, 'abort');

    mockCalcStep.mockReturnValue(0.01);
    mockShouldAbort
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);

    const handler = makeOnStepFinishHandler(controller, 100, 'test-model');
    handler({ inputTokens: 500, outputTokens: 200 });
    handler({ inputTokens: 500, outputTokens: 200 });
    handler({ inputTokens: 500, outputTokens: 200 }); // triggers abort

    expect(abortSpy).toHaveBeenCalled();
  });

  it('accumulates cost across steps before passing to shouldAbortAfterStep', () => {
    const controller = new AbortController();
    mockCalcStep.mockReturnValue(0.05);
    mockShouldAbort.mockReturnValue(false);

    const handler = makeOnStepFinishHandler(controller, 500, 'gpt-model');
    handler({ inputTokens: 100, outputTokens: 50 });
    handler({ inputTokens: 200, outputTokens: 100 });

    expect(mockShouldAbort).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cumulativeCostDollars: 0.10,
    }));
  });

  it('passes the correct balanceCents and model to the underlying helpers', () => {
    const controller = new AbortController();
    mockCalcStep.mockReturnValue(0.01);
    mockShouldAbort.mockReturnValue(false);

    const handler = makeOnStepFinishHandler(controller, 300, 'anthropic/claude-opus-4.8');
    handler({ inputTokens: 100, outputTokens: 50 });

    expect(mockCalcStep).toHaveBeenCalledWith('anthropic/claude-opus-4.8', { inputTokens: 100, outputTokens: 50 });
    expect(mockShouldAbort).toHaveBeenCalledWith(expect.objectContaining({
      balanceCents: 300,
      markupBps: 15000,
      reserveFloorCents: 25,
    }));
  });
});

describe('creditAbortController null path', () => {
  it('abort is never called when no handler is created (billing disabled)', () => {
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, 'abort');

    const noop = null as ReturnType<typeof makeOnStepFinishHandler> | null;
    if (noop) noop({ inputTokens: 100, outputTokens: 50 });

    expect(abortSpy).not.toHaveBeenCalled();
  });
});
