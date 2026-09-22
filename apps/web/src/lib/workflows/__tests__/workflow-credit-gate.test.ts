import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkflowStep } from '@pagespace/db/schema/workflows';

const {
  mockSelect,
  mockSelectFrom,
  mockSelectWhere,
  mockCanConsumeAI,
  mockReleaseHold,
  mockInsert,
  mockInsertValues,
} = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockInsertValues: vi.fn(),
  mockSelect: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockCanConsumeAI: vi.fn(),
  mockReleaseHold: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({ db: { select: mockSelect, insert: mockInsert } }));
vi.mock('@pagespace/db/schema/workflow-runs', () => ({ workflowRuns: { id: 'id' } }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: mockCanConsumeAI }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: mockReleaseHold }));
vi.mock('@pagespace/lib/billing/credit-pricing', () => ({
  CREDIT_HOLD_ESTIMATE_CENTS: 10,
  MAX_CHAT_INFLIGHT: 3,
}));

import { acquireWorkflowCreditHold, creditDeniedError, recordCreditSkippedRun } from '../workflow-credit-gate';

const LEGACY_AI_WORKFLOW = { createdBy: 'user_1', steps: null, prompt: 'Summarize', agentPageId: 'agent_1' };

describe('acquireWorkflowCreditHold', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockResolvedValue([{ subscriptionTier: 'pro' }]);
    mockReleaseHold.mockResolvedValue(undefined);
  });

  it('gates the billed user at their tier before any model runs', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold_1' });

    const hold = await acquireWorkflowCreditHold(LEGACY_AI_WORKFLOW, 'scheduled');

    expect(hold.allowed).toBe(true);
    expect(mockCanConsumeAI).toHaveBeenCalledTimes(1);
    expect(mockCanConsumeAI.mock.calls[0][0]).toBe('user_1');
    expect(mockCanConsumeAI.mock.calls[0][1]).toBe('pro');
  });

  it('falls back to the free tier when the user row is missing', async () => {
    mockSelectWhere.mockResolvedValue([]);
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok' });

    await acquireWorkflowCreditHold(LEGACY_AI_WORKFLOW, 'scheduled');

    expect(mockCanConsumeAI.mock.calls[0][1]).toBe('free');
  });

  it('returns the denial reason and takes no hold when the user cannot consume', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });

    const hold = await acquireWorkflowCreditHold(LEGACY_AI_WORKFLOW, 'scheduled');

    expect(hold).toEqual({ allowed: false, reason: 'out_of_credits' });
  });

  it('sizes the reservation by the number of ai steps in the chain', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok' });
    const steps: WorkflowStep[] = [
      { kind: 'ai', prompt: 'a' },
      { kind: 'tool', toolName: 'send_channel_message', args: {} },
      { kind: 'ai', prompt: 'b' },
    ];

    await acquireWorkflowCreditHold({ createdBy: 'user_1', steps, prompt: '', agentPageId: null }, 'scheduled');

    expect(mockCanConsumeAI.mock.calls[0][2].estCostCents).toBe(20);
  });

  it('scheduled runs skip the interactive daily cap and the in-flight cap', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok' });

    await acquireWorkflowCreditHold(LEGACY_AI_WORKFLOW, 'scheduled');

    expect(mockCanConsumeAI.mock.calls[0][2]).toEqual({ estCostCents: 10, skipDailyCap: true });
  });

  it('manual runs keep the daily cap and pass the interactive in-flight cap', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok' });

    await acquireWorkflowCreditHold(LEGACY_AI_WORKFLOW, 'interactive');

    expect(mockCanConsumeAI.mock.calls[0][2]).toEqual({ estCostCents: 10, maxInFlight: 3 });
  });

  it('a deterministic-only chain runs no model, so it takes no gate and no hold', async () => {
    const steps: WorkflowStep[] = [{ kind: 'tool', toolName: 'send_channel_message', args: {} }];

    const hold = await acquireWorkflowCreditHold({ createdBy: 'user_1', steps, prompt: '', agentPageId: null }, 'scheduled');

    expect(hold.allowed).toBe(true);
    expect(mockCanConsumeAI).not.toHaveBeenCalled();
    if (hold.allowed) hold.release();
    expect(mockReleaseHold).not.toHaveBeenCalled();
  });

  it('release frees the hold exactly once however often it is called', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold_1' });

    const hold = await acquireWorkflowCreditHold(LEGACY_AI_WORKFLOW, 'scheduled');
    if (!hold.allowed) throw new Error('expected an allowed hold');
    hold.release();
    hold.release();

    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
    expect(mockReleaseHold).toHaveBeenCalledWith('hold_1');
  });

  it('release is a no-op when the gate allowed without a hold row (billing off)', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'unlimited' });

    const hold = await acquireWorkflowCreditHold(LEGACY_AI_WORKFLOW, 'scheduled');
    if (!hold.allowed) throw new Error('expected an allowed hold');
    hold.release();

    expect(mockReleaseHold).not.toHaveBeenCalled();
  });

  it('a failed release never throws into the caller', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold_1' });
    mockReleaseHold.mockRejectedValue(new Error('db down'));

    const hold = await acquireWorkflowCreditHold(LEGACY_AI_WORKFLOW, 'scheduled');
    if (!hold.allowed) throw new Error('expected an allowed hold');

    expect(() => hold.release()).not.toThrow();
    await Promise.resolve();
  });
});

describe('creditDeniedError', () => {
  it('names the gate and the reason, matching the trigger executors', () => {
    expect(creditDeniedError('out_of_credits')).toBe('AI credit gate denied: out_of_credits');
  });
});

describe('recordCreditSkippedRun', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockResolvedValue(undefined);
  });

  it('writes a terminal cancelled run carrying the denial, so run history shows the skip', async () => {
    const triggerAt = new Date('2025-01-01T09:00:00Z');

    await recordCreditSkippedRun({
      workflowId: 'wf_1',
      source: { table: 'taskTriggers', id: 'trig_1', triggerAt },
      reason: 'out_of_credits',
    });

    expect(mockInsertValues).toHaveBeenCalledWith({
      workflowId: 'wf_1',
      sourceTable: 'taskTriggers',
      sourceId: 'trig_1',
      triggerAt,
      status: 'cancelled',
      endedAt: expect.any(Date),
      durationMs: 0,
      error: 'AI credit gate denied: out_of_credits',
    });
  });
});
