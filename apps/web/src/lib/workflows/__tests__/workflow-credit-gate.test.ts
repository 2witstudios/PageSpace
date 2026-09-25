import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkflowStep } from '@pagespace/db/schema/workflows';

const {
  mockSelect,
  mockSelectFrom,
  mockSelectWhere,
  mockCanConsumeAI,
  mockReleaseHold,
} = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockCanConsumeAI: vi.fn(),
  mockReleaseHold: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({ db: { select: mockSelect } }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: mockCanConsumeAI }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: mockReleaseHold }));
vi.mock('@pagespace/lib/billing/credit-pricing', () => ({
  CREDIT_HOLD_ESTIMATE_CENTS: 10,
  MAX_CHAT_INFLIGHT: 3,
}));

import { acquireWorkflowCreditHold, creditAdmission, creditDeniedError } from '../workflow-credit-gate';

// Northwind's weekly digest: Marcus (user_1) created it in Product; its runs spend Product's wallet (SPEND-6).
const LEGACY_AI_WORKFLOW = { driveId: 'drive_product', createdBy: 'user_1', steps: null, prompt: 'Summarize', agentPageId: 'agent_1' };
const PRODUCT_AUTOMATION = { kind: 'automation', driveId: 'drive_product' };

describe('acquireWorkflowCreditHold', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockResolvedValue([{ subscriptionTier: 'pro' }]);
    mockReleaseHold.mockResolvedValue(undefined);
  });

  it('SPEND-6 (partial) a workflow run names its drive as the consumer, never the person who created it', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold_1', walletId: 'w_product' });

    await acquireWorkflowCreditHold(LEGACY_AI_WORKFLOW, 'scheduled');
    await acquireWorkflowCreditHold(LEGACY_AI_WORKFLOW, 'interactive');

    expect(mockCanConsumeAI.mock.calls.map((call) => call[2].spend)).toEqual([PRODUCT_AUTOMATION, PRODUCT_AUTOMATION]);
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

    await acquireWorkflowCreditHold({ driveId: 'drive_product', createdBy: 'user_1', steps, prompt: '', agentPageId: null }, 'scheduled');

    expect(mockCanConsumeAI.mock.calls[0][2].estCostCents).toBe(20);
  });

  it('scheduled runs skip the interactive daily cap and the in-flight cap', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok' });

    await acquireWorkflowCreditHold(LEGACY_AI_WORKFLOW, 'scheduled');

    expect(mockCanConsumeAI.mock.calls[0][2]).toEqual({ spend: PRODUCT_AUTOMATION, estCostCents: 10, skipDailyCap: true });
  });

  it('manual runs keep the daily cap and pass the interactive in-flight cap', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok' });

    await acquireWorkflowCreditHold(LEGACY_AI_WORKFLOW, 'interactive');

    expect(mockCanConsumeAI.mock.calls[0][2]).toEqual({ spend: PRODUCT_AUTOMATION, estCostCents: 10, maxInFlight: 3 });
  });

  it('a deterministic-only chain runs no model, so it takes no gate and no hold', async () => {
    const steps: WorkflowStep[] = [{ kind: 'tool', toolName: 'send_channel_message', args: {} }];

    const hold = await acquireWorkflowCreditHold({ driveId: 'drive_product', createdBy: 'user_1', steps, prompt: '', agentPageId: null }, 'scheduled');

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

  it('SPEND-6 (partial) a skipped run names why the drive wallet could not pay', () => {
    expect(creditDeniedError('source_refused', { source: 'drive_wallet', reason: 'drive_wallet_empty', options: [] }))
      .toBe('AI credit gate denied: source_refused (drive_wallet_empty)');
  });
});

describe('creditAdmission', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockResolvedValue([{ subscriptionTier: 'pro' }]);
    mockReleaseHold.mockResolvedValue(undefined);
  });

  it('gates nothing until the executor calls it (inside the run claim)', () => {
    creditAdmission(LEGACY_AI_WORKFLOW, 'scheduled');

    expect(mockCanConsumeAI).not.toHaveBeenCalled();
  });

  it('admits with a release that frees the hold', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold_1' });

    const admission = await creditAdmission(LEGACY_AI_WORKFLOW, 'scheduled')();
    if (!admission.admitted) throw new Error('expected admission');
    admission.release();

    expect(mockReleaseHold).toHaveBeenCalledWith('hold_1');
  });

  it('SPEND-6 (partial) an admitted run carries the wallet the gate reserved on, so the run settles on the drive wallet', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold_1', walletId: 'w_product' });

    const admission = await creditAdmission(LEGACY_AI_WORKFLOW, 'scheduled')();

    expect(admission).toMatchObject({ admitted: true, creditSpend: { spend: PRODUCT_AUTOMATION, walletId: 'w_product' } });
  });

  it('SPEND-6 (partial) an empty drive wallet refuses the run as a skip naming the wallet reason; the person is never gated instead', async () => {
    mockCanConsumeAI.mockResolvedValue({
      allowed: false,
      reason: 'source_refused',
      refusal: { source: 'drive_wallet', reason: 'drive_wallet_empty', options: [] },
    });
    const onDenied = vi.fn();

    const admission = await creditAdmission(LEGACY_AI_WORKFLOW, 'scheduled', onDenied)();

    expect(admission).toEqual({ admitted: false, error: 'AI credit gate denied: source_refused (drive_wallet_empty)' });
    expect(onDenied).toHaveBeenCalledWith('source_refused');
    expect(mockCanConsumeAI).toHaveBeenCalledTimes(1);
    expect(mockCanConsumeAI.mock.calls[0][2].spend).toEqual(PRODUCT_AUTOMATION);
  });

  it('refuses with the reason as the run error and hands the raw reason to onDenied', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });
    const onDenied = vi.fn();

    const admission = await creditAdmission(LEGACY_AI_WORKFLOW, 'interactive', onDenied)();

    expect(admission).toEqual({ admitted: false, error: 'AI credit gate denied: out_of_credits' });
    expect(onDenied).toHaveBeenCalledWith('out_of_credits');
  });
});
