import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

/**
 * The memory steps' credit gate. Every nightly model call runs inside it, so it
 * has to refuse in each way a pass must not run — no memory tier, no credit, an
 * unanswerable gate — without ever calling `run`, and release the hold exactly
 * once when it does run.
 */

const { tierRows, canConsumeAI, releaseHold } = vi.hoisted(() => ({
  tierRows: { value: [] as Array<{ subscriptionTier: string }> },
  canConsumeAI: vi.fn(),
  releaseHold: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => tierRows.value }) }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold }));
vi.mock('@pagespace/lib/billing/credit-pricing', () => ({ CREDIT_HOLD_ESTIMATE_CENTS: 25 }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { withMemoryCreditHold } from '../memory-credit-gate';

describe('withMemoryCreditHold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tierRows.value = [{ subscriptionTier: 'pro' }];
    canConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-1' });
    releaseHold.mockResolvedValue(undefined);
  });

  it('refuses a tier without Memory before consulting the credit gate', async () => {
    tierRows.value = [{ subscriptionTier: 'free' }];
    const run = vi.fn(async () => 'ran');

    const result = await withMemoryCreditHold('user-free', 3, run);

    assert({
      given: 'a free-tier user, whatever their balance',
      should: 'refuse as tier_not_eligible without running or gating',
      actual: { result, runs: run.mock.calls.length, gates: canConsumeAI.mock.calls.length },
      expected: { result: { ran: false, reason: 'tier_not_eligible' }, runs: 0, gates: 0 },
    });
  });

  it('refuses with the gate reason when the balance cannot cover the step', async () => {
    canConsumeAI.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });
    const run = vi.fn(async () => 'ran');

    const result = await withMemoryCreditHold('user-in-debt', 3, run);

    assert({
      given: 'a pro user the credit gate refuses',
      should: 'return the refusal and never run the step',
      actual: { result, runs: run.mock.calls.length, releases: releaseHold.mock.calls.length },
      expected: { result: { ran: false, reason: 'out_of_credits' }, runs: 0, releases: 0 },
    });
  });

  it('refuses as gate_error when the gate throws, instead of failing the pass', async () => {
    canConsumeAI.mockRejectedValue(new Error('lock timeout'));
    const run = vi.fn(async () => 'ran');

    const result = await withMemoryCreditHold('user-1', 1, run);

    assert({
      given: 'a gate that cannot be evaluated',
      should: 'treat it as a refusal and never run the step',
      actual: { result, runs: run.mock.calls.length },
      expected: { result: { ran: false, reason: 'gate_error' }, runs: 0 },
    });
  });

  it('reserves per model call, as scheduled work outside the interactive daily cap', async () => {
    await withMemoryCreditHold('user-1', 3, async () => 'ran');

    assert({
      given: 'a three-call step',
      should: 'ask the gate for three calls of headroom with the daily cap skipped',
      actual: canConsumeAI.mock.calls[0],
      expected: ['user-1', 'pro', { estCostCents: 75, skipDailyCap: true }],
    });
  });

  it('runs the step and releases the hold exactly once, after it settles', async () => {
    const order: string[] = [];
    releaseHold.mockImplementation(async () => {
      order.push('release');
    });

    const result = await withMemoryCreditHold('user-1', 1, async () => {
      order.push('run');
      return 'value';
    });

    assert({
      given: 'an admitted step',
      should: 'return its value and release its hold once, after the run',
      actual: { result, order, released: releaseHold.mock.calls },
      expected: { result: { ran: true, value: 'value' }, order: ['run', 'release'], released: [['hold-1']] },
    });
  });

  it('releases the hold when the step throws', async () => {
    const error = await withMemoryCreditHold('user-1', 1, async () => {
      throw new Error('boom');
    }).catch((e: unknown) => e);

    assert({
      given: 'an admitted step that throws',
      should: 'propagate the error and still release the hold',
      actual: { message: (error as Error).message, released: releaseHold.mock.calls },
      expected: { message: 'boom', released: [['hold-1']] },
    });
  });
});
