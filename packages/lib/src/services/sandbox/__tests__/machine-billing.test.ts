import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn((a, b) => ({ op: 'eq', a, b })) }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'users.id', subscriptionTier: 'users.subscriptionTier' } }));

const mockCanConsumeAI = vi.hoisted(() => vi.fn());
vi.mock('../../../billing/credit-gate', () => ({ canConsumeAI: mockCanConsumeAI }));

const mockReleaseHold = vi.hoisted(() => vi.fn());
vi.mock('../../../billing/credit-consume', () => ({ releaseHold: mockReleaseHold }));

const mockTrackUsage = vi.hoisted(() => vi.fn());
vi.mock('../../../monitoring/ai-monitoring', () => ({ AIMonitoring: { trackUsage: mockTrackUsage } }));

import { defaultSandboxBillingDeps } from '../machine-billing';

function mockUserRow(tier: string | null) {
  mockDb.select.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => [{ subscriptionTier: tier }],
      }),
    }),
  });
}

beforeEach(() => {
  mockDb.select.mockReset();
  mockCanConsumeAI.mockReset();
  mockReleaseHold.mockReset();
  mockTrackUsage.mockReset();
});

describe('defaultSandboxBillingDeps.gate', () => {
  it("resolves the PAYER's own subscription tier (not the caller's) and gates via canConsumeAI", async () => {
    mockUserRow('business');
    mockCanConsumeAI.mockResolvedValue({ allowed: true, holdId: 'hold-1' });

    const result = await defaultSandboxBillingDeps.gate({ payerId: 'owner-1' });

    expect(mockCanConsumeAI).toHaveBeenCalledWith(
      'owner-1',
      'business',
      expect.objectContaining({ estCostCents: expect.any(Number), maxInFlight: expect.any(Number) }),
    );
    expect(result).toEqual({ allowed: true, holdId: 'hold-1', reason: undefined });
  });

  it('defaults to the free tier when the payer has no row / an unrecognized tier', async () => {
    mockUserRow(null);
    mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'insufficient_balance' });

    const result = await defaultSandboxBillingDeps.gate({ payerId: 'owner-2' });

    expect(mockCanConsumeAI).toHaveBeenCalledWith('owner-2', 'free', expect.anything());
    expect(result).toEqual({ allowed: false, holdId: undefined, reason: 'insufficient_balance' });
  });

  it('does not set skipDailyCap, so terminal spend feeds the per-user/day exposure cap like every other source', async () => {
    mockUserRow('pro');
    mockCanConsumeAI.mockResolvedValue({ allowed: true, holdId: 'hold-1' });

    await defaultSandboxBillingDeps.gate({ payerId: 'owner-1' });

    const opts = mockCanConsumeAI.mock.calls[0][2];
    expect(opts.skipDailyCap).not.toBe(true);
  });
});

describe('defaultSandboxBillingDeps.trackUsage', () => {
  it("bills source:'terminal' with the real active-window cost and threads the holdId through", async () => {
    mockTrackUsage.mockResolvedValue(undefined);

    await defaultSandboxBillingDeps.trackUsage({ payerId: 'owner-1', holdId: 'hold-1', activeSeconds: 3600 });

    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    const call = mockTrackUsage.mock.calls[0][0];
    expect(call).toMatchObject({
      userId: 'owner-1',
      source: 'terminal',
      holdId: 'hold-1',
      success: true,
      costSource: 'list_price',
    });
    expect(call.providerCostDollars).toBeGreaterThan(0);
  });

  it('bills nothing for a zero-duration (hibernated) window', async () => {
    mockTrackUsage.mockResolvedValue(undefined);
    await defaultSandboxBillingDeps.trackUsage({ payerId: 'owner-1', activeSeconds: 0 });
    const call = mockTrackUsage.mock.calls[0][0];
    expect(call.providerCostDollars).toBe(0);
  });
});

describe('defaultSandboxBillingDeps.releaseHold', () => {
  it("delegates to the credit pipeline's releaseHold", async () => {
    mockReleaseHold.mockResolvedValue(undefined);
    await defaultSandboxBillingDeps.releaseHold('hold-1');
    expect(mockReleaseHold).toHaveBeenCalledWith('hold-1');
  });
});
