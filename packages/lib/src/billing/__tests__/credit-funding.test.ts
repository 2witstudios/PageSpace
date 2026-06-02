import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const mockIsBillingEnabled = vi.hoisted(() => vi.fn(() => true));
const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  transaction: vi.fn(),
}));
const mockApiLogger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/schema/credits', () => ({
  creditBalances: { userId: 'cb.userId', topupRemainingCents: 'cb.topup' },
  creditLedger: { id: 'cl.id', stripeRef: 'cl.stripeRef' },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'u.id', stripeCustomerId: 'u.stripeCustomerId', subscriptionTier: 'u.subscriptionTier' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: true, strings, values })),
}));
vi.mock('../../deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));
vi.mock('../../logging/logger-config', () => ({ loggers: { api: mockApiLogger } }));

import { applyStripeFunding } from '../credit-funding';
import { TIER_MONTHLY_ALLOWANCE_CENTS } from '../credit-pricing';

// Capture bag for what each db call was handed.
interface Captured {
  ledgerValues?: Record<string, unknown>;
  arbiter?: { target?: unknown; where?: unknown };
  balanceValues?: Record<string, unknown>;
  balanceSet?: Record<string, unknown>;
}

// Build a credit_ledger insert chain whose returning() resolves to `returned`
// (empty array = ON CONFLICT did nothing, i.e. a redelivered event).
function ledgerInsert(returned: Array<{ id: string }>, cap: Captured) {
  return {
    values: (v: Record<string, unknown>) => {
      cap.ledgerValues = v;
      return {
        onConflictDoNothing: (arb: { target?: unknown; where?: unknown }) => {
          cap.arbiter = arb;
          return { returning: () => Promise.resolve(returned) };
        },
      };
    },
  };
}

// Build a credit_balances upsert chain.
function balanceUpsert(cap: Captured) {
  return {
    values: (v: Record<string, unknown>) => {
      cap.balanceValues = v;
      return {
        onConflictDoUpdate: ({ set }: { target: unknown; set: Record<string, unknown> }) => {
          cap.balanceSet = set;
          return Promise.resolve(undefined);
        },
      };
    },
  };
}

// resolveUser(): db.select({...}).from(users).where(...).limit(1) -> rows
function userSelectReturning(rows: Array<{ id: string; subscriptionTier: string }>) {
  return { from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) };
}

const PRO_USER = [{ id: 'u1', subscriptionTier: 'pro' }];

const invoiceEvent = {
  id: 'evt_inv',
  type: 'invoice.paid',
  data: {
    object: { id: 'in_123', customer: 'cus_1', period_start: 1_700_000_000, period_end: 1_702_592_000 },
  },
};

const topupEvent = {
  id: 'evt_chk',
  type: 'checkout.session.completed',
  data: {
    object: { id: 'cs_123', customer: 'cus_1', mode: 'payment', metadata: { kind: 'credit_pack', packCents: '2500' } },
  },
};

const subscriptionCheckoutEvent = {
  id: 'evt_sub',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_sub', customer: 'cus_1', mode: 'subscription', metadata: {} } },
};

describe('applyStripeFunding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBillingEnabled.mockReturnValue(true);
  });

  it('does nothing when billing is disabled (tenant/onprem)', async () => {
    mockIsBillingEnabled.mockReturnValue(false);
    await applyStripeFunding(invoiceEvent);
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('invoice.paid resets the monthly bucket to the tier allowance, sets the period, and writes a monthly_grant row', async () => {
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    const cap: Captured = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: vi.fn()
          .mockReturnValueOnce(ledgerInsert([{ id: 'led_1' }], cap))
          .mockReturnValueOnce(balanceUpsert(cap)),
      };
      await cb(tx);
    });

    await applyStripeFunding(invoiceEvent);

    const allowance = TIER_MONTHLY_ALLOWANCE_CENTS.pro;
    expect(cap.ledgerValues).toMatchObject({
      userId: 'u1',
      entryType: 'monthly_grant',
      bucket: 'monthly',
      amountCents: allowance,
      stripeRef: 'in_123',
    });
    expect(cap.balanceSet).toEqual({
      monthlyRemainingCents: allowance,
      monthlyAllowanceCents: allowance,
      monthlyPeriodStart: new Date(1_700_000_000 * 1000),
      monthlyPeriodEnd: new Date(1_702_592_000 * 1000),
    });
  });

  it('credit-pack checkout adds to the top-up bucket and writes a topup_purchase row', async () => {
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    const cap: Captured = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: vi.fn()
          .mockReturnValueOnce(ledgerInsert([{ id: 'led_2' }], cap))
          .mockReturnValueOnce(balanceUpsert(cap)),
        // existing top-up balance of 1000 cents, locked for update
        select: () => ({ from: () => ({ where: () => ({ for: () => Promise.resolve([{ topupRemainingCents: 1000 }]) }) }) }),
      };
      await cb(tx);
    });

    await applyStripeFunding(topupEvent);

    expect(cap.ledgerValues).toMatchObject({
      userId: 'u1',
      entryType: 'topup_purchase',
      bucket: 'topup',
      amountCents: 2500,
      stripeRef: 'cs_123',
    });
    // applyTopup(1000, 2500) = 3500
    expect(cap.balanceSet).toEqual({ topupRemainingCents: 3500 });
  });

  it('declares the partial-index predicate as the ON CONFLICT arbiter on the funding ledger insert', async () => {
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    const cap: Captured = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: vi.fn()
          .mockReturnValueOnce(ledgerInsert([{ id: 'led_1' }], cap))
          .mockReturnValueOnce(balanceUpsert(cap)),
      };
      await cb(tx);
    });

    await applyStripeFunding(invoiceEvent);

    expect(cap.arbiter).toBeDefined();
    expect(cap.arbiter).toHaveProperty('target');
    expect(cap.arbiter?.where).toBeDefined();
  });

  it('is exactly-once: a redelivered event whose grant row already exists does not touch the balance', async () => {
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    const cap: Captured = {};
    const balanceInsert = vi.fn();
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        // ON CONFLICT DO NOTHING returns no row -> already funded
        insert: vi.fn()
          .mockReturnValueOnce(ledgerInsert([], cap))
          .mockImplementationOnce(balanceInsert),
      };
      await cb(tx);
    });

    await applyStripeFunding(invoiceEvent);

    expect(balanceInsert).not.toHaveBeenCalled();
    expect(cap.balanceSet).toBeUndefined();
    expect(cap.balanceValues).toBeUndefined();
  });

  it('ignores a subscription-mode checkout (funding is only for credit-pack payments)', async () => {
    await applyStripeFunding(subscriptionCheckoutEvent);
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('never throws out of the webhook: a funding failure is logged and swallowed', async () => {
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    mockDb.transaction.mockRejectedValueOnce(new Error('db boom'));
    await expect(applyStripeFunding(invoiceEvent)).resolves.toBeUndefined();
    expect(mockApiLogger.error).toHaveBeenCalled();
  });

  it('skips funding (and never opens a transaction) when no user matches the Stripe customer', async () => {
    mockDb.select.mockReturnValue(userSelectReturning([]));
    await applyStripeFunding(invoiceEvent);
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalled();
  });
});
