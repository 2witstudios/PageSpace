import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn((a, b) => ({ op: 'eq', a, b })) }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'users.id', subscriptionTier: 'users.subscriptionTier' } }));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', driveId: 'pages.driveId' },
  drives: { id: 'drives.id', ownerId: 'drives.ownerId', orgId: 'drives.orgId' },
}));

const mockCanConsumeAI = vi.hoisted(() => vi.fn());
const mockCanConsumeOrgPool = vi.hoisted(() => vi.fn());
const mockFindOrgPoolWalletId = vi.hoisted(() => vi.fn());
vi.mock('../../../billing/credit-gate', () => ({
  canConsumeAI: mockCanConsumeAI,
  canConsumeOrgPool: mockCanConsumeOrgPool,
  findOrgPoolWalletId: mockFindOrgPoolWalletId,
  hasSpendableBalance: vi.fn(),
  hasSpendableOrgPool: vi.fn(),
}));

const mockReleaseHold = vi.hoisted(() => vi.fn());
const mockHoldWalletId = vi.hoisted(() => vi.fn());
vi.mock('../../../billing/credit-consume', () => ({ releaseHold: mockReleaseHold, holdWalletId: mockHoldWalletId }));
// A personal charge settles on the person's personal root, named explicitly (P1-1).
vi.mock('../../../billing/personal-wallet', () => ({ ensurePersonalRootWalletId: vi.fn(async (_db: unknown, userId: string) => `root-of-${userId}`) }));

const mockTrackUsage = vi.hoisted(() => vi.fn());
vi.mock('../../../monitoring/ai-monitoring', () => ({ AIMonitoring: { trackUsage: mockTrackUsage } }));

import { defaultSandboxBillingDeps } from '../sandbox-billing';
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
  mockCanConsumeOrgPool.mockReset();
  mockFindOrgPoolWalletId.mockReset();
  mockReleaseHold.mockReset();
  mockTrackUsage.mockReset();
});

function mockDriveOwnerRow(row: { ownerId: string; orgId: string | null } | undefined) {
  mockDb.select.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => (row ? [row] : []),
      }),
    }),
  });
}

describe('defaultSandboxBillingDeps.resolveCharge', () => {
  it('charges the session ownerId directly for a global-assistant session (driveId null), with no DB lookup', async () => {
    const result = await defaultSandboxBillingDeps.resolveCharge({ driveId: null, ownerId: 'owner-1' });
    expect(result).toEqual({ kind: 'user', userId: 'owner-1' });
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("resolves to the SESSION's ACTUAL drive owner via a direct drives read — never the session's own ownerId when a real owner resolves", async () => {
    mockDriveOwnerRow({ ownerId: 'real-owner', orgId: null });
    const result = await defaultSandboxBillingDeps.resolveCharge({ driveId: 'session-drive-1', ownerId: 'session-owner-1' });
    expect(result).toEqual({ kind: 'user', userId: 'real-owner' });
  });

  it("WAL-9 (partial) an ORG drive's session charges the org pool, recorded under the session owner — never the drive lead's wallet", async () => {
    mockDriveOwnerRow({ ownerId: 'lead-marcus', orgId: 'org-northwind' });
    const result = await defaultSandboxBillingDeps.resolveCharge({ driveId: 'org-drive', ownerId: 'session-owner-1' });
    expect(result).toEqual({ kind: 'org', orgId: 'org-northwind', userId: 'session-owner-1' });
    expect(mockCanConsumeAI).not.toHaveBeenCalled();
  });

  it('falls back to the session ownerId when the drive cannot be resolved (a stale read mid-delete)', async () => {
    mockDriveOwnerRow(undefined);
    const result = await defaultSandboxBillingDeps.resolveCharge({ driveId: 'vanished-drive', ownerId: 'owner-1' });
    expect(result).toEqual({ kind: 'user', userId: 'owner-1' });
  });
});

describe('defaultSandboxBillingDeps.gate — org charge', () => {
  const orgCharge = { kind: 'org' as const, orgId: 'org-northwind', userId: 'member-ana' };

  it('WAL-9 (partial) holds on the ORG POOL with the org tier, marked compute — never through canConsumeAI on a person', async () => {
    mockCanConsumeOrgPool.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-org', walletId: 'pool-1' });
    const result = await defaultSandboxBillingDeps.gate({ charge: orgCharge });
    expect(mockCanConsumeOrgPool).toHaveBeenCalledWith(
      'member-ana',
      'org-northwind',
      expect.objectContaining({ spendKind: 'compute', maxInFlight: Math.max(MACHINE_MAX_INFLIGHT, getCodeExecutionConcurrencyLimit('business')) }),
    );
    expect(mockCanConsumeAI).not.toHaveBeenCalled();
    expect(result).toEqual({ allowed: true, holdId: 'hold-org' });
  });

  it('WAL-9 (partial) an empty org pool refuses with org_wallet_empty and no person is gated', async () => {
    mockCanConsumeOrgPool.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });
    const result = await defaultSandboxBillingDeps.gate({ charge: orgCharge });
    expect(result).toEqual({ allowed: false, reason: 'org_wallet_empty', orgRefusal: 'org_wallet_empty' });
    expect(mockCanConsumeAI).not.toHaveBeenCalled();
  });
});

describe('defaultSandboxBillingDeps.gate', () => {
  it("resolves the PAYER's own subscription tier (not the caller's) and gates via canConsumeAI", async () => {
    mockUserRow('business');
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-1' });

    const result = await defaultSandboxBillingDeps.gate({ charge: { kind: 'user', userId: 'owner-1' } });

    expect(mockCanConsumeAI).toHaveBeenCalledWith(
      'owner-1',
      'business',
      // Compute bills the payer's personal wallet (WAL-9): no drive wallet is ever named.
      expect.objectContaining({ spend: { kind: 'personal' }, spendKind: 'compute', estCostCents: expect.any(Number), maxInFlight: expect.any(Number) }),
    );
    expect(result).toEqual({ allowed: true, holdId: 'hold-1' });
  });

  it('defaults to the free tier when the payer has no row / an unrecognized tier', async () => {
    mockUserRow(null);
    mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'insufficient_balance' });

    const result = await defaultSandboxBillingDeps.gate({ charge: { kind: 'user', userId: 'owner-2' } });

    expect(mockCanConsumeAI).toHaveBeenCalledWith('owner-2', 'free', expect.anything());
    expect(result).toEqual({ allowed: false, reason: 'insufficient_balance', orgRefusal: undefined });
  });

  it('does not set skipDailyCap, so terminal spend feeds the per-user/day exposure cap like every other source', async () => {
    mockUserRow('pro');
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-1' });

    await defaultSandboxBillingDeps.gate({ charge: { kind: 'user', userId: 'owner-1' } });

    const opts = mockCanConsumeAI.mock.calls[0][2];
    expect(opts.skipDailyCap).not.toBe(true);
  });

  it("passes the payer's own maxInFlight when MACHINE_MAX_INFLIGHT is left at its default", async () => {
    mockUserRow('business');
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-1' });

    await defaultSandboxBillingDeps.gate({ charge: { kind: 'user', userId: 'owner-1' } });

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
      const { defaultSandboxBillingDeps: freshDeps } = await import('../sandbox-billing');

      mockUserRow('business');
      mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-1' });

      await freshDeps.gate({ charge: { kind: 'user', userId: 'owner-1' } });

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
  it('RETURNS the credit seam’s persistence outcome verbatim — the shell heartbeat gates its billing window on it', async () => {
    mockTrackUsage.mockResolvedValueOnce({ persisted: false, creditsSettled: false });
    expect(
      await defaultSandboxBillingDeps.trackUsage({ charge: { kind: 'user', userId: 'owner-1' }, holdId: 'hold-1', activeSeconds: 3600 }),
    ).toEqual({ persisted: false, creditsSettled: false });

    mockTrackUsage.mockResolvedValueOnce({ persisted: true, creditsSettled: true });
    expect(
      await defaultSandboxBillingDeps.trackUsage({ charge: { kind: 'user', userId: 'owner-1' }, holdId: 'hold-1', activeSeconds: 3600 }),
    ).toEqual({ persisted: true, creditsSettled: true });
  });

  it("bills source:'terminal' with the real active-window cost and threads the holdId through", async () => {
    mockTrackUsage.mockResolvedValue(undefined);

    await defaultSandboxBillingDeps.trackUsage({ charge: { kind: 'user', userId: 'owner-1' }, holdId: 'hold-1', activeSeconds: 3600 });

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
    await defaultSandboxBillingDeps.trackUsage({ charge: { kind: 'user', userId: 'owner-1' }, activeSeconds: 0 });
    const call = mockTrackUsage.mock.calls[0][0];
    expect(call.providerCostDollars).toBe(0);
  });

  it('forwards pageId to AIMonitoring.trackUsage so usage-breakdown can attribute spend per machine', async () => {
    mockTrackUsage.mockResolvedValue(undefined);
    await defaultSandboxBillingDeps.trackUsage({
      charge: { kind: 'user', userId: 'owner-1' },
      holdId: 'hold-1',
      activeSeconds: 60,
      pageId: 'terminal-page-1',
    });
    const call = mockTrackUsage.mock.calls[0][0];
    expect(call.pageId).toBe('terminal-page-1');
  });

  it('forwards driveId/workspaceId to AIMonitoring.trackUsage as first-class attribution (Terminal Epic 3 usage-breakdown fix)', async () => {
    mockTrackUsage.mockResolvedValue(undefined);
    await defaultSandboxBillingDeps.trackUsage({
      charge: { kind: 'user', userId: 'owner-1' },
      holdId: 'hold-1',
      activeSeconds: 60,
      driveId: 'drive-1',
      workspaceId: 'session-1',
    });
    const call = mockTrackUsage.mock.calls[0][0];
    expect(call.driveId).toBe('drive-1');
    expect(call.sessionId).toBe('session-1');
  });

  it("passes MACHINE_MARKUP_BPS as markupBpsOverride so the settle path floors at terminal's own rate, not the shared AI MARKUP_BPS", async () => {
    mockTrackUsage.mockResolvedValue(undefined);
    await defaultSandboxBillingDeps.trackUsage({ charge: { kind: 'user', userId: 'owner-1' }, holdId: 'hold-1', activeSeconds: 3600 });
    const call = mockTrackUsage.mock.calls[0][0];
    expect(call.markupBpsOverride).toBe(MACHINE_MARKUP_BPS);
  });
});

describe('defaultSandboxBillingDeps.trackUsage — org charge', () => {
  const orgCharge = { kind: 'org' as const, orgId: 'org-northwind', userId: 'member-ana' };

  it('WAL-9 (partial) settles an org charge on the ORG POOL wallet, recorded under the person, marked compute', async () => {
    mockFindOrgPoolWalletId.mockResolvedValue('pool-1');
    mockTrackUsage.mockResolvedValue({ persisted: true, creditsSettled: true });
    await defaultSandboxBillingDeps.trackUsage({ charge: orgCharge, holdId: 'hold-org', activeSeconds: 60 });
    expect(mockTrackUsage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'member-ana', walletId: 'pool-1', holdId: 'hold-org', spendKind: 'compute' }));
  });

  it('WAL-9 (partial) an org pool gone since the hold settles nothing — never onto the person', async () => {
    mockFindOrgPoolWalletId.mockResolvedValue(null);
    const outcome = await defaultSandboxBillingDeps.trackUsage({ charge: orgCharge, holdId: 'hold-org', activeSeconds: 60 });
    expect(outcome).toEqual({ persisted: false, creditsSettled: false });
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("WAL-9 (partial) a personal charge names the person's personal root explicitly — a hold left on another wallet can never win", async () => {
    mockTrackUsage.mockResolvedValue({ persisted: true, creditsSettled: true });
    await defaultSandboxBillingDeps.trackUsage({ charge: { kind: 'user', userId: 'owner-1' }, activeSeconds: 60 });
    expect(mockTrackUsage.mock.calls[0][0].walletId).toBe('root-of-owner-1');
    expect(mockFindOrgPoolWalletId).not.toHaveBeenCalled();
  });
});

describe('defaultSandboxBillingDeps.releaseHold', () => {
  it("delegates to the credit pipeline's releaseHold", async () => {
    mockReleaseHold.mockResolvedValue(undefined);
    await defaultSandboxBillingDeps.releaseHold('hold-1');
    expect(mockReleaseHold).toHaveBeenCalledWith('hold-1');
  });
});
