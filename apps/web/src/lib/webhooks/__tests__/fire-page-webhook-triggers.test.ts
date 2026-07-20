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
  DISTRIBUTED_RATE_LIMITS: { PAGE_WEBHOOK_TRIGGER: { maxAttempts: 5 } },
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
    mockRateLimit.mockResolvedValue({ allowed: false });

    await firePageWebhookTriggers([aTrigger('t1')], envelope);

    expect(mockRateLimit).toHaveBeenCalledWith('page-webhook-trigger:t1', expect.anything());
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockSetError).toHaveBeenCalledWith('t1', 'rate_limited');
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('isolates a rate-limited trigger from a healthy one in the same delivery', async () => {
    mockRateLimit
      .mockResolvedValueOnce({ allowed: false })
      .mockResolvedValueOnce({ allowed: true });
    mockExecute.mockResolvedValue({ success: true, durationMs: 1 });

    await firePageWebhookTriggers([aTrigger('t1'), aTrigger('t2')], envelope);

    expect(mockSetError).toHaveBeenCalledWith('t1', 'rate_limited');
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockClaim).toHaveBeenCalledWith('t2');
  });

  it('never throws even if the whole fan-out misbehaves', async () => {
    mockExecute.mockResolvedValue({ success: true, durationMs: 1 });
    await expect(
      firePageWebhookTriggers([aTrigger('t1')], envelope),
    ).resolves.toBeUndefined();
  });
});
