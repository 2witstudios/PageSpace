// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../page-webhook-trigger-queries', () => ({
  claimTriggerFired: vi.fn(),
  setTriggerError: vi.fn(),
}));

vi.mock('../page-webhook-trigger-executor', () => ({
  executePageWebhookTrigger: vi.fn(),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: {
    PAGE_WEBHOOK_TRIGGER: { maxAttempts: 5 },
    PAGE_WEBHOOK_AI_BUDGET: { maxAttempts: 60 },
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } },
}));

import { claimTriggerFired, setTriggerError } from '../page-webhook-trigger-queries';
import { executePageWebhookTrigger } from '../page-webhook-trigger-executor';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { firePageWebhookTriggers } from '../fire-page-webhook-triggers';

const mockClaim = claimTriggerFired as unknown as ReturnType<typeof vi.fn>;
const mockSetError = setTriggerError as unknown as ReturnType<typeof vi.fn>;
const mockExecute = executePageWebhookTrigger as unknown as ReturnType<typeof vi.fn>;
const mockRateLimit = checkDistributedRateLimit as unknown as ReturnType<typeof vi.fn>;

const envelope = { content: 'deploy finished', meta: { sha: 'abc' } };
const aTrigger = (id: string) => ({ id, workflowId: `wf_${id}`, pageWebhookId: 'wh_1' }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockClaim.mockResolvedValue({ success: true, data: undefined });
  mockSetError.mockResolvedValue({ success: true, data: undefined });
  mockRateLimit.mockResolvedValue({ allowed: true });
});

describe('firePageWebhookTriggers', () => {
  it('does nothing when there are no triggers', async () => {
    await firePageWebhookTriggers([], envelope);
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('executes the workflow and claims the trigger on success', async () => {
    mockExecute.mockResolvedValue({ success: true, durationMs: 1 });

    await firePageWebhookTriggers([aTrigger('t1')], envelope);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), envelope);
    expect(mockClaim).toHaveBeenCalledWith('t1');
    expect(mockSetError).not.toHaveBeenCalled();
  });

  it('records an error when the execution reports failure', async () => {
    mockExecute.mockResolvedValue({ success: false, durationMs: 1, error: 'boom' });

    await firePageWebhookTriggers([aTrigger('t1')], envelope);

    expect(mockSetError).toHaveBeenCalledWith('t1', 'boom');
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('records an error and continues when one execution throws', async () => {
    mockExecute
      .mockRejectedValueOnce(new Error('exploded'))
      .mockResolvedValueOnce({ success: true, durationMs: 1 });

    await firePageWebhookTriggers([aTrigger('t1'), aTrigger('t2')], envelope);

    expect(mockSetError).toHaveBeenCalledWith('t1', 'exploded');
    expect(mockClaim).toHaveBeenCalledWith('t2');
  });

  it('skips a trigger that is rate limited and records rate_limited without executing', async () => {
    mockRateLimit.mockImplementation((key: string) =>
      Promise.resolve({ allowed: !key.startsWith('page-webhook-trigger:') }),
    );

    await firePageWebhookTriggers([aTrigger('t1')], envelope);

    expect(mockRateLimit).toHaveBeenCalledWith('page-webhook-trigger:t1', expect.anything());
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockSetError).toHaveBeenCalledWith('t1', 'rate_limited');
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('isolates a rate-limited trigger from a healthy one in the same delivery', async () => {
    mockRateLimit.mockImplementation((key: string) =>
      Promise.resolve({ allowed: key !== 'page-webhook-trigger:t1' }),
    );
    mockExecute.mockResolvedValue({ success: true, durationMs: 1 });

    await firePageWebhookTriggers([aTrigger('t1'), aTrigger('t2')], envelope);

    expect(mockSetError).toHaveBeenCalledWith('t1', 'rate_limited');
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockClaim).toHaveBeenCalledWith('t2');
  });

  it('consumes the per-WEBHOOK AI budget (keyed by pageWebhookId) BEFORE the per-trigger bucket on every attempted run', async () => {
    mockExecute.mockResolvedValue({ success: true, durationMs: 1 });

    await firePageWebhookTriggers([aTrigger('t1')], envelope);

    expect(mockRateLimit).toHaveBeenCalledWith(
      'page-webhook-ai-budget:wh_1',
      expect.objectContaining({ maxAttempts: 60 }),
    );
    // Budget first: every attempted run draws the shared webhook budget, so
    // the aggregate bound holds even when per-trigger buckets are fresh.
    expect(mockRateLimit.mock.calls[0][0]).toBe('page-webhook-ai-budget:wh_1');
    expect(mockRateLimit.mock.calls[1][0]).toBe('page-webhook-trigger:t1');
    expect(mockClaim).toHaveBeenCalledWith('t1');
  });

  it('bounds AGGREGATE runs: an exhausted webhook AI budget rate-limits every trigger even when each per-trigger bucket is fresh', async () => {
    mockRateLimit.mockImplementation((key: string) =>
      Promise.resolve({ allowed: !key.startsWith('page-webhook-ai-budget:') }),
    );

    await firePageWebhookTriggers([aTrigger('t1'), aTrigger('t2')], envelope);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockSetError).toHaveBeenCalledWith('t1', 'rate_limited');
    expect(mockSetError).toHaveBeenCalledWith('t2', 'rate_limited');
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('still executes (and lets the executor reject) a trigger without a pageWebhookId instead of crashing the budget check', async () => {
    mockExecute.mockResolvedValue({ success: false, durationMs: 1, error: 'Trigger is not anchored to a page webhook' });
    const orphan = { id: 't9', workflowId: 'wf_t9', pageWebhookId: null } as never;

    await firePageWebhookTriggers([orphan], envelope);

    const budgetCalls = mockRateLimit.mock.calls.filter(([key]) =>
      String(key).startsWith('page-webhook-ai-budget:'),
    );
    expect(budgetCalls).toHaveLength(0);
    expect(mockSetError).toHaveBeenCalledWith('t9', 'Trigger is not anchored to a page webhook');
  });

  it('never throws even if the whole fan-out misbehaves', async () => {
    mockExecute.mockResolvedValue({ success: true, durationMs: 1 });
    await expect(
      firePageWebhookTriggers([aTrigger('t1')], envelope),
    ).resolves.toBeUndefined();
  });
});
