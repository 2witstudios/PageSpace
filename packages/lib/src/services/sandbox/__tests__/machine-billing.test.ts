import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn((a, b) => ({ op: 'eq', a, b })) }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'users.id', subscriptionTier: 'users.subscriptionTier' } }));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', driveId: 'pages.driveId' },
  drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
}));

const mockCanConsumeAI = vi.hoisted(() => vi.fn());
vi.mock('../../../billing/credit-gate', () => ({ canConsumeAI: mockCanConsumeAI }));

const mockReleaseHold = vi.hoisted(() => vi.fn());
vi.mock('../../../billing/credit-consume', () => ({ releaseHold: mockReleaseHold }));

const mockTrackUsage = vi.hoisted(() => vi.fn());
vi.mock('../../../monitoring/ai-monitoring', () => ({ AIMonitoring: { trackUsage: mockTrackUsage } }));

import { defaultSandboxBillingDeps } from '../machine-billing';
import { MACHINE_MARKUP_BPS, MACHINE_MAX_INFLIGHT } from '../../../billing/credit-pricing';
import { getCodeExecutionConcurrencyLimit } from '../quota';

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

function mockPageOwnerRow(row: { ownerId: string } | undefined) {
  mockDb.select.mockReturnValue({
    from: () => ({
      leftJoin: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
        }),
      }),
    }),
  });
}

describe('defaultSandboxBillingDeps.resolvePayerId', () => {
  it('falls back to tenantId when there is no machinePageId (no DB lookup performed)', async () => {
    const result = await defaultSandboxBillingDeps.resolvePayerId({ tenantId: 'owner-1' });
    expect(result).toBe('owner-1');
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("resolves to the referenced machine page's ACTUAL drive owner via the pages -> drives join, not the acting tenantId", async () => {
    mockPageOwnerRow({ ownerId: 'real-owner' });

    const result = await defaultSandboxBillingDeps.resolvePayerId({
      tenantId: 'acting-user',
      machinePageId: 'other-terminal-page',
    });

    expect(result).toBe('real-owner');
  });

  it('falls back to tenantId when the referenced page/drive cannot be resolved', async () => {
    mockPageOwnerRow(undefined);

    const result = await defaultSandboxBillingDeps.resolvePayerId({
      tenantId: 'owner-1',
      machinePageId: 'orphaned-page',
    });

    expect(result).toBe('owner-1');
  });
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

  it("passes the payer's own maxInFlight when MACHINE_MAX_INFLIGHT is left at its default", async () => {
    mockUserRow('business');
    mockCanConsumeAI.mockResolvedValue({ allowed: true, holdId: 'hold-1' });

    await defaultSandboxBillingDeps.gate({ payerId: 'owner-1' });

    const opts = mockCanConsumeAI.mock.calls[0][2];
    // Never below the flat MACHINE_MAX_INFLIGHT floor, and never below the
    // resolved tier's own quota.ts ceiling — see the comment below.
    expect(opts.maxInFlight).toBe(Math.max(MACHINE_MAX_INFLIGHT, getCodeExecutionConcurrencyLimit('business')));
  });

  it("widens maxInFlight past MACHINE_MAX_INFLIGHT when an operator raises a tier's quota.ts ceiling above it, so the billing gate never silently undercuts a raised concurrency tier", async () => {
    const originalEnv = process.env.CODE_EXEC_CONCURRENCY_BUSINESS;
    try {
      // Simulate an operator raising the business tier's semaphore ceiling
      // well past the flat MACHINE_MAX_INFLIGHT default (50) without also
      // updating MACHINE_MAX_INFLIGHT — the exact drift Codex flagged.
      process.env.CODE_EXEC_CONCURRENCY_BUSINESS = String(MACHINE_MAX_INFLIGHT + 25);
      vi.resetModules();
      const { defaultSandboxBillingDeps: freshDeps } = await import('../machine-billing');

      mockUserRow('business');
      mockCanConsumeAI.mockResolvedValue({ allowed: true, holdId: 'hold-1' });

      await freshDeps.gate({ payerId: 'owner-1' });

      const opts = mockCanConsumeAI.mock.calls[0][2];
      expect(opts.maxInFlight).toBe(MACHINE_MAX_INFLIGHT + 25);
    } finally {
      if (originalEnv === undefined) delete process.env.CODE_EXEC_CONCURRENCY_BUSINESS;
      else process.env.CODE_EXEC_CONCURRENCY_BUSINESS = originalEnv;
      vi.resetModules();
    }
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

  it('forwards pageId to AIMonitoring.trackUsage so usage-breakdown can attribute spend per machine', async () => {
    mockTrackUsage.mockResolvedValue(undefined);
    await defaultSandboxBillingDeps.trackUsage({
      payerId: 'owner-1',
      holdId: 'hold-1',
      activeSeconds: 60,
      pageId: 'terminal-page-1',
    });
    const call = mockTrackUsage.mock.calls[0][0];
    expect(call.pageId).toBe('terminal-page-1');
  });

  it("passes MACHINE_MARKUP_BPS as markupBpsOverride so the settle path floors at terminal's own rate, not the shared AI MARKUP_BPS", async () => {
    mockTrackUsage.mockResolvedValue(undefined);
    await defaultSandboxBillingDeps.trackUsage({ payerId: 'owner-1', holdId: 'hold-1', activeSeconds: 3600 });
    const call = mockTrackUsage.mock.calls[0][0];
    expect(call.markupBpsOverride).toBe(MACHINE_MARKUP_BPS);
  });
});

describe('defaultSandboxBillingDeps.releaseHold', () => {
  it("delegates to the credit pipeline's releaseHold", async () => {
    mockReleaseHold.mockResolvedValue(undefined);
    await defaultSandboxBillingDeps.releaseHold('hold-1');
    expect(mockReleaseHold).toHaveBeenCalledWith('hold-1');
  });
});
