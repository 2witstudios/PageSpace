import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockWhere, mockCanConsumeAI } = vi.hoisted(() => ({
  mockWhere: vi.fn(),
  mockCanConsumeAI: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: mockWhere }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: (...args: unknown[]) => mockCanConsumeAI(...args),
}));
vi.mock('@pagespace/lib/billing/credit-pricing', () => ({
  CREDIT_HOLD_ESTIMATE_CENTS: 5,
  MAX_CHAT_INFLIGHT: 8,
}));

import { acquireWorkflowCredit, type WorkflowCreditInput } from '../workflow-credit-gate';

const input = (overrides: Partial<WorkflowCreditInput> = {}): WorkflowCreditInput => ({
  createdBy: 'agent_user',
  agentPageId: 'agent_page',
  prompt: 'p',
  steps: null,
  source: { table: 'cron' },
  ...overrides,
});

describe('acquireWorkflowCredit', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWhere.mockResolvedValue([{ subscriptionTier: 'pro' }]);
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold_9' });
  });

  it('given an unclaimed agent the gate refuses, should refuse with requires_funding', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'requires_funding' });

    expect(await acquireWorkflowCredit(input())).toEqual({
      allowed: false,
      error: 'AI credit gate denied: requires_funding',
    });
  });

  it('given a legacy scheduled run, should gate createdBy at their tier with a one-step hold', async () => {
    expect(await acquireWorkflowCredit(input())).toEqual({ allowed: true, holdId: 'hold_9' });
    expect(mockCanConsumeAI).toHaveBeenCalledWith('agent_user', 'pro', { estCostCents: 5 });
  });

  it('given a manual chain with two ai steps and a caller policy, should size the hold and cap concurrency', async () => {
    await acquireWorkflowCredit(
      input({
        source: { table: 'manual' },
        steps: [
          { kind: 'ai', prompt: 'a' },
          { kind: 'tool', toolName: 'insert_content', args: {} },
          { kind: 'ai', prompt: 'b' },
        ],
        creditGate: { dailyCapCeilingCents: 500 },
      }),
    );
    expect(mockCanConsumeAI).toHaveBeenCalledWith('agent_user', 'pro', {
      estCostCents: 10,
      maxInFlight: 8,
      dailyCapCeilingCents: 500,
    });
  });

  it('given a user row with no tier, should gate at the free tier', async () => {
    mockWhere.mockResolvedValue([]);
    await acquireWorkflowCredit(input());
    expect(mockCanConsumeAI).toHaveBeenCalledWith('agent_user', 'free', { estCostCents: 5 });
  });

  it('given a deterministic-only chain, should allow without touching the gate', async () => {
    expect(
      await acquireWorkflowCredit(
        input({ agentPageId: null, steps: [{ kind: 'tool', toolName: 'insert_content', args: {} }] }),
      ),
    ).toEqual({ allowed: true });
    expect(mockCanConsumeAI).not.toHaveBeenCalled();
  });
});
