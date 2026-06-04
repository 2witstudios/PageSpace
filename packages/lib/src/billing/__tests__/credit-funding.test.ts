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
  creditBalances: { userId: 'cb.userId', topupRemainingCents: 'cb.topup', debtCents: 'cb.debt' },
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

// Build a select chain for reading the current creditBalances row inside the tx.
function balanceSelectReturning(monthlyRemainingCents: number) {
  return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ monthlyRemainingCents }]) }) }) };
}

// tx for the monthly refill path: ledger insert -> select current balance -> balance upsert.
function refillTx(cap: Captured, ledgerReturned: Array<{ id: string }>, currentRemaining: number) {
  return {
    insert: vi.fn()
      .mockReturnValueOnce(ledgerInsert(ledgerReturned, cap))
      .mockReturnValueOnce(balanceUpsert(cap)),
    select: vi.fn().mockReturnValueOnce(balanceSelectReturning(currentRemaining)),
  };
}

// Ensure-row insert in the top-up path: .values({userId}).onConflictDoNothing({target}).
function ensureRowInsert() {
  return { values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }) };
}

// Build the tx the top-up path drives: ledger insert -> ensure-row insert ->
// SELECT ... FOR UPDATE (returns `existingTopup`/`existingDebt`) -> UPDATE (captured).
function topupTx(
  cap: Captured,
  ledgerReturned: Array<{ id: string }>,
  existingTopup: number,
  existingDebt = 0,
) {
  return {
    insert: vi.fn()
      .mockReturnValueOnce(ledgerInsert(ledgerReturned, cap))
      .mockReturnValueOnce(ensureRowInsert()),
    select: () => ({ from: () => ({ where: () => ({ for: () => Promise.resolve([{ topupRemainingCents: existingTopup, debtCents: existingDebt }]) }) }) }),
    update: () => ({ set: (v: Record<string, unknown>) => { cap.balanceSet = v; return { where: () => Promise.resolve(undefined) }; } }),
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

// First-time credit-pack buyer: the Stripe customer is not yet linked to any user
// (customer lookup returns nothing), but we stamped the user's id into the checkout
// session metadata when we created it. Funding must resolve the buyer from that
// trusted metadata.userId, not the unlinked customer.
const unlinkedTopupEvent = {
  id: 'evt_chk_meta',
  type: 'checkout.session.completed',
  data: {
    object: { id: 'cs_meta', mode: 'payment', metadata: { kind: 'credit_pack', packCents: '2500', userId: 'u1' } },
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

  it('invoice.paid adds the tier allowance to the current balance, sets the period, and writes a monthly_grant row', async () => {
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    const cap: Captured = {};
    // No prior balance row (currentRemaining = 0): rollover of 0 + allowance = allowance.
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb(refillTx(cap, [{ id: 'led_1' }], 0));
    });

    await applyStripeFunding(invoiceEvent);

    const allowance = TIER_MONTHLY_ALLOWANCE_CENTS.pro;
    expect(cap.ledgerValues).toMatchObject({
      userId: 'u1',
      entryType: 'monthly_grant',
      bucket: 'monthly',
      amountCents: allowance,
      stripeRef: 'in_123',
      // Must be settled on insert: a 'pending' grant would be clawed back by the
      // backfill cron's pending-usage sweep (settlePendingLedgerRow subtracts it).
      consumeStatus: 'applied',
    });
    expect(cap.balanceSet).toEqual({
      monthlyRemainingCents: allowance,
      monthlyAllowanceCents: allowance,
      // Renewal forgives any outstanding overage — full allowance, never reduced.
      debtCents: 0,
      monthlyPeriodStart: new Date(1_700_000_000 * 1000),
      monthlyPeriodEnd: new Date(1_702_592_000 * 1000),
    });
  });

  it('invoice.paid accumulates: adds allowance on top of carried monthly balance (rollover)', async () => {
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    const cap: Captured = {};
    // 600 cents carried from the previous period → 600 + pro allowance.
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb(refillTx(cap, [{ id: 'led_rollover' }], 600));
    });

    await applyStripeFunding(invoiceEvent);

    const allowance = TIER_MONTHLY_ALLOWANCE_CENTS.pro;
    expect(cap.balanceSet).toMatchObject({
      monthlyRemainingCents: 600 + allowance,
      monthlyAllowanceCents: allowance,
      debtCents: 0,
    });
  });

  it('credit-pack checkout adds to the existing top-up bucket and writes a topup_purchase row', async () => {
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    const cap: Captured = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      // existing top-up balance of 1000 cents, locked for update
      await cb(topupTx(cap, [{ id: 'led_2' }], 1000));
    });

    await applyStripeFunding(topupEvent);

    expect(cap.ledgerValues).toMatchObject({
      userId: 'u1',
      entryType: 'topup_purchase',
      bucket: 'topup',
      amountCents: 2500,
      stripeRef: 'cs_123',
      consumeStatus: 'applied', // settled on insert; not swept/clawed back by backfill
    });
    // No debt: applyPaymentToDebt(0, 1000, 2500) -> top-up 1000 + 2500 = 3500, debt 0.
    expect(cap.balanceSet).toEqual({ topupRemainingCents: 3500, debtCents: 0 });
  });

  it('credit-pack checkout pays down outstanding debt FIRST, then credits the remainder to top-up', async () => {
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    const cap: Captured = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      // owe 1000 in debt, 0 top-up; a $25 pack pays the 1000 debt then banks 1500.
      await cb(topupTx(cap, [{ id: 'led_debt' }], 0, 1000));
    });

    await applyStripeFunding(topupEvent);

    expect(cap.balanceSet).toEqual({ topupRemainingCents: 1500, debtCents: 0 });
  });

  it('credit-pack checkout smaller than the debt reduces debt and adds nothing to top-up', async () => {
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    const cap: Captured = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      // owe 5000, a $25 pack only chips 2500 off the debt; top-up stays 0.
      await cb(topupTx(cap, [{ id: 'led_partial' }], 0, 5000));
    });

    await applyStripeFunding(topupEvent);

    expect(cap.balanceSet).toEqual({ topupRemainingCents: 0, debtCents: 2500 });
  });

  it('credit-pack checkout for a first-time buyer (no balance row) credits the full pack, race-safe', async () => {
    // Regression guard: the path ensures a balance row exists, then reads it under
    // FOR UPDATE, so two concurrent first purchases can't both read 0 and clobber
    // each other. Here the freshly-ensured row reads 0 debt / 0 top-up ->
    // applyPaymentToDebt(0, 0, 2500) credits the full 2500 to top-up.
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    const cap: Captured = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb(topupTx(cap, [{ id: 'led_3' }], 0));
    });

    await applyStripeFunding(topupEvent);

    expect(cap.balanceSet).toEqual({ topupRemainingCents: 2500, debtCents: 0 });
  });

  it('resolves a first-time credit-pack buyer from trusted session metadata.userId when the customer is unlinked', async () => {
    // resolveUser-by-customer is never reached; the buyer is found via metadata.userId.
    mockDb.select.mockReturnValue(userSelectReturning([{ id: 'u1', subscriptionTier: 'free' }]));
    const cap: Captured = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb(topupTx(cap, [{ id: 'led_meta' }], 0));
    });

    await applyStripeFunding(unlinkedTopupEvent);

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(cap.ledgerValues).toMatchObject({
      userId: 'u1',
      entryType: 'topup_purchase',
      stripeRef: 'cs_meta',
      consumeStatus: 'applied',
    });
    expect(cap.balanceSet).toEqual({ topupRemainingCents: 2500, debtCents: 0 });
  });

  it('invoice.paid uses the tier passed by the caller (invoice-derived) over a stale stored tier', async () => {
    // Race: invoice.paid lands before the subscription webhook upgraded users.tier,
    // so the stored tier is still 'free'. The webhook derives the real tier from the
    // paid invoice line and passes it; the refill must grant the PAID allowance.
    mockDb.select.mockReturnValue(userSelectReturning([{ id: 'u1', subscriptionTier: 'free' }]));
    const cap: Captured = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb(refillTx(cap, [{ id: 'led_tier' }], 0));
    });

    await applyStripeFunding(invoiceEvent, { tier: 'business' });

    const allowance = TIER_MONTHLY_ALLOWANCE_CENTS.business;
    expect(cap.ledgerValues).toMatchObject({ amountCents: allowance });
    expect(cap.balanceSet).toMatchObject({
      monthlyRemainingCents: allowance,
      monthlyAllowanceCents: allowance,
    });
  });

  it('declares the partial-index predicate as the ON CONFLICT arbiter on the funding ledger insert', async () => {
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    const cap: Captured = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb(refillTx(cap, [{ id: 'led_1' }], 0));
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

  it('rethrows a genuine funding failure (logged) so the webhook can let Stripe redeliver', async () => {
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    mockDb.transaction.mockRejectedValueOnce(new Error('db boom'));
    await expect(applyStripeFunding(invoiceEvent)).rejects.toThrow('db boom');
    expect(mockApiLogger.error).toHaveBeenCalled();
  });

  it('does NOT throw for non-actionable cases (unknown customer, ignored, billing-disabled)', async () => {
    // "Nothing to do" must not look like a failure — otherwise the webhook would
    // needlessly clear the idempotency marker and 500 on a no-op.
    mockDb.select.mockReturnValue(userSelectReturning([])); // no user
    await expect(applyStripeFunding(invoiceEvent)).resolves.toBeUndefined();
    await expect(applyStripeFunding(subscriptionCheckoutEvent)).resolves.toBeUndefined(); // ignored
    mockIsBillingEnabled.mockReturnValue(false);
    await expect(applyStripeFunding(invoiceEvent)).resolves.toBeUndefined(); // billing disabled
  });

  it('skips funding (and never opens a transaction) when no user matches the Stripe customer', async () => {
    mockDb.select.mockReturnValue(userSelectReturning([]));
    await applyStripeFunding(invoiceEvent);
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalled();
  });
});
