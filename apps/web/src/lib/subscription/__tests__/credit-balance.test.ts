import { describe, it, expect, vi, beforeEach } from 'vitest';

// Table sentinels so the db mock can branch on which table `.from()` received.
vi.mock('@pagespace/db/schema/credits', () => ({
  creditBalances: { __t: 'balances' },
  creditHolds: { __t: 'holds' },
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { __t: 'users' } }));

vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  gt: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

const { mockIsBillingEnabled } = vi.hoisted(() => ({ mockIsBillingEnabled: vi.fn(() => true) }));
vi.mock('@pagespace/lib/deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));

vi.mock('@/lib/websocket/socket-utils', () => ({ broadcastCreditsEvent: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

// Mutable fixtures the db mock reads.
let balanceRows: Array<Record<string, unknown>> = [];
let holdRows: Array<{ reserved: number }> = [{ reserved: 0 }];
let userRows: Array<{ subscriptionTier: string }> = [{ subscriptionTier: 'free' }];

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: (table: { __t: string }) => ({
        where: () => {
          const rows =
            table.__t === 'balances' ? balanceRows : table.__t === 'holds' ? holdRows : userRows;
          // Balance/users read via .limit(1); holds awaited directly. Support both by
          // returning a thenable that also exposes .limit().
          const thenable = {
            limit: () => Promise.resolve(rows),
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
          };
          return thenable;
        },
      }),
    }),
  },
}));

import { getCreditBalance } from '../credit-balance';

const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const past = new Date(Date.now() - 24 * 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
  mockIsBillingEnabled.mockReturnValue(true);
  balanceRows = [];
  holdRows = [{ reserved: 0 }];
  userRows = [{ subscriptionTier: 'free' }];
});

describe('getCreditBalance', () => {
  it('returns a disabled summary when billing is off', async () => {
    mockIsBillingEnabled.mockReturnValue(false);
    const b = await getCreditBalance('u1', 'free');
    expect(b.billingEnabled).toBe(false);
    expect(b.spendable).toBe(0);
  });

  it('shows the tier allowance when no balance row exists yet', async () => {
    balanceRows = [];
    const b = await getCreditBalance('u1', 'free');
    expect(b.billingEnabled).toBe(true);
    expect(b.monthly.allowance).toBeGreaterThan(0);
    expect(b.monthly.remaining).toBe(b.monthly.allowance);
    expect(b.spendable).toBe(b.monthly.allowance);
  });

  it('subtracts active holds from spendable when no row exists', async () => {
    balanceRows = [];
    holdRows = [{ reserved: 25 }];
    const b = await getCreditBalance('u1', 'free');
    expect(b.reserved).toBe(25);
    expect(b.spendable).toBe(b.monthly.allowance - 25);
  });

  it('uses stored remaining for a free tier within its period', async () => {
    balanceRows = [
      {
        monthlyRemainingCents: 320,
        monthlyAllowanceCents: 500,
        topupRemainingCents: 1000,
        monthlyPeriodEnd: future,
      },
    ];
    const b = await getCreditBalance('u1', 'free');
    expect(b.monthly.remaining).toBe(320);
    expect(b.topup.remaining).toBe(1000);
    expect(b.spendable).toBe(320 + 1000);
  });

  it('shows the full allowance for a free tier whose period has lapsed (gate will reset)', async () => {
    balanceRows = [
      {
        monthlyRemainingCents: 0,
        monthlyAllowanceCents: 500,
        topupRemainingCents: 0,
        monthlyPeriodEnd: past,
      },
    ];
    const b = await getCreditBalance('u1', 'free');
    expect(b.monthly.remaining).toBe(500);
    expect(b.spendable).toBe(500);
  });

  it('zeroes the expired monthly bucket for a paid tier (use-it-or-lose-it)', async () => {
    balanceRows = [
      {
        monthlyRemainingCents: 900,
        monthlyAllowanceCents: 1500,
        topupRemainingCents: 250,
        monthlyPeriodEnd: past,
      },
    ];
    const b = await getCreditBalance('u1', 'pro');
    expect(b.monthly.remaining).toBe(0);
    expect(b.spendable).toBe(250); // only top-up survives
  });

  it('clamps spendable at zero when holds exceed the balance', async () => {
    balanceRows = [
      {
        monthlyRemainingCents: 10,
        monthlyAllowanceCents: 500,
        topupRemainingCents: 0,
        monthlyPeriodEnd: future,
      },
    ];
    holdRows = [{ reserved: 50 }];
    const b = await getCreditBalance('u1', 'free');
    expect(b.spendable).toBe(0);
  });
});
