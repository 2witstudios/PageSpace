/**
 * getOwnCreditsBalance — the credit balance a person sees for "own credits"
 * (ADR 0008 Decision 8, owner pays). A claimed agent's own credits ARE its
 * owner's, so the balance surfaces read the payer the gate charges — named by
 * the one seam, resolveOwnCreditsPayer — and say whom it is billed to. A human
 * and an unclaimed agent read their own wallet, as before.
 */
import { describe, it, expect, vi } from 'vitest';

// The real reads are injected below; these only keep the module graph off a database.
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));
vi.mock('../../auth/user-repository', () => ({ decryptUserRow: vi.fn() }));
vi.mock('../agent-billing-owner', () => ({ resolveOwnCreditsPayer: vi.fn() }));
vi.mock('../credit-balance', () => ({ getCreditBalance: vi.fn() }));
import { getOwnCreditsBalance, type OwnCreditsBalanceDeps } from '../own-credits-balance';
import type { CreditBalanceSummary } from '../credit-balance';

const summaryFor = (spendable: number): CreditBalanceSummary => ({
  billingEnabled: true,
  monthly: { remaining: spendable, allowance: 1000, periodEnd: null },
  topup: { remaining: 0 },
  debt: 0,
  spendable,
  reserved: 0,
});

function deps(overrides: Partial<OwnCreditsBalanceDeps> = {}): OwnCreditsBalanceDeps {
  return {
    resolvePayer: vi.fn(async ({ userId, tier }) => ({ payerId: userId, tier, viaAgentOwner: false })),
    readBalance: vi.fn(async (userId: string) => summaryFor(userId === 'owner-1' ? 900 : 0)),
    readName: vi.fn(async () => 'Dana Owner'),
    ...overrides,
  };
}

describe('getOwnCreditsBalance', () => {
  it('given a human, should read their own wallet at their tier and name no payer', async () => {
    const d = deps();
    const balance = await getOwnCreditsBalance('human-1', 'pro', d);
    expect(d.readBalance).toHaveBeenCalledWith('human-1', 'pro');
    expect(balance).toEqual({ ...summaryFor(0), subscriptionTier: 'pro', billedTo: null });
    expect(d.readName).not.toHaveBeenCalled();
  });

  it("given a claimed agent, should read the OWNER's wallet at the owner's tier and say it is billed to the owner", async () => {
    const d = deps({
      resolvePayer: vi.fn(async () => ({ payerId: 'owner-1', tier: 'pro' as const, viaAgentOwner: true })),
    });
    const balance = await getOwnCreditsBalance('agent-1', 'free', d);
    expect(d.resolvePayer).toHaveBeenCalledWith({ userId: 'agent-1', tier: 'free' });
    expect(d.readBalance).toHaveBeenCalledWith('owner-1', 'pro');
    expect(d.readName).toHaveBeenCalledWith('owner-1');
    expect(balance).toEqual({ ...summaryFor(900), subscriptionTier: 'pro', billedTo: { userId: 'owner-1', name: 'Dana Owner' } });
  });

  it('given an unclaimed agent, should read its own (empty) wallet: it keeps the requires-funding path', async () => {
    const d = deps();
    const balance = await getOwnCreditsBalance('agent-2', 'free', d);
    expect(d.readBalance).toHaveBeenCalledWith('agent-2', 'free');
    expect(balance.billedTo).toBeNull();
    expect(balance.spendable).toBe(0);
  });
});
