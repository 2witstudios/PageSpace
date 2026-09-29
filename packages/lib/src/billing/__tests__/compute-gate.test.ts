import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn((a, b) => ({ op: 'eq', a, b })) }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'users.id', subscriptionTier: 'users.subscriptionTier' } }));

const gate = vi.hoisted(() => ({
  canConsumeAI: vi.fn(),
  canConsumeOrgPool: vi.fn(),
  findOrgPoolWalletId: vi.fn(),
  hasSpendableBalance: vi.fn(),
  hasSpendableOrgPool: vi.fn(),
}));
vi.mock('../credit-gate', () => gate);
const consume = vi.hoisted(() => ({ holdWalletId: vi.fn() }));
vi.mock('../credit-consume', () => consume);
vi.mock('../personal-wallet', () => ({ ensurePersonalRootWalletId: vi.fn(async (_db: unknown, userId: string) => `root-of-${userId}`) }));

import { computeSettleWalletId, gateComputeCharge, hasSpendableComputeBalance, holdMatchesCharge, resolveComputeChargeTier } from '../compute-gate';
import type { ComputeCharge } from '../compute-charge';

const ORG: ComputeCharge = { kind: 'org', orgId: 'org-1', userId: 'member-1' };
const PERSON: ComputeCharge = { kind: 'user', userId: 'owner-1' };

function tierRow(tier: string | null) {
  mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ subscriptionTier: tier }] }) }) });
}

beforeEach(() => {
  mockDb.select.mockReset();
  for (const fn of Object.values(gate)) fn.mockReset();
  consume.holdWalletId.mockReset();
});

describe('gateComputeCharge', () => {
  it('WAL-9 (partial) an org charge holds on the org pool, marked compute, with the org-tier in-flight bound — and never reaches canConsumeAI', async () => {
    gate.canConsumeOrgPool.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'h1', walletId: 'pool-1' });
    const result = await gateComputeCharge(ORG, { estCostCents: 5, maxInFlight: (tier) => (tier === 'business' ? 9 : 1) });
    expect(gate.canConsumeOrgPool).toHaveBeenCalledWith('member-1', 'org-1', { estCostCents: 5, maxInFlight: 9, spendKind: 'compute' });
    expect(gate.canConsumeAI).not.toHaveBeenCalled();
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(result).toEqual({ allowed: true, holdId: 'h1', walletId: 'pool-1' });
  });

  it('WAL-9 (partial) a missing org pool refuses by name, never falling back to the person', async () => {
    gate.canConsumeOrgPool.mockResolvedValue({ allowed: false, reason: 'source_refused', refusal: { source: null, reason: 'source_unavailable', options: [] } });
    expect(await gateComputeCharge(ORG, { estCostCents: 5 })).toEqual({ allowed: false, reason: 'org_wallet_unavailable', orgRefusal: 'org_wallet_unavailable' });
    expect(gate.canConsumeAI).not.toHaveBeenCalled();
  });

  it("a personal charge gates the payer's personal root on their own tier, marked compute", async () => {
    tierRow('pro');
    gate.canConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'h2' });
    const result = await gateComputeCharge(PERSON, { estCostCents: 5, maxInFlight: 3 });
    expect(gate.canConsumeAI).toHaveBeenCalledWith('owner-1', 'pro', { estCostCents: 5, maxInFlight: 3, spendKind: 'compute', spend: { kind: 'personal' } });
    expect(gate.canConsumeOrgPool).not.toHaveBeenCalled();
    expect(result).toEqual({ allowed: true, holdId: 'h2', walletId: undefined });
  });

  it("a personal refusal keeps the gate's own reason and names no org state", async () => {
    tierRow('free');
    gate.canConsumeAI.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });
    expect(await gateComputeCharge(PERSON, { estCostCents: 5 })).toEqual({ allowed: false, reason: 'out_of_credits' });
  });
});

describe('computeSettleWalletId', () => {
  it('WAL-9 (partial) an org charge settles on the org pool — the same wallet the hold named', async () => {
    gate.findOrgPoolWalletId.mockResolvedValue('pool-1');
    expect(await computeSettleWalletId(ORG)).toBe('pool-1');
    expect(gate.findOrgPoolWalletId).toHaveBeenCalledWith('org-1');
  });

  it("a gone pool answers null (do not settle); a personal charge names the person's own root explicitly", async () => {
    gate.findOrgPoolWalletId.mockResolvedValue(null);
    expect(await computeSettleWalletId(ORG)).toBeNull();
    expect(await computeSettleWalletId(PERSON)).toBe('root-of-owner-1');
  });

  it('names no wallet where billing is off — nothing moves money there', async () => {
    const mode = process.env.DEPLOYMENT_MODE;
    process.env.DEPLOYMENT_MODE = 'onprem';
    try {
      expect(await computeSettleWalletId(ORG)).toBeUndefined();
      expect(await computeSettleWalletId(PERSON)).toBeUndefined();
    } finally {
      process.env.DEPLOYMENT_MODE = mode;
    }
  });
});

describe('holdMatchesCharge', () => {
  it('WAL-9 (partial) a hold on the PERSON does not match an org charge (a drive moved into an org mid-run)', async () => {
    consume.holdWalletId.mockResolvedValue('root-of-member-1');
    gate.findOrgPoolWalletId.mockResolvedValue('pool-1');
    expect(await holdMatchesCharge({ holdId: 'h', charge: ORG })).toBe(false);
  });

  it('WAL-9 (partial) a hold on the ORG POOL does not match a personal charge (a drive moved out of an org mid-run)', async () => {
    consume.holdWalletId.mockResolvedValue('pool-1');
    expect(await holdMatchesCharge({ holdId: 'h', charge: PERSON })).toBe(false);
  });

  it('matches a hold on the charge\'s own wallet, and a hold that no longer exists conflicts with nothing', async () => {
    consume.holdWalletId.mockResolvedValue('pool-1');
    gate.findOrgPoolWalletId.mockResolvedValue('pool-1');
    expect(await holdMatchesCharge({ holdId: 'h', charge: ORG })).toBe(true);
    consume.holdWalletId.mockResolvedValue(null);
    expect(await holdMatchesCharge({ holdId: 'gone', charge: PERSON })).toBe(true);
  });
});

describe('hasSpendableComputeBalance', () => {
  it("WAL-9 (partial) asks the ORG POOL for an org charge, never the person's balance", async () => {
    gate.hasSpendableOrgPool.mockResolvedValue(false);
    expect(await hasSpendableComputeBalance(ORG)).toBe(false);
    expect(gate.hasSpendableOrgPool).toHaveBeenCalledWith('org-1');
    expect(gate.hasSpendableBalance).not.toHaveBeenCalled();
  });

  it("asks the person's balance on their own tier for a personal charge", async () => {
    tierRow('business');
    gate.hasSpendableBalance.mockResolvedValue(true);
    expect(await hasSpendableComputeBalance(PERSON)).toBe(true);
    expect(gate.hasSpendableBalance).toHaveBeenCalledWith('owner-1', 'business');
  });
});

describe('resolveComputeChargeTier', () => {
  it("an org charge is the org's tier with no read; a personal charge reads the person's", async () => {
    expect(await resolveComputeChargeTier(ORG)).toBe('business');
    expect(mockDb.select).not.toHaveBeenCalled();
    tierRow(null);
    expect(await resolveComputeChargeTier(PERSON)).toBe('free');
  });
});
