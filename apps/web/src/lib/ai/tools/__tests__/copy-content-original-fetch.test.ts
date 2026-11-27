import { describe, it, expect, vi } from 'vitest';
import { fetchOriginalUnderBudget } from '../copy-content-original-fetch';
import { createByteBudget } from '../copy-byte-budget';

const MB = 1024 * 1024;
const BYTES = Uint8Array.from([1, 2, 3]);
const page = (over: Record<string, unknown> = {}) => ({
  id: 'scan',
  title: 'Subaru Exhibits',
  type: 'FILE',
  contentMode: null,
  content: null,
  driveId: 'd1',
  filePath: 'f'.repeat(64),
  fileSize: 72 * MB,
  ...over,
});

function effects(budgetBytes = 512 * MB) {
  const budget = createByteBudget({ capacityBytes: budgetBytes, waitMs: 10 });
  const fetchOriginal = vi.fn(async (_args: { pageId: string; filePath: string; maxBytes: number; deadlineAt: number }) => ({
    success: true as const,
    bytes: BYTES,
  }));
  return { budget, fetchOriginal, maxCopyBytes: 250 * MB, budgetExhaustedMessage: 'busy, retry' };
}

describe('fetchOriginalUnderBudget (review #3016 round 2, E)', () => {
  it('reserves the row\'s size and caps the fetch at EXACTLY that, so an understated row cannot overrun the budget', async () => {
    const e = effects();
    const result = await fetchOriginalUnderBudget({ page: page(), deadlineAt: 99 }, e);
    expect(result.success).toBe(true);
    expect(e.fetchOriginal).toHaveBeenCalledWith({ pageId: 'scan', filePath: 'f'.repeat(64), maxBytes: 72 * MB, deadlineAt: 99 });
    expect(e.budget.inFlightBytes()).toBe(72 * MB);
    if (result.success) result.release();
    expect(e.budget.inFlightBytes()).toBe(0);
  });

  it('a row with no size reserves (and caps at) the most one copy can hold', async () => {
    const e = effects();
    await fetchOriginalUnderBudget({ page: page({ fileSize: null }), deadlineAt: 99 }, e);
    expect(e.fetchOriginal.mock.calls[0][0].maxBytes).toBe(250 * MB);
  });

  it('given the fetch fails, should release the reservation', async () => {
    const e = effects();
    e.fetchOriginal.mockResolvedValueOnce({ success: false, error: 'gone' } as never);
    const result = await fetchOriginalUnderBudget({ page: page(), deadlineAt: 99 }, e);
    expect(result).toMatchObject({ success: false, error: 'gone' });
    expect(e.budget.inFlightBytes()).toBe(0);
  });

  it('given the fetch throws, should release the reservation and rethrow', async () => {
    const e = effects();
    e.fetchOriginal.mockRejectedValueOnce(new Error('boom'));
    await expect(fetchOriginalUnderBudget({ page: page(), deadlineAt: 99 }, e)).rejects.toThrow('boom');
    expect(e.budget.inFlightBytes()).toBe(0);
  });

  it('given the budget has no room, should refuse with the retry message and never fetch', async () => {
    const e = effects(10 * MB);
    const result = await fetchOriginalUnderBudget({ page: page(), deadlineAt: 99 }, e);
    expect(result).toMatchObject({ success: false, error: 'busy, retry', reason: 'copy_budget_exhausted' });
    expect(e.fetchOriginal).not.toHaveBeenCalled();
  });

  it('given a row over the copy cap, should refuse before reserving or fetching', async () => {
    const e = effects();
    const result = await fetchOriginalUnderBudget({ page: page({ fileSize: 300 * MB }), deadlineAt: 99 }, e);
    expect(result.success).toBe(false);
    expect(e.fetchOriginal).not.toHaveBeenCalled();
    expect(e.budget.inFlightBytes()).toBe(0);
  });
});

describe('fetchOriginalUnderBudget — a row that UNDERSTATES the file (round-3 nit)', () => {
  it('tells the agent the file is larger than its RECORDED size, and names the real limit — not the recorded size as if it were a limit', async () => {
    const e = effects();
    e.fetchOriginal.mockResolvedValueOnce({
      success: false,
      error: `The file is larger than the ${72 * MB}-byte limit for one copy. It was not copied partially.`,
      reason: 'over_limit',
    } as never);
    const result = await fetchOriginalUnderBudget({ page: page(), deadlineAt: 99 }, e);
    expect(result.success).toBe(false);
    const error = String((result as { error: string }).error);
    expect(error).toContain(`larger than its recorded size of ${72 * MB} bytes`);
    expect(error).toContain(`${250 * MB} bytes`);
    expect(error).not.toContain(`${72 * MB}-byte limit`);
    expect(e.budget.inFlightBytes()).toBe(0);
  });

  it('a row with NO size was capped at the real limit already, so the plain over-limit message stands', async () => {
    const e = effects();
    const plain = `The file is larger than the ${250 * MB}-byte limit for one copy. It was not copied partially.`;
    e.fetchOriginal.mockResolvedValueOnce({ success: false, error: plain, reason: 'over_limit' } as never);
    const result = await fetchOriginalUnderBudget({ page: page({ fileSize: null }), deadlineAt: 99 }, e);
    expect(result).toMatchObject({ success: false, error: plain });
  });
});
