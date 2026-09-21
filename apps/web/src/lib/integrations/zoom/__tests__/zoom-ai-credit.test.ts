import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockWhere, mockCanConsumeAI, mockReleaseHold } = vi.hoisted(() => ({
  mockWhere: vi.fn(),
  mockCanConsumeAI: vi.fn(),
  mockReleaseHold: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: mockWhere }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: (...args: unknown[]) => mockCanConsumeAI(...args),
}));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({
  releaseHold: (...args: unknown[]) => mockReleaseHold(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { withZoomAiCredit, ZOOM_AI_TRANSIENT_RETRY_DELAYS_MS } from '../zoom-ai-credit';

describe('withZoomAiCredit', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWhere.mockResolvedValue([{ subscriptionTier: 'pro' }]);
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold_z' });
    mockReleaseHold.mockResolvedValue(undefined);
  });

  it('given the connection owner is refused (an unclaimed agent), should return the fallback without running the model call', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'requires_funding' });
    const run = vi.fn(async () => 'summary');

    expect(await withZoomAiCredit('agent_1', 'zoom_summary', run, '')).toBe('');
    expect(run).not.toHaveBeenCalled();
    expect(mockReleaseHold).not.toHaveBeenCalled();
  });

  it('given a terminal refusal, should not retry the gate', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });

    expect(await withZoomAiCredit('user_1', 'zoom_summary', vi.fn(async () => 'summary'), '')).toBe('');
    expect(mockCanConsumeAI).toHaveBeenCalledTimes(1);
  });

  describe('transient refusal (a free owner already at the in-flight cap when the transcript lands)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('given the cap clears before a retry, should wait, re-gate and still enrich the transcript', async () => {
      mockCanConsumeAI
        .mockResolvedValueOnce({ allowed: false, reason: 'too_many_in_flight' })
        .mockResolvedValueOnce({ allowed: true, reason: 'ok', holdId: 'hold_retry' });
      const run = vi.fn(async () => 'summary');

      const pending = withZoomAiCredit('user_1', 'zoom_summary', run, '');
      await vi.advanceTimersByTimeAsync(ZOOM_AI_TRANSIENT_RETRY_DELAYS_MS[0] - 1);
      expect(mockCanConsumeAI).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toBe('summary');
      expect(mockCanConsumeAI).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenCalledTimes(1);
      expect(mockReleaseHold).toHaveBeenCalledWith('hold_retry');
    });

    it('given the cap never clears, should re-gate once per scheduled delay, then fall back without running the model', async () => {
      mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'too_many_in_flight' });
      const run = vi.fn(async () => 'summary');

      const pending = withZoomAiCredit('user_1', 'zoom_summary', run, '');
      await vi.runAllTimersAsync();

      expect(await pending).toBe('');
      expect(mockCanConsumeAI).toHaveBeenCalledTimes(1 + ZOOM_AI_TRANSIENT_RETRY_DELAYS_MS.length);
      expect(run).not.toHaveBeenCalled();
    });
  });

  it('given an allowed gate, should gate the owner at their tier without the daily cap, run, and release the hold', async () => {
    const run = vi.fn(async () => 'summary');

    expect(await withZoomAiCredit('user_1', 'zoom_summary', run, '')).toBe('summary');
    expect(mockCanConsumeAI).toHaveBeenCalledWith('user_1', 'pro', { skipDailyCap: true });
    expect(mockReleaseHold).toHaveBeenCalledWith('hold_z');
  });

  it('given the model call throws, should still release the hold and rethrow', async () => {
    const run = vi.fn(async () => {
      throw new Error('provider down');
    });

    await expect(withZoomAiCredit('user_1', 'zoom_summary', run, '')).rejects.toThrow('provider down');
    expect(mockReleaseHold).toHaveBeenCalledWith('hold_z');
  });

  it('given a user row with no tier, should gate at the free tier', async () => {
    mockWhere.mockResolvedValue([]);
    await withZoomAiCredit('user_1', 'zoom_summary', vi.fn(async () => 'x'), '');
    expect(mockCanConsumeAI).toHaveBeenCalledWith('user_1', 'free', { skipDailyCap: true });
  });
});
