/**
 * credits-flow.integration.test — end-to-end proof of the prepaid AI-credits money
 * path. Unlike the per-shell unit tests (which hand-build a bespoke db chain for the
 * single function under test), this drives the REAL billing functions —
 * applyStripeFunding, canConsumeAI, consumeCredits, backfillCredits — wired together
 * over ONE shared in-memory database. Each test exercises fund → gate → consume →
 * reconcile as a sequence and asserts the balance + ledger after every stage, so a
 * regression in any single stage (e.g. a funding row left 'pending' and clawed back,
 * a lost sub-cent carry, a dropped shortfall) fails the whole-system contract here.
 *
 * The fake DB below is a faithful-enough model of the Drizzle surface these shells
 * use: insert/onConflict(DoNothing|DoUpdate)/returning, select/from/leftJoin/where/
 * limit/for('update'), update/set/where, and transaction(). It enforces the real
 * uniqueness arbiters (stripeRef, usage-scoped aiUsageLogId, balance userId) and the
 * balance CHECK invariants (cents >= 0, pendingMillicents in [0,1000)) so the tests
 * catch the exact bugs the remediation fixed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── A column reference the fake operators/select can resolve against a row ────────
type Col = { __col: true; table: TableKey; name: string };
type TableKey = 'creditBalances' | 'creditLedger' | 'users' | 'aiUsageLogs';

interface Row { [k: string]: unknown }
type Store = Record<TableKey, Row[]>;

type Pred =
  | { kind: 'eq'; col: Col; val: unknown }
  | { kind: 'lt'; col: Col; val: unknown }
  | { kind: 'gt'; col: Col; val: unknown }
  | { kind: 'isNull'; col: Col }
  | { kind: 'and'; parts: Pred[] }
  | { kind: 'or'; parts: Pred[] }
  | { kind: 'sql' };

// ── Hoisted shared state: one store + one fake db, shared by all four real shells ─
const H = vi.hoisted(() => {
  const store: Store = { creditBalances: [], creditLedger: [], users: [], aiUsageLogs: [] };

  const col = (table: TableKey, name: string): Col => ({ __col: true, table, name });
  const cols = (table: TableKey, names: string[]): Record<string, Col> & { __table: TableKey } => {
    const t: Record<string, unknown> = { __table: table };
    for (const n of names) t[n] = col(table, n);
    return t as Record<string, Col> & { __table: TableKey };
  };

  const creditBalances = cols('creditBalances', [
    'userId', 'monthlyRemainingCents', 'monthlyAllowanceCents', 'topupRemainingCents',
    'pendingMillicents', 'monthlyPeriodStart', 'monthlyPeriodEnd', 'updatedAt',
  ]);
  const creditLedger = cols('creditLedger', [
    'id', 'userId', 'entryType', 'bucket', 'amountCents', 'appliedCents', 'chargeMillicents',
    'aiUsageLogId', 'realCostCents', 'markupBps', 'stripeRef', 'consumeStatus', 'createdAt',
  ]);
  const users = cols('users', ['id', 'stripeCustomerId', 'subscriptionTier']);
  const aiUsageLogs = cols('aiUsageLogs', ['id', 'userId', 'cost', 'timestamp', 'success']);

  // ── operators ───────────────────────────────────────────────────────────────
  const eq = (col: Col, val: unknown): Pred => ({ kind: 'eq', col, val });
  const lt = (col: Col, val: unknown): Pred => ({ kind: 'lt', col, val });
  const gt = (col: Col, val: unknown): Pred => ({ kind: 'gt', col, val });
  const isNull = (col: Col): Pred => ({ kind: 'isNull', col });
  const and = (...parts: Pred[]): Pred => ({ kind: 'and', parts });
  const or = (...parts: Pred[]): Pred => ({ kind: 'or', parts });
  const sqlTag = (): Pred => ({ kind: 'sql' });

  // ── predicate evaluation against a join context {tableKey: row | null} ────────
  type Ctx = Partial<Record<TableKey, Row | null>>;
  const resolve = (c: Col, ctx: Ctx): unknown => {
    const r = ctx[c.table];
    return r ? r[c.name] : undefined;
  };
  const num = (v: unknown): number => (v instanceof Date ? v.getTime() : (v as number));
  const isCol = (v: unknown): v is Col => typeof v === 'object' && v !== null && (v as Col).__col === true;
  // An operand may be a literal OR another column (join conditions compare two columns).
  const operand = (v: unknown, ctx: Ctx): unknown => (isCol(v) ? resolve(v, ctx) : v);
  const evalPred = (p: Pred | undefined, ctx: Ctx): boolean => {
    if (!p) return true;
    switch (p.kind) {
      case 'eq': return resolve(p.col, ctx) === operand(p.val, ctx);
      case 'lt': { const a = resolve(p.col, ctx); const b = operand(p.val, ctx); return a != null && b != null && num(a) < num(b); }
      case 'gt': { const a = resolve(p.col, ctx); const b = operand(p.val, ctx); return a != null && b != null && num(a) > num(b); }
      case 'isNull': return resolve(p.col, ctx) == null;
      case 'and': return p.parts.every((q) => evalPred(q, ctx));
      case 'or': return p.parts.some((q) => evalPred(q, ctx));
      case 'sql': return true;
    }
  };

  // ── id generator (deterministic; not Date/random) ─────────────────────────────
  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}_${++seq}`;

  const applyDefaults = (table: TableKey, v: Row): Row => {
    if (table === 'creditLedger') {
      return {
        appliedCents: null, chargeMillicents: null, aiUsageLogId: null, realCostCents: null,
        stripeRef: null, markupBps: 15000, consumeStatus: 'pending',
        id: nextId('led'), createdAt: new Date(),
        ...v,
      };
    }
    if (table === 'creditBalances') {
      return {
        monthlyRemainingCents: 0, monthlyAllowanceCents: 0, topupRemainingCents: 0,
        pendingMillicents: 0, monthlyPeriodStart: null, monthlyPeriodEnd: null,
        updatedAt: new Date(),
        ...v,
      };
    }
    return { ...v };
  };

  // Detect an existing row that collides with `row` under the conflict arbiter
  // implied by `target`. Mirrors the real partial unique indexes.
  const conflictRow = (table: TableKey, target: Col, row: Row): Row | undefined => {
    if (table === 'creditBalances' && target.name === 'userId') {
      return store.creditBalances.find((r) => r.userId === row.userId);
    }
    if (table === 'creditLedger' && target.name === 'stripeRef') {
      return row.stripeRef == null
        ? undefined
        : store.creditLedger.find((r) => r.stripeRef === row.stripeRef);
    }
    if (table === 'creditLedger' && target.name === 'aiUsageLogId') {
      return row.aiUsageLogId == null
        ? undefined
        : store.creditLedger.find((r) => r.aiUsageLogId === row.aiUsageLogId && r.entryType === 'usage');
    }
    return undefined;
  };

  const enforceBalanceInvariants = (r: Row): void => {
    for (const f of ['monthlyRemainingCents', 'monthlyAllowanceCents', 'topupRemainingCents']) {
      if ((r[f] as number) < 0) throw new Error(`CHECK violation: ${f} < 0 (${r[f]})`);
    }
    const pm = r.pendingMillicents as number;
    if (pm < 0 || pm >= 1000) throw new Error(`CHECK violation: pendingMillicents out of range (${pm})`);
  };

  const project = (proj: Record<string, Col> | undefined, ctx: Ctx, primary: Row): Row => {
    if (!proj) return primary;
    const out: Row = {};
    for (const [alias, c] of Object.entries(proj)) out[alias] = resolve(c, ctx);
    return out;
  };

  // ── select builder ────────────────────────────────────────────────────────────
  function makeSelect(proj?: Record<string, Col>) {
    let baseKey: TableKey;
    let joinKey: TableKey | undefined;
    let joinPred: Pred | undefined;
    let wherePred: Pred | undefined;

    const run = (limit?: number): Row[] => {
      const contexts: { ctx: Ctx; primary: Row }[] = [];
      for (const base of store[baseKey]) {
        if (joinKey) {
          const matches = store[joinKey].filter((cand) =>
            evalPred(joinPred, { [baseKey]: base, [joinKey!]: cand } as Ctx));
          if (matches.length === 0) {
            contexts.push({ ctx: { [baseKey]: base, [joinKey]: null } as Ctx, primary: base });
          } else {
            for (const m of matches) contexts.push({ ctx: { [baseKey]: base, [joinKey]: m } as Ctx, primary: base });
          }
        } else {
          contexts.push({ ctx: { [baseKey]: base } as Ctx, primary: base });
        }
      }
      const filtered = contexts.filter((c) => evalPred(wherePred, c.ctx));
      const limited = limit == null ? filtered : filtered.slice(0, limit);
      return limited.map((c) => project(proj, c.ctx, c.primary));
    };

    const api = {
      from(tbl: { __table: TableKey }) { baseKey = tbl.__table; return api; },
      leftJoin(tbl: { __table: TableKey }, on: Pred) { joinKey = tbl.__table; joinPred = on; return api; },
      where(p: Pred) { wherePred = p; return api; },
      limit(n: number) { return Promise.resolve(run(n)); },
      for(_mode: string) { return Promise.resolve(run()); },
    };
    return api;
  }

  // ── insert builder ────────────────────────────────────────────────────────────
  function makeInsert(tbl: { __table: TableKey }) {
    const table = tbl.__table;
    return {
      values(v: Row) {
        const row = applyDefaults(table, v);
        let done = false;

        const plainInsert = (): Row => {
          if (done) return row; done = true;
          if (table === 'creditBalances') enforceBalanceInvariants(row);
          store[table].push(row);
          return row;
        };

        // insert ... on conflict do nothing [returning]
        const onConflictDoNothing = (arb?: { target?: Col; where?: Pred }) => {
          let inserted: Row | undefined;
          const exec = (): Row[] => {
            if (done) return inserted ? [inserted] : [];
            done = true;
            const target = arb?.target;
            const clash = target ? conflictRow(table, target, row) : undefined;
            if (clash) return [];
            if (table === 'creditBalances') enforceBalanceInvariants(row);
            store[table].push(row);
            inserted = row;
            return [row];
          };
          return {
            returning(proj?: Record<string, Col>) {
              const rows = exec();
              return Promise.resolve(rows.map((r) => project(proj, { [table]: r } as Ctx, r)));
            },
            then(res: (v: unknown) => void, rej?: (e: unknown) => void) {
              try { exec(); res(undefined); } catch (e) { rej?.(e); }
            },
          };
        };

        // insert ... on conflict do update (upsert by target)
        const onConflictDoUpdate = ({ target, set }: { target: Col; set: Row }) => {
          if (done) return Promise.resolve(undefined); done = true;
          const clash = conflictRow(table, target, row);
          if (clash) {
            Object.assign(clash, set);
            if (table === 'creditBalances') enforceBalanceInvariants(clash);
          } else {
            if (table === 'creditBalances') enforceBalanceInvariants(row);
            store[table].push(row);
          }
          return Promise.resolve(undefined);
        };

        return {
          onConflictDoNothing,
          onConflictDoUpdate,
          // bare `await insert.values(...)` (e.g. the debt adjustment row)
          then(res: (v: unknown) => void, rej?: (e: unknown) => void) {
            try { plainInsert(); res(undefined); } catch (e) { rej?.(e); }
          },
        };
      },
    };
  }

  // ── update builder ────────────────────────────────────────────────────────────
  function makeUpdate(tbl: { __table: TableKey }) {
    const table = tbl.__table;
    return {
      set(v: Row) {
        return {
          where(p: Pred) {
            for (const r of store[table]) {
              if (evalPred(p, { [table]: r } as Ctx)) {
                Object.assign(r, v);
                if (table === 'creditBalances') enforceBalanceInvariants(r);
              }
            }
            return Promise.resolve(undefined);
          },
        };
      },
    };
  }

  const db = {
    select: (proj?: Record<string, Col>) => makeSelect(proj),
    insert: (tbl: { __table: TableKey }) => makeInsert(tbl),
    update: (tbl: { __table: TableKey }) => makeUpdate(tbl),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  };

  const isBillingEnabled = vi.fn(() => true);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  return {
    store, db, isBillingEnabled, logger,
    schema: { creditBalances, creditLedger, users, aiUsageLogs },
    ops: { eq, lt, gt, isNull, and, or, sql: sqlTag },
  };
});

vi.mock('@pagespace/db/db', () => ({ db: H.db }));
vi.mock('@pagespace/db/schema/credits', () => ({ creditBalances: H.schema.creditBalances, creditLedger: H.schema.creditLedger }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: H.schema.users }));
vi.mock('@pagespace/db/schema/monitoring', () => ({ aiUsageLogs: H.schema.aiUsageLogs }));
vi.mock('@pagespace/db/operators', () => H.ops);
vi.mock('../../deployment-mode', () => ({ isBillingEnabled: H.isBillingEnabled }));
vi.mock('../../logging/logger-config', () => ({ loggers: { api: H.logger, ai: H.logger } }));

import { applyStripeFunding } from '../credit-funding';
import { canConsumeAI } from '../credit-gate';
import { consumeCredits } from '../credit-consume';
import { backfillCredits } from '../credit-backfill';
import {
  TIER_MONTHLY_ALLOWANCE_CENTS,
  RESERVE_FLOOR_CENTS,
  MARKUP_BPS,
} from '../credit-pricing';

// ── test helpers over the shared store ──────────────────────────────────────────
const store = H.store;

function reset() {
  store.creditBalances.length = 0;
  store.creditLedger.length = 0;
  store.users.length = 0;
  store.aiUsageLogs.length = 0;
}

function seedUser(id: string, customer: string, tier: string) {
  store.users.push({ id, stripeCustomerId: customer, subscriptionTier: tier });
}

function balanceOf(userId: string) {
  return store.creditBalances.find((r) => r.userId === userId) as
    | { monthlyRemainingCents: number; topupRemainingCents: number; pendingMillicents: number; monthlyPeriodEnd: Date | null }
    | undefined;
}

function ledgerOf(userId: string) {
  return store.creditLedger.filter((r) => r.userId === userId);
}

/** Whole cents a single call costs given a starting carry, mirroring credit-core. */
function chargeMc(costDollars: number): number {
  return Math.round(costDollars * (MARKUP_BPS / 10000) * 100_000);
}

const invoicePaid = (id: string, customer: string, periodStart: number, periodEnd: number) => ({
  id: `evt_${id}`,
  type: 'invoice.paid',
  data: { object: { id, customer, period_start: periodStart, period_end: periodEnd } },
});

const creditPackCheckout = (id: string, customer: string, packCents: number) => ({
  id: `evt_${id}`,
  type: 'checkout.session.completed',
  data: { object: { id, customer, mode: 'payment', metadata: { kind: 'credit_pack', packCents: String(packCents) } } },
});

// Relative to "now" so the funded window is ALWAYS active during the test. A
// hardcoded past window would expire and let the gate-driven reset refill the
// bucket mid-test, making the drawdown→out_of_credits assertions time-dependent.
const PERIOD_START = Math.floor(Date.now() / 1000);
const PERIOD_END = PERIOD_START + 30 * 24 * 60 * 60; // 30 days ahead

beforeEach(() => {
  reset();
  vi.clearAllMocks();
  H.isBillingEnabled.mockReturnValue(true);
});

describe('credits flow — happy path (fund → gate → consume → top-up → drained)', () => {
  it('funds $5/mo, draws monthly-first, accepts a top-up, then blocks at out_of_credits', async () => {
    seedUser('u1', 'cus_1', 'free'); // free tier = 500¢ monthly allowance

    // ── FUND: invoice.paid grants the monthly allowance and sets the period ──────
    await applyStripeFunding(invoicePaid('in_1', 'cus_1', PERIOD_START, PERIOD_END));
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(TIER_MONTHLY_ALLOWANCE_CENTS.free); // 500
    expect(balanceOf('u1')!.topupRemainingCents).toBe(0);
    const grants = ledgerOf('u1').filter((r) => r.entryType === 'monthly_grant');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ stripeRef: 'in_1', amountCents: 500, consumeStatus: 'applied' });

    // ── GATE: spendable 500 > reserve floor 25 → allowed ────────────────────────
    expect(await canConsumeAI('u1', 'free')).toEqual({ allowed: true, reason: 'ok' });

    // ── CONSUME: $2 then $1 of real cost, monthly-first ─────────────────────────
    await consumeCredits({ aiUsageLogId: 'log_1', userId: 'u1', costDollars: 2 }); // 300¢
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(200);
    await consumeCredits({ aiUsageLogId: 'log_2', userId: 'u1', costDollars: 1 }); // 150¢
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(50);
    expect(await canConsumeAI('u1', 'free')).toEqual({ allowed: true, reason: 'ok' }); // 50 > 25

    // ── TOP-UP: a $10 credit pack adds to the never-expiring top-up bucket ───────
    await applyStripeFunding(creditPackCheckout('cs_1', 'cus_1', 1000));
    expect(balanceOf('u1')!.topupRemainingCents).toBe(1000);
    expect(ledgerOf('u1').filter((r) => r.entryType === 'topup_purchase')).toHaveLength(1);

    // ── CONSUME across the bucket boundary: $0.50 spends the last 50¢ monthly + 25¢ top-up
    await consumeCredits({ aiUsageLogId: 'log_3', userId: 'u1', costDollars: 0.5 }); // 75¢
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(0);
    expect(balanceOf('u1')!.topupRemainingCents).toBe(975);

    // ── DRAIN: a $6.50 call empties the top-up bucket exactly ───────────────────
    await consumeCredits({ aiUsageLogId: 'log_4', userId: 'u1', costDollars: 6.5 }); // 975¢
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(0);
    expect(balanceOf('u1')!.topupRemainingCents).toBe(0);

    // ── GATE: drained → out_of_credits ──────────────────────────────────────────
    expect(await canConsumeAI('u1', 'free')).toEqual({ allowed: false, reason: 'out_of_credits' });

    // Ledger sanity: 4 usage rows, 1 grant, 1 purchase, no debt (every call covered).
    expect(ledgerOf('u1').filter((r) => r.entryType === 'usage')).toHaveLength(4);
    expect(ledgerOf('u1').filter((r) => r.entryType === 'adjustment')).toHaveLength(0);
  });
});

describe('credits flow — idempotency', () => {
  it('consuming the same aiUsageLogId twice debits exactly once', async () => {
    seedUser('u1', 'cus_1', 'free');
    await applyStripeFunding(invoicePaid('in_1', 'cus_1', PERIOD_START, PERIOD_END));

    await consumeCredits({ aiUsageLogId: 'log_dup', userId: 'u1', costDollars: 1 }); // 150¢
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(350);

    // Redelivered/retried with the same usage id — the unique claim short-circuits.
    await consumeCredits({ aiUsageLogId: 'log_dup', userId: 'u1', costDollars: 1 });
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(350);
    expect(ledgerOf('u1').filter((r) => r.entryType === 'usage' && r.aiUsageLogId === 'log_dup')).toHaveLength(1);
  });

  it('funding the same Stripe ref twice credits exactly once', async () => {
    seedUser('u1', 'cus_1', 'pro'); // 1500¢
    const evt = invoicePaid('in_dup', 'cus_1', PERIOD_START, PERIOD_END);

    await applyStripeFunding(evt);
    await applyStripeFunding(evt); // redelivery

    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(TIER_MONTHLY_ALLOWANCE_CENTS.pro);
    expect(ledgerOf('u1').filter((r) => r.entryType === 'monthly_grant' && r.stripeRef === 'in_dup')).toHaveLength(1);
  });
});

describe('credits flow — crash recovery (backfill reconcile)', () => {
  const PAST = () => new Date(Date.now() - 10 * 60 * 1000); // older than the 5-min grace

  it('settles a pending ledger row, sweeps an orphan usage row, and bills a success:false row', async () => {
    seedUser('u1', 'cus_1', 'pro');
    // Give the user plenty of monthly credit to absorb the reconciled charges.
    store.creditBalances.push({
      userId: 'u1', monthlyRemainingCents: 5000, monthlyAllowanceCents: 5000,
      topupRemainingCents: 0, pendingMillicents: 0,
      monthlyPeriodStart: new Date(PERIOD_START * 1000), monthlyPeriodEnd: new Date(PERIOD_END * 1000),
      updatedAt: new Date(),
    });

    // (a) claimed-but-unsettled usage row: consume crashed after the claim insert.
    store.creditLedger.push({
      id: 'led_pending', userId: 'u1', entryType: 'usage', bucket: 'monthly',
      amountCents: -1, appliedCents: null, chargeMillicents: chargeMc(1), // 150¢
      aiUsageLogId: 'log_pending', realCostCents: 100, markupBps: MARKUP_BPS,
      stripeRef: null, consumeStatus: 'pending', createdAt: PAST(),
    });

    // (b) orphan usage row: consume never ran at all (no ledger entry).
    store.aiUsageLogs.push({ id: 'log_orphan', userId: 'u1', cost: 1, timestamp: PAST(), success: true }); // 150¢

    // (c) errored-but-billable row: success:false but tokens were spent (cost > 0).
    store.aiUsageLogs.push({ id: 'log_failed', userId: 'u1', cost: 0.5, timestamp: PAST(), success: false }); // 75¢

    const result = await backfillCredits();

    // pending row re-settled; both orphan rows swept (success flag is irrelevant — cost is what matters).
    expect(result.retried).toBe(1);
    expect(result.orphans).toBe(2);

    const led = store.creditLedger.find((r) => r.id === 'led_pending')!;
    expect(led.consumeStatus).toBe('applied');
    expect(led.appliedCents).toBe(-150);

    // Each orphan now has a settled usage ledger row.
    expect(ledgerOf('u1').filter((r) => r.entryType === 'usage' && r.aiUsageLogId === 'log_orphan')).toHaveLength(1);
    expect(ledgerOf('u1').filter((r) => r.entryType === 'usage' && r.aiUsageLogId === 'log_failed')).toHaveLength(1);

    // 5000 − 150 (pending) − 150 (orphan) − 75 (failed) = 4625
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(4625);
  });

  it('drains a backlog larger than one BATCH across multiple passes', async () => {
    seedUser('u1', 'cus_1', 'business');
    store.creditBalances.push({
      userId: 'u1', monthlyRemainingCents: 1_000_000, monthlyAllowanceCents: 1_000_000,
      topupRemainingCents: 0, pendingMillicents: 0,
      monthlyPeriodStart: new Date(PERIOD_START * 1000), monthlyPeriodEnd: new Date(PERIOD_END * 1000),
      updatedAt: new Date(),
    });

    // 205 orphans > BATCH(200): the cron must loop a second pass to clear the tail.
    const N = 205;
    for (let i = 0; i < N; i++) {
      store.aiUsageLogs.push({ id: `orphan_${i}`, userId: 'u1', cost: 0.01, timestamp: PAST(), success: true });
    }

    const result = await backfillCredits();

    expect(result.orphans).toBe(N);
    expect(ledgerOf('u1').filter((r) => r.entryType === 'usage')).toHaveLength(N);
  });
});

describe('credits flow — monthly reset', () => {
  it('gate resets an expired period to the tier allowance for a FREE user and rolls the window forward', async () => {
    seedUser('u1', 'cus_1', 'free'); // gate-driven reset is free-only; paid users refill via invoice.paid
    // Drained balance whose period already ended yesterday.
    store.creditBalances.push({
      userId: 'u1', monthlyRemainingCents: 0, monthlyAllowanceCents: 500,
      topupRemainingCents: 0, pendingMillicents: 0,
      monthlyPeriodStart: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      monthlyPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    });

    const gate = await canConsumeAI('u1', 'free');
    expect(gate).toEqual({ allowed: true, reason: 'ok' });
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(TIER_MONTHLY_ALLOWANCE_CENTS.free); // refilled
    expect(balanceOf('u1')!.monthlyPeriodEnd!.getTime()).toBeGreaterThan(Date.now()); // window advanced
  });

  it('does NOT gate-reset a paid user with an expired window (invoice.paid is authoritative)', async () => {
    seedUser('u3', 'cus_3', 'pro');
    store.creditBalances.push({
      userId: 'u3', monthlyRemainingCents: 0, monthlyAllowanceCents: 1500,
      topupRemainingCents: 0, pendingMillicents: 0,
      monthlyPeriodStart: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      monthlyPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    });

    const gate = await canConsumeAI('u3', 'pro');
    expect(gate).toEqual({ allowed: false, reason: 'out_of_credits' }); // blocked until renewal lands
    expect(balanceOf('u3')!.monthlyRemainingCents).toBe(0); // not refilled by the gate
  });

  it('lazy-inits a brand-new user with a period-stamped allowance, then a paid invoice refills it', async () => {
    seedUser('u2', 'cus_2', 'pro');

    // No balance row yet → gate lazy-inits from the tier allowance and allows.
    const gate = await canConsumeAI('u2', 'pro');
    expect(gate).toEqual({ allowed: true, reason: 'ok' });
    expect(balanceOf('u2')!.monthlyRemainingCents).toBe(TIER_MONTHLY_ALLOWANCE_CENTS.pro);
    expect(balanceOf('u2')!.monthlyPeriodEnd).not.toBeNull();

    // Spend some, then invoice.paid refills to the full allowance and sets the invoice period.
    await consumeCredits({ aiUsageLogId: 'log_x', userId: 'u2', costDollars: 1 }); // 150¢
    expect(balanceOf('u2')!.monthlyRemainingCents).toBe(1350);

    await applyStripeFunding(invoicePaid('in_2', 'cus_2', PERIOD_START, PERIOD_END));
    expect(balanceOf('u2')!.monthlyRemainingCents).toBe(TIER_MONTHLY_ALLOWANCE_CENTS.pro);
    expect(balanceOf('u2')!.monthlyPeriodEnd!.getTime()).toBe(PERIOD_END * 1000);
  });
});

describe('credits flow — sub-cent accrual', () => {
  it('accumulates sub-cent charges via the fractional remainder; nothing is lost', async () => {
    seedUser('u1', 'cus_1', 'free');
    store.creditBalances.push({
      userId: 'u1', monthlyRemainingCents: 100, monthlyAllowanceCents: 500,
      topupRemainingCents: 0, pendingMillicents: 0,
      monthlyPeriodStart: new Date(PERIOD_START * 1000), monthlyPeriodEnd: new Date(PERIOD_END * 1000),
      updatedAt: new Date(),
    });

    // Each call: cost $0.004 → 600 millicents (0.6¢) — strictly sub-cent.
    const perCallMc = chargeMc(0.004);
    expect(perCallMc).toBe(600);

    // 3 calls → 1800 mc total → 1 whole cent debited, 800 mc carried.
    for (let i = 0; i < 3; i++) {
      await consumeCredits({ aiUsageLogId: `sub_${i}`, userId: 'u1', costDollars: 0.004 });
    }
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(99); // exactly 1¢ so far
    expect(balanceOf('u1')!.pendingMillicents).toBe(800); // remainder carried, not lost

    // A 4th call crosses the next whole cent: 800 + 600 = 1400 → debit 1, carry 400.
    await consumeCredits({ aiUsageLogId: 'sub_3', userId: 'u1', costDollars: 0.004 });
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(98);
    expect(balanceOf('u1')!.pendingMillicents).toBe(400);

    // Conservation: total charged mc == debited cents * 1000 + carried remainder.
    const totalMc = perCallMc * 4;
    const debitedCents = 100 - balanceOf('u1')!.monthlyRemainingCents;
    expect(debitedCents * 1000 + balanceOf('u1')!.pendingMillicents).toBe(totalMc);
  });
});

describe('credits flow — shortfall / debt', () => {
  it('floors the balance at 0 and records a debt adjustment equal to the uncovered remainder', async () => {
    seedUser('u1', 'cus_1', 'free');
    store.creditBalances.push({
      userId: 'u1', monthlyRemainingCents: 10, monthlyAllowanceCents: 500,
      topupRemainingCents: 0, pendingMillicents: 0,
      monthlyPeriodStart: new Date(PERIOD_START * 1000), monthlyPeriodEnd: new Date(PERIOD_END * 1000),
      updatedAt: new Date(),
    });

    // $1 of cost → 150¢ charge, but only 10¢ available → 140¢ uncovered.
    await consumeCredits({ aiUsageLogId: 'log_debt', userId: 'u1', costDollars: 1 });

    // Balance floored at 0 (never negative — the DB CHECK invariant).
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(0);
    expect(balanceOf('u1')!.topupRemainingCents).toBe(0);

    // The usage row records what ACTUALLY left the balance; a separate adjustment row holds the debt.
    const usage = ledgerOf('u1').find((r) => r.entryType === 'usage' && r.aiUsageLogId === 'log_debt')!;
    expect(usage.appliedCents).toBe(-10);
    const debt = ledgerOf('u1').find((r) => r.entryType === 'adjustment' && r.aiUsageLogId === 'log_debt')!;
    expect(debt).toBeDefined();
    expect(debt.amountCents).toBe(-140);

    // Books reconcile: sum of applied decrements == the balance delta (−10).
    const appliedSum = ledgerOf('u1')
      .filter((r) => r.entryType === 'usage')
      .reduce((s, r) => s + (r.appliedCents as number), 0);
    expect(appliedSum).toBe(-10);
  });
});

describe('credits flow — billing disabled (tenant/onprem)', () => {
  it('gate is unlimited and consume/fund/backfill are no-ops', async () => {
    H.isBillingEnabled.mockReturnValue(false);
    seedUser('u1', 'cus_1', 'pro');

    expect(await canConsumeAI('u1', 'pro')).toEqual({ allowed: true, reason: 'unlimited' });

    await consumeCredits({ aiUsageLogId: 'log_1', userId: 'u1', costDollars: 5 });
    await applyStripeFunding(invoicePaid('in_1', 'cus_1', PERIOD_START, PERIOD_END));
    const result = await backfillCredits();

    expect(result).toEqual({ retried: 0, orphans: 0 });
    expect(store.creditLedger).toHaveLength(0);
    expect(store.creditBalances).toHaveLength(0);
  });
});
