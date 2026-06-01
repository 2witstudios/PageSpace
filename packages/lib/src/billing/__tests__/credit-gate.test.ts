import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsBillingEnabled = vi.hoisted(() => vi.fn(() => true));
const mockDb = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/schema/credits', () => ({
  creditBalances: { userId: 'cb.userId', monthlyRemainingCents: 'cb.monthly', topupRemainingCents: 'cb.topup' },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn((a, b) => ({ op: 'eq', a, b })) }));
vi.mock('../../deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));

import { canConsumeAI } from '../credit-gate';

function selectReturning(rows: unknown[]) {
  return { from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) };
}
function insertChain() {
  return { values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }) };
}

describe('canConsumeAI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBillingEnabled.mockReturnValue(true);
  });

  it('allows unconditionally when billing is disabled (tenant/onprem)', async () => {
    mockIsBillingEnabled.mockReturnValue(false);
    const r = await canConsumeAI('u1', 'free');
    expect(r).toEqual({ allowed: true, reason: 'unlimited' });
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('allows when the user has spendable credits', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 100, topupRemainingCents: 0 }]));
    const r = await canConsumeAI('u1', 'pro');
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
  });

  it('denies with out_of_credits when both buckets are empty', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0 }]));
    const r = await canConsumeAI('u1', 'pro');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('out_of_credits');
  });

  it('lazy-inits a balance row from tier defaults on first request, then allows', async () => {
    // 1st select: no row -> needs_init. 2nd select (post-insert): the persisted row.
    mockDb.select
      .mockReturnValueOnce(selectReturning([]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 1500, topupRemainingCents: 0 }]));
    mockDb.insert.mockReturnValue(insertChain());
    const r = await canConsumeAI('u1', 'pro');
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
  });

  it('re-evaluates against the persisted row after a concurrent init (no false allow)', async () => {
    // 1st select: no row -> needs_init. Our insert hits onConflictDoNothing because a
    // concurrent request already created AND drew down the row to empty. We must judge
    // the persisted balance, not the assumed full allowance -> deny.
    mockDb.select
      .mockReturnValueOnce(selectReturning([]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0 }]));
    mockDb.insert.mockReturnValue(insertChain());
    const r = await canConsumeAI('u1', 'pro');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('out_of_credits');
  });
});
