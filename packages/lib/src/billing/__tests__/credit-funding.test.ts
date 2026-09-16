import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const mockIsBillingEnabled = vi.hoisted(() => vi.fn(() => true));
const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  transaction: vi.fn(),
}));
const mockApiLogger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/schema/credits', () => ({
  creditBalances: { userId: 'cb.userId', topupRemainingCents: 'cb.topup', debtCents: 'cb.debt' },
  creditLedger: { id: 'cl.id', stripeRef: 'cl.stripeRef' },
}));
vi.mock('@pagespace/db/schema/subscriptions', () => ({
  subscriptions: { userId: 's.userId', gifted: 's.gifted', status: 's.status' },
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
import { tierAllowanceCents, allowanceCentsForPaidCents, tierListPriceCents } from '../money-model';

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
// Includes the .for('update') call that locks the row before the rollover write.
function balanceSelectReturning(monthlyRemainingCents: number, debtCents = 0) {
  const result = Promise.resolve([{ monthlyRemainingCents, debtCents }]);
  return { from: () => ({ where: () => ({ for: () => ({ limit: () => result }), limit: () => result }) }) };
}

// tx for the monthly refill path: ledger insert -> stub-row insert -> select current balance -> balance upsert.
function refillTx(cap: Captured, ledgerReturned: Array<{ id: string }>, currentRemaining: number, currentDebt = 0) {
  return {
    insert: vi.fn()
      .mockReturnValueOnce(ledgerInsert(ledgerReturned, cap))
      .mockReturnValueOnce(ensureRowInsert())   // stub: INSERT ... ON CONFLICT DO NOTHING
      .mockReturnValueOnce(balanceUpsert(cap)),
    select: vi.fn().mockReturnValueOnce(balanceSelectReturning(currentRemaining, currentDebt)),
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

// resolveUser(): db.select({...}).from(users).where(...).limit(1) -> rows.
// The same chain also answers isGiftedSubscriber()'s db.select().from().where()
// (awaited without limit) when a test sets it as the persistent return value: user
// rows carry no `gifted`, so the subscriber reads as not gifted.
function userSelectReturning(rows: Array<Record<string, unknown>>) {
  const where = () => Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) });
  return { from: () => ({ where }) };
}

// Queue the user lookup, then the subscriptions lookup (gifted / status rows).
function selectUserThenSubscriptions(user: Array<Record<string, unknown>>, subs: Array<{ gifted: boolean; status: string }>) {
  mockDb.select.mockReset();
  mockDb.select.mockReturnValueOnce(userSelectReturning(user)).mockReturnValueOnce(userSelectReturning(subs));
}

// Capture a top-level (non-tx) ledger insert — the missed_grant row.
function missedGrantInsert(cap: Captured) {
  return {
    values: (v: Record<string, unknown>) => {
      cap.ledgerValues = v;
      return { onConflictDoNothing: (arb: { target?: unknown; where?: unknown }) => { cap.arbiter = arb; return Promise.resolve(undefined); } };
    },
  };
}

const PRO_USER = [{ id: 'u1', subscriptionTier: 'pro' }];

// billing_reason defaults to 'subscription_cycle' — an ordinary renewal — since
// that is what nearly every fixture in this file represents; the SECURITY tests
// below override it explicitly to exercise every other reason.
// A real subscription parent, present by default — every fixture here represents
// an ordinary renewal unless a test explicitly overrides `parent` (the manual/
// parentless-invoice SECURITY tests set `parent: undefined`).
const REAL_SUBSCRIPTION_PARENT = { subscription_details: { subscription: 'sub_test_1' } };

const invoiceEvent = {
  id: 'evt_inv',
  type: 'invoice.paid',
  data: {
    object: {
      id: 'in_123',
      customer: 'cus_1',
      amount_paid: 1500,
      billing_reason: 'subscription_cycle',
      parent: REAL_SUBSCRIPTION_PARENT,
      period_start: 1_700_000_000,
      period_end: 1_702_592_000,
    },
  },
};

// Same invoice shape with a different amount actually paid (promo, proration, $0 trial start).
function paidInvoiceEvent(amountPaid: number | undefined, extra: Record<string, unknown> = {}) {
  return {
    id: 'evt_inv',
    type: 'invoice.paid',
    data: {
      object: {
        id: 'in_123',
        customer: 'cus_1',
        amount_paid: amountPaid,
        billing_reason: 'subscription_cycle',
        parent: REAL_SUBSCRIPTION_PARENT,
        period_start: 1_700_000_000,
        period_end: 1_702_592_000,
        ...extra,
      },
    },
  };
}

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

    // Flag off: 100% of the $15 paid = today's Pro allowance.
    const allowance = tierAllowanceCents('pro');
    expect(allowance).toBe(1500);
    expect(cap.ledgerValues).toMatchObject({
      userId: 'u1',
      entryType: 'monthly_grant',
      bucket: 'monthly',
      amountCents: allowance,
      // MON-2: what the invoice paid is recorded on the grant row.
      paidCents: 1500,
      stripeRef: 'in_123',
      // Must be settled on insert: a 'pending' grant would be clawed back by the
      // backfill cron's pending-usage sweep (settlePendingLedgerRow subtracts it).
      consumeStatus: 'applied',
    });
    expect(cap.balanceSet).toEqual({
      monthlyRemainingCents: allowance,
      monthlyAllowanceCents: allowance,
      // Zero debt: full allowance passes through — net = (0 − 0) + allowance = allowance.
      debtCents: 0,
      monthlyPeriodStart: new Date(1_700_000_000 * 1000),
      monthlyPeriodEnd: new Date(1_702_592_000 * 1000),
    });
  });

  it('invoice.paid stamps the LINE-ITEM service period, not the invoice-level fields (which describe the just-ended cycle)', async () => {
    // Stripe renewal invoices: invoice.period_start/end = the cycle that just ENDED;
    // the NEW service period being paid for lives on the line item. Stamping the
    // invoice-level fields froze every subscriber's window at "already expired"
    // (2026-07-07 audit: all 4 live subscribers stale immediately after renewal).
    const OLD_START = 1_697_000_000; // just-ended cycle
    const OLD_END = 1_700_000_000;
    const NEW_START = 1_700_000_000; // service period actually paid for
    const NEW_END = 1_702_592_000;
    const renewalEvent = {
      id: 'evt_renewal',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_renewal',
          customer: 'cus_1',
          amount_paid: 1500,
          billing_reason: 'subscription_cycle',
          parent: REAL_SUBSCRIPTION_PARENT,
          period_start: OLD_START,
          period_end: OLD_END,
          lines: { data: [{ period: { start: NEW_START, end: NEW_END } }] },
        },
      },
    };
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    const cap: Captured = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb(refillTx(cap, [{ id: 'led_renewal' }], 0));
    });

    await applyStripeFunding(renewalEvent);

    expect(cap.balanceSet).toMatchObject({
      monthlyPeriodStart: new Date(NEW_START * 1000),
      monthlyPeriodEnd: new Date(NEW_END * 1000),
    });
  });

  it('invoice.paid with multiple lines (plan-change proration) stamps the line with the LATEST period end', async () => {
    const prorationLine = { period: { start: 1_699_000_000, end: 1_700_000_000 } }; // old plan remainder
    const newPlanLine = { period: { start: 1_700_000_000, end: 1_702_592_000 } }; // new plan's full period
    const planChangeEvent = {
      id: 'evt_change',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_change',
          customer: 'cus_1',
          amount_paid: 1500,
          billing_reason: 'subscription_cycle',
          parent: REAL_SUBSCRIPTION_PARENT,
          period_start: 1_697_000_000,
          period_end: 1_700_000_000,
          lines: { data: [prorationLine, newPlanLine] },
        },
      },
    };
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    const cap: Captured = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb(refillTx(cap, [{ id: 'led_change' }], 0));
    });

    await applyStripeFunding(planChangeEvent);

    expect(cap.balanceSet).toMatchObject({
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

    const allowance = tierAllowanceCents('pro');
    expect(cap.balanceSet).toMatchObject({
      monthlyRemainingCents: 600 + allowance,
      monthlyAllowanceCents: allowance,
      debtCents: 0,
    });
  });

  it('invoice.paid nets outstanding debt against carried balance (debt absorbed, not forwarded)', async () => {
    mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
    const cap: Captured = {};
    // 200¢ carried, 200¢ debt → net = 200 − 200 = 0; monthly = 0 + pro allowance.
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb(refillTx(cap, [{ id: 'led_debt_refill' }], 200, 200));
    });

    await applyStripeFunding(invoiceEvent);

    const allowance = tierAllowanceCents('pro');
    expect(cap.balanceSet).toMatchObject({
      monthlyRemainingCents: allowance,
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

    // A Business invoice: what it paid is the Business list price.
    await applyStripeFunding(paidInvoiceEvent(tierAllowanceCents('business')), { tier: 'business' });

    const allowance = tierAllowanceCents('business');
    expect(allowance).not.toBe(tierAllowanceCents('free'));
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

  it('MON-2 is exactly-once: a redelivered event whose grant row already exists does not touch the balance', async () => {
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

  describe('grants sized from the invoice paid (MON-2)', () => {
    function refill(cap: Captured, carried = 0, debt = 0) {
      mockDb.select.mockReturnValue(userSelectReturning(PRO_USER));
      mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
        await cb(refillTx(cap, [{ id: 'led_v2' }], carried, debt));
      });
    }

    // D-OW-17: applyStripeFunding calls grantForInvoice/allowanceCentsForPaidCents
    // with no `active` argument, so it always uses the money-model default
    // (MONEY_MODEL_V2_ACTIVE = false in this PR — the legacy 100% pass-through).
    // The ratio math itself, at BOTH active=true and active=false, is covered
    // directly (no shell, no mocks) in money-model.test.ts and invoice-grant.test.ts;
    // these tests only prove the funding shell wires amount_paid through correctly.
    it('MON-2 sizes the grant as amount_paid × the default ratio, not the tier list price, and records paidCents on the ledger row', async () => {
      const cap: Captured = {};
      refill(cap);

      await applyStripeFunding(paidInvoiceEvent(1500), { tier: 'pro' });

      const expected = allowanceCentsForPaidCents(1500, 'pro');
      expect(expected).toBe(1500);
      expect(cap.ledgerValues).toMatchObject({
        entryType: 'monthly_grant',
        amountCents: expected,
        paidCents: 1500,
        stripeRef: 'in_123',
      });
      expect(cap.balanceSet).toMatchObject({ monthlyRemainingCents: expected, monthlyAllowanceCents: expected });
    });

    it('D-OW-17 test seam: passing { active: true } through applyStripeFunding actually applies the 60% ratio, proving the shell does not just pass amount_paid straight through', async () => {
      // Distinguishes "the shell wires the ratio math" from "the shell forwards
      // paidCents" — with the constant false (default), both look identical
      // (100% pass-through). `active` is a test-only override on FundingOptions
      // (never set by the real webhook route); reverting the `active` plumbing
      // in credit-funding.ts, or the `active ? ratio : LEGACY_RATIO` branch in
      // money-model.ts, makes this assertion fail while every default-flag test
      // above stays green.
      const cap: Captured = {};
      refill(cap);

      await applyStripeFunding(paidInvoiceEvent(1500), { tier: 'pro', active: true });

      const expected = allowanceCentsForPaidCents(1500, 'pro', true);
      expect(expected).toBe(900);
      expect(cap.ledgerValues).toMatchObject({ entryType: 'monthly_grant', amountCents: 900, paidCents: 1500 });
      expect(cap.balanceSet).toMatchObject({ monthlyRemainingCents: 900, monthlyAllowanceCents: 900 });
    });

    it('MON-2 a 50%-off invoice grants half the list grant', async () => {
      const cap: Captured = {};
      refill(cap);

      await applyStripeFunding(paidInvoiceEvent(750), { tier: 'pro' });

      const full = allowanceCentsForPaidCents(1500, 'pro');
      expect(cap.ledgerValues).toMatchObject({ amountCents: full / 2, paidCents: 750 });
      expect(cap.balanceSet).toMatchObject({ monthlyRemainingCents: full / 2, monthlyAllowanceCents: full / 2 });
    });

    it('MON-2 the derived grant still rolls over: carried balance and debt are netted before the grant is added', async () => {
      const cap: Captured = {};
      refill(cap, 400, 100);

      await applyStripeFunding(paidInvoiceEvent(1500), { tier: 'pro' });

      const grant = allowanceCentsForPaidCents(1500, 'pro');
      expect(cap.balanceSet).toMatchObject({ monthlyRemainingCents: 400 - 100 + grant, debtCents: 0 });
    });

    it('MON-2 a zero-amount invoice grants nothing: no ledger row, no balance write, no transaction', async () => {
      const cap: Captured = {};
      refill(cap);

      await applyStripeFunding(paidInvoiceEvent(0), { tier: 'pro' });

      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(cap.ledgerValues).toBeUndefined();
      expect(cap.balanceSet).toBeUndefined();
      expect(mockApiLogger.info).toHaveBeenCalledWith(
        'credit funding: invoice grants nothing',
        expect.objectContaining({ userId: 'u1', paidCents: 0, stripeRef: 'in_123', reason: 'zero_amount' }),
      );
    });

    it('MON-2 an invoice with no amount_paid fails closed (nothing granted)', async () => {
      const cap: Captured = {};
      refill(cap);

      await applyStripeFunding(paidInvoiceEvent(undefined), { tier: 'pro' });

      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(cap.ledgerValues).toBeUndefined();
    });

    it('MON-2 a PAID invoice whose tier resolves to free (no ratio) fails closed, logs at ERROR, and writes a missed_grant row keyed on the invoice', async () => {
      mockDb.select.mockReturnValue(userSelectReturning([{ id: 'u1', subscriptionTier: 'free' }]));
      const cap: Captured = {};
      mockDb.insert.mockReturnValueOnce(missedGrantInsert(cap));
      mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
        await cb(refillTx(cap, [{ id: 'led_x' }], 0));
      });

      await applyStripeFunding(paidInvoiceEvent(1500)); // no invoice-derived tier, stored tier still free

      expect(mockDb.transaction).not.toHaveBeenCalled(); // no balance change
      expect(mockApiLogger.error).toHaveBeenCalledWith(
        'credit funding: MISSED grant — paid invoice resolved to a tier with no ratio',
        undefined,
        expect.objectContaining({ eventId: 'evt_inv', invoiceId: 'in_123', userId: 'u1', storedTier: 'free', paidCents: 1500 }),
      );
      expect(cap.ledgerValues).toMatchObject({
        userId: 'u1',
        entryType: 'missed_grant',
        bucket: 'monthly',
        amountCents: 0,
        paidCents: 1500,
        stripeRef: 'in_123',
        consumeStatus: 'applied',
      });
      // Dedupes on the invoice like a grant does, so a redelivery cannot double-record it.
      expect(cap.arbiter).toHaveProperty('target');
    });

    describe('D-OW-16: grants we deliberately fund', () => {
      it('MON-2 (a) a gifted subscription grants list price × the default ratio although it paid nothing', async () => {
        selectUserThenSubscriptions(PRO_USER, [{ gifted: true, status: 'active' }]);
        const cap: Captured = {};
        mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
          await cb(refillTx(cap, [{ id: 'led_gift' }], 0));
        });

        await applyStripeFunding(paidInvoiceEvent(0, { subtotal: 1500, billing_reason: 'subscription_cycle' }), { tier: 'pro' });

        const list = allowanceCentsForPaidCents(tierListPriceCents('pro'), 'pro');
        expect(list).toBe(1500);
        expect(cap.ledgerValues).toMatchObject({ amountCents: list, paidCents: 0, stripeRef: 'in_123' });
        expect(cap.balanceSet).toMatchObject({ monthlyRemainingCents: list, monthlyAllowanceCents: list });
        expect(mockApiLogger.info).toHaveBeenCalledWith(
          'credit funding: monthly refill applied',
          expect.objectContaining({ basis: 'list', reason: 'gifted', paidCents: 0 }),
        );
      });

      it('MON-2 (a) a subscription created with a trial (subscription_create, $0, subtotal 0) grants list price × the default ratio', async () => {
        selectUserThenSubscriptions(PRO_USER, [{ gifted: false, status: 'trialing' }]);
        const cap: Captured = {};
        mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
          await cb(refillTx(cap, [{ id: 'led_trial' }], 0));
        });

        await applyStripeFunding(paidInvoiceEvent(0, { subtotal: 0, billing_reason: 'subscription_create' }), { tier: 'pro' });

        expect(cap.ledgerValues).toMatchObject({ amountCents: 1500, paidCents: 0 });
        expect(mockApiLogger.info).toHaveBeenCalledWith(
          'credit funding: monthly refill applied',
          expect.objectContaining({ basis: 'list', reason: 'trial' }),
        );
      });

      it('MON-2 (b) a proration-only / subscription_update invoice that paid $0 grants nothing (subscription_update is grant-eligible as a KIND; $0 paid is $0 granted)', async () => {
        const cap: Captured = {};
        refill(cap);

        await applyStripeFunding(paidInvoiceEvent(0, { subtotal: 0, billing_reason: 'subscription_update' }), { tier: 'pro' });

        expect(mockDb.transaction).not.toHaveBeenCalled();
        expect(cap.ledgerValues).toBeUndefined();
        expect(mockApiLogger.info).toHaveBeenCalledWith(
          'credit funding: invoice grants nothing',
          expect.objectContaining({ reason: 'zero_amount' }),
        );
      });

      it('CORRECTION (Codex P1, "Allow paid subscription-update invoices to grant credits"): a PAID subscription_update invoice (a mid-cycle upgrade proration) grants proportional credits, unlike a manual invoice', async () => {
        const cap: Captured = {};
        refill(cap);

        await applyStripeFunding(paidInvoiceEvent(1000, { subtotal: 1000, billing_reason: 'subscription_update' }), { tier: 'business' });

        expect(cap.ledgerValues).toMatchObject({
          entryType: 'monthly_grant',
          paidCents: 1000,
          amountCents: allowanceCentsForPaidCents(1000, 'business'),
        });
        expect(cap.ledgerValues!.amountCents).toBeGreaterThan(0);
      });

      it('MON-2 (c) a partial discount grants from amount_paid: 20% off Pro → 1200 × the default ratio', async () => {
        const cap: Captured = {};
        refill(cap);

        await applyStripeFunding(paidInvoiceEvent(1200, { subtotal: 1500, billing_reason: 'subscription_cycle' }), { tier: 'pro' });

        expect(cap.ledgerValues).toMatchObject({ amountCents: allowanceCentsForPaidCents(1200, 'pro'), paidCents: 1200 });
        expect(allowanceCentsForPaidCents(1200, 'pro')).toBe(1200);
      });

      it('MON-2 (d) a 100% coupon on a NON-gifted subscription grants nothing — admin gifting is the door', async () => {
        selectUserThenSubscriptions(PRO_USER, [{ gifted: false, status: 'active' }]);
        const cap: Captured = {};
        mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
          await cb(refillTx(cap, [{ id: 'led_coupon' }], 0));
        });

        // subtotal is the list price, total/paid 0: a coupon, not a trial.
        await applyStripeFunding(paidInvoiceEvent(0, { subtotal: 1500, billing_reason: 'subscription_create' }), { tier: 'pro' });

        expect(mockDb.transaction).not.toHaveBeenCalled();
        expect(cap.ledgerValues).toBeUndefined();
      });
    });

    it('MON-2 / D-OW-17 a full-price invoice grants 100% of what it paid under the current default (MONEY_MODEL_V2_ACTIVE = false)', async () => {
      const cap: Captured = {};
      refill(cap);

      await applyStripeFunding(paidInvoiceEvent(1500), { tier: 'pro' });

      expect(cap.ledgerValues).toMatchObject({ amountCents: 1500, paidCents: 1500 });
    });
  });
});
