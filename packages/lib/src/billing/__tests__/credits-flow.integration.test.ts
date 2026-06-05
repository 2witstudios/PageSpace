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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── A column reference the fake operators/select can resolve against a row ────────
type Col = { __col: true; table: TableKey; name: string };
type TableKey = 'creditBalances' | 'creditLedger' | 'creditHolds' | 'users' | 'aiUsageLogs';

interface Row { [k: string]: unknown }
type Store = Record<TableKey, Row[]>;

type Pred =
  | { kind: 'eq'; col: Col; val: unknown }
  | { kind: 'lt'; col: Col; val: unknown }
  | { kind: 'gt'; col: Col; val: unknown }
  | { kind: 'gte'; col: Col; val: unknown }
  | { kind: 'inArray'; col: Col; vals: unknown[] }
  | { kind: 'isNull'; col: Col }
  | { kind: 'and'; parts: Pred[] }
  | { kind: 'or'; parts: Pred[] }
  | { kind: 'sql'; values?: unknown[] };

// ── Hoisted shared state: one store + one fake db, shared by all four real shells ─
const H = vi.hoisted(() => {
  const store: Store = { creditBalances: [], creditLedger: [], creditHolds: [], users: [], aiUsageLogs: [] };

  const col = (table: TableKey, name: string): Col => ({ __col: true, table, name });
  const cols = (table: TableKey, names: string[]): Record<string, Col> & { __table: TableKey } => {
    const t: Record<string, unknown> = { __table: table };
    for (const n of names) t[n] = col(table, n);
    return t as Record<string, Col> & { __table: TableKey };
  };

  const creditBalances = cols('creditBalances', [
    'userId', 'monthlyRemainingCents', 'monthlyAllowanceCents', 'topupRemainingCents',
    'pendingMillicents', 'debtCents', 'monthlyPeriodStart', 'monthlyPeriodEnd', 'updatedAt',
  ]);
  const creditLedger = cols('creditLedger', [
    'id', 'userId', 'entryType', 'bucket', 'amountCents', 'appliedCents', 'chargeMillicents',
    'aiUsageLogId', 'realCostCents', 'markupBps', 'stripeRef', 'consumeStatus',
    'reconcileGenerationKey', 'createdAt',
  ]);
  const creditHolds = cols('creditHolds', ['id', 'userId', 'estCents', 'aiUsageLogId', 'createdAt', 'expiresAt']);
  const users = cols('users', ['id', 'stripeCustomerId', 'subscriptionTier']);
  const aiUsageLogs = cols('aiUsageLogs', [
    'id', 'userId', 'cost', 'timestamp', 'success',
    'metadata', 'reconcileStatus', 'reconcileAttempts', 'reconciledAt',
  ]);

  // ── operators ───────────────────────────────────────────────────────────────
  const eq = (col: Col, val: unknown): Pred => ({ kind: 'eq', col, val });
  const lt = (col: Col, val: unknown): Pred => ({ kind: 'lt', col, val });
  const gt = (col: Col, val: unknown): Pred => ({ kind: 'gt', col, val });
  const gte = (col: Col, val: unknown): Pred => ({ kind: 'gte', col, val });
  const inArray = (col: Col, vals: unknown[]): Pred => ({ kind: 'inArray', col, vals });
  const isNull = (col: Col): Pred => ({ kind: 'isNull', col });
  const and = (...parts: Pred[]): Pred => ({ kind: 'and', parts });
  const or = (...parts: Pred[]): Pred => ({ kind: 'or', parts });
  // Capture interpolated operands so an `update().set()` value like
  // sql`${creditBalances.debtCents} + ${shortfall}` can be evaluated per-row. Used as
  // a predicate (where) it still just passes (kind 'sql' -> true in evalPred).
  const sqlTag = (_strings?: TemplateStringsArray, ...values: unknown[]): Pred => ({ kind: 'sql', values });

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
      case 'gte': { const a = resolve(p.col, ctx); const b = operand(p.val, ctx); return a != null && b != null && num(a) >= num(b); }
      case 'inArray': return p.vals.includes(resolve(p.col, ctx));
      case 'isNull': return resolve(p.col, ctx) == null;
      case 'and': return p.parts.every((q) => evalPred(q, ctx));
      case 'or': return p.parts.some((q) => evalPred(q, ctx));
      case 'sql': return true;
    }
  };

  // Evaluate an `update().set()` SQL expression against the row being updated. The only
  // shape the shells use is additive — sql`${col} + ${n}` (the debt increment) — so we
  // resolve each operand (Col -> row value, else literal) and sum them.
  const isSqlExpr = (v: unknown): v is { kind: 'sql'; values?: unknown[] } =>
    typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'sql';
  const evalSqlExpr = (expr: { values?: unknown[] }, row: Row): number =>
    (expr.values ?? []).reduce<number>((sum, v) => {
      const operand = isCol(v) ? resolve(v, { [v.table]: row } as Ctx) : v;
      return sum + Number(operand ?? 0);
    }, 0);

  // ── id generator (deterministic; not Date/random) ─────────────────────────────
  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}_${++seq}`;

  const applyDefaults = (table: TableKey, v: Row): Row => {
    if (table === 'creditLedger') {
      return {
        appliedCents: null, chargeMillicents: null, aiUsageLogId: null, realCostCents: null,
        stripeRef: null, reconcileGenerationKey: null, markupBps: 15000, consumeStatus: 'pending',
        id: nextId('led'), createdAt: new Date(),
        ...v,
      };
    }
    if (table === 'creditBalances') {
      return {
        monthlyRemainingCents: 0, monthlyAllowanceCents: 0, topupRemainingCents: 0,
        pendingMillicents: 0, debtCents: 0, monthlyPeriodStart: null, monthlyPeriodEnd: null,
        updatedAt: new Date(),
        ...v,
      };
    }
    if (table === 'creditHolds') {
      return { id: nextId('hold'), aiUsageLogId: null, createdAt: new Date(), ...v };
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
    if (table === 'creditLedger' && target.name === 'reconcileGenerationKey') {
      return row.reconcileGenerationKey == null
        ? undefined
        : store.creditLedger.find((r) => r.reconcileGenerationKey === row.reconcileGenerationKey);
    }
    return undefined;
  };

  const enforceBalanceInvariants = (r: Row): void => {
    for (const f of ['monthlyRemainingCents', 'monthlyAllowanceCents', 'topupRemainingCents', 'debtCents']) {
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
  // Aggregate projection: any projected value that isn't a plain Col is a SQL
  // expression (e.g. the gate's coalesce(sum(estCents)) / count(*) hold tally).
  const isAggregate = (proj?: Record<string, unknown>): boolean =>
    !!proj && Object.values(proj).some((v) => !isCol(v));

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
      if (isAggregate(proj)) {
        // The daily-cap query: coalesce(sum(chargeMillicents),0) AS chargedMc.
        if (proj && 'chargedMc' in proj) {
          const chargedMc = filtered.reduce((s, c) => s + ((c.primary.chargeMillicents as number) ?? 0), 0);
          return [{ chargedMc }];
        }
        // The gate's hold tally: coalesce(sum(estCents),0) AS reserved, count(*) AS inFlight.
        const reserved = filtered.reduce((s, c) => s + ((c.primary.estCents as number) ?? 0), 0);
        return [{ reserved, inFlight: filtered.length }];
      }
      const limited = limit == null ? filtered : filtered.slice(0, limit);
      return limited.map((c) => project(proj, c.ctx, c.primary));
    };

    const api = {
      from(tbl: { __table: TableKey }) { baseKey = tbl.__table; return api; },
      leftJoin(tbl: { __table: TableKey }, on: Pred) { joinKey = tbl.__table; joinPred = on; return api; },
      where(p: Pred) { wherePred = p; return api; },
      limit(n: number) { return Promise.resolve(run(n)); },
      for(_mode: string) { return api; }, // return api so .for('update').limit(n) chains
      // Awaitable terminal: `await select(...).from(...).where(...)` (the gate's hold
      // aggregate ends at .where with no .limit/.for) resolves the rows here.
      then(res: (v: Row[]) => void, rej?: (e: unknown) => void) {
        try { res(run()); } catch (e) { rej?.(e); }
      },
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
          // `insert(...).values(...).returning(...)` with no conflict clause (the
          // gate's hold insert): persist and project the inserted row.
          returning(proj?: Record<string, Col>) {
            const row = plainInsert();
            return Promise.resolve([project(proj, { [table]: row } as Ctx, row)]);
          },
          // bare `await insert.values(...)` (e.g. the debt adjustment row)
          then(res: (v: unknown) => void, rej?: (e: unknown) => void) {
            try { plainInsert(); res(undefined); } catch (e) { rej?.(e); }
          },
        };
      },
    };
  }

  // ── delete builder ────────────────────────────────────────────────────────────
  // `delete(tbl).where(p)[.returning(proj)]` — removes matching rows. Used to release
  // a hold at settle (consume), reclaim expired holds (backfill), and releaseHold.
  function makeDelete(tbl: { __table: TableKey }) {
    const table = tbl.__table;
    return {
      where(p: Pred) {
        const remove = (): Row[] => {
          const removed: Row[] = [];
          const kept: Row[] = [];
          for (const r of store[table]) {
            if (evalPred(p, { [table]: r } as Ctx)) removed.push(r);
            else kept.push(r);
          }
          // Mutate in place so external references to store[table] stay valid.
          store[table].length = 0;
          store[table].push(...kept);
          return removed;
        };
        let done = false;
        const exec = (): Row[] => { if (done) return []; done = true; return remove(); };
        return {
          returning(proj?: Record<string, Col>) {
            const rows = exec();
            return Promise.resolve(rows.map((r) => project(proj, { [table]: r } as Ctx, r)));
          },
          then(res: (v: unknown) => void, rej?: (e: unknown) => void) {
            try { exec(); res(undefined); } catch (e) { rej?.(e); }
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
                // Resolve any SQL-expression set values (e.g. debtCents + shortfall)
                // against this row before applying.
                const resolved: Row = {};
                for (const [k, val] of Object.entries(v)) {
                  resolved[k] = isSqlExpr(val) ? evalSqlExpr(val, r) : val;
                }
                Object.assign(r, resolved);
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
    delete: (tbl: { __table: TableKey }) => makeDelete(tbl),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  };

  const isBillingEnabled = vi.fn(() => true);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  return {
    store, db, isBillingEnabled, logger,
    schema: { creditBalances, creditLedger, creditHolds, users, aiUsageLogs },
    ops: { eq, lt, gt, gte, inArray, isNull, and, or, sql: sqlTag },
  };
});

vi.mock('@pagespace/db/db', () => ({ db: H.db }));
vi.mock('@pagespace/db/schema/credits', () => ({ creditBalances: H.schema.creditBalances, creditLedger: H.schema.creditLedger, creditHolds: H.schema.creditHolds }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: H.schema.users }));
vi.mock('@pagespace/db/schema/monitoring', () => ({ aiUsageLogs: H.schema.aiUsageLogs }));
vi.mock('@pagespace/db/operators', () => H.ops);
vi.mock('../../deployment-mode', () => ({ isBillingEnabled: H.isBillingEnabled }));
vi.mock('../../logging/logger-config', () => ({ loggers: { api: H.logger, ai: H.logger } }));
// The live balance broadcast is fire-and-forget I/O (signed POST to the realtime
// server); stub it so this end-to-end money-path test stays hermetic. Its own suite
// (credit-emit.test.ts) covers the broadcast.
vi.mock('../credit-emit', () => ({ emitCreditsUpdated: vi.fn().mockResolvedValue(undefined) }));

import { applyStripeFunding } from '../credit-funding';
import { canConsumeAI } from '../credit-gate';
import { consumeCredits } from '../credit-consume';
import { backfillCredits } from '../credit-backfill';
import { reconcileOpenRouterCosts, type GenerationFetcher } from '../cost-reconcile';
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
  store.creditHolds.length = 0;
  store.users.length = 0;
  store.aiUsageLogs.length = 0;
}

function seedUser(id: string, customer: string, tier: string) {
  store.users.push({ id, stripeCustomerId: customer, subscriptionTier: tier });
}

function balanceOf(userId: string) {
  return store.creditBalances.find((r) => r.userId === userId) as
    | { monthlyRemainingCents: number; topupRemainingCents: number; pendingMillicents: number; debtCents: number; monthlyPeriodEnd: Date | null }
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
  // This suite asserts the gate BLOCKS (out_of_credits). Enforcement defaults OFF
  // (dark launch), so enable it here; dark-launch behavior is unit-tested in
  // credit-gate.test.ts.
  process.env.CREDITS_ENFORCEMENT_ENABLED = 'true';
});

afterEach(() => {
  delete process.env.CREDITS_ENFORCEMENT_ENABLED;
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

    // Each "call" below is the real lifecycle: the gate reserves a hold (25¢ est)
    // and the matching consume releases it via the threaded holdId — so holds never
    // accumulate and spendable returns to balance−0 between calls.

    // ── CALL 1: $2 real cost, monthly-first (500 spendable, reserve passes) ──────
    let g = await canConsumeAI('u1', 'free');
    expect(g).toMatchObject({ allowed: true, reason: 'ok' });
    expect(g.holdId).toBeTruthy();
    await consumeCredits({ aiUsageLogId: 'log_1', userId: 'u1', costDollars: 2, holdId: g.holdId }); // 300¢
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(200);
    expect(store.creditHolds).toHaveLength(0); // hold released at settle

    // ── CALL 2: $1 real cost ────────────────────────────────────────────────────
    g = await canConsumeAI('u1', 'free');
    expect(g.allowed).toBe(true);
    await consumeCredits({ aiUsageLogId: 'log_2', userId: 'u1', costDollars: 1, holdId: g.holdId }); // 150¢
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(50);

    // ── GATE with 50¢ left → DENIED: reserving the 25¢ estimate would leave only
    // 25¢ == the reserve floor. The reservation guard blocks before overshoot, so a
    // near-empty bucket can't fund a call. (Denied, so no hold is inserted.) ──────
    expect((await canConsumeAI('u1', 'free')).allowed).toBe(false);
    expect(store.creditHolds).toHaveLength(0);

    // ── TOP-UP: a $10 credit pack unblocks the user (spendable 50 + 1000) ────────
    await applyStripeFunding(creditPackCheckout('cs_1', 'cus_1', 1000));
    expect(balanceOf('u1')!.topupRemainingCents).toBe(1000);
    expect(ledgerOf('u1').filter((r) => r.entryType === 'topup_purchase')).toHaveLength(1);

    // ── CALL 3 across the bucket boundary: $0.50 spends the last 50¢ monthly + 25¢ top-up
    g = await canConsumeAI('u1', 'free');
    expect(g.allowed).toBe(true);
    await consumeCredits({ aiUsageLogId: 'log_3', userId: 'u1', costDollars: 0.5, holdId: g.holdId }); // 75¢
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(0);
    expect(balanceOf('u1')!.topupRemainingCents).toBe(975);

    // ── CALL 4 (DRAIN): a $6.50 call empties the top-up bucket exactly ───────────
    g = await canConsumeAI('u1', 'free');
    expect(g.allowed).toBe(true);
    await consumeCredits({ aiUsageLogId: 'log_4', userId: 'u1', costDollars: 6.5, holdId: g.holdId }); // 975¢
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(0);
    expect(balanceOf('u1')!.topupRemainingCents).toBe(0);

    // ── GATE: drained → out_of_credits ──────────────────────────────────────────
    expect((await canConsumeAI('u1', 'free')).allowed).toBe(false);

    // Ledger sanity: 4 usage rows, 1 grant, 1 purchase, no debt (every call covered).
    expect(ledgerOf('u1').filter((r) => r.entryType === 'usage')).toHaveLength(4);
    expect(ledgerOf('u1').filter((r) => r.entryType === 'adjustment')).toHaveLength(0);
    // All holds released — no reservation leaked across the whole sequence.
    expect(store.creditHolds).toHaveLength(0);
  });
});

describe('credits flow — negative balance (overage → debt → recover)', () => {
  it('overshoots into debt, blocks while net-negative, then a top-up pays the debt and unblocks', async () => {
    seedUser('u1', 'cus_1', 'pro'); // 1500¢ monthly
    await applyStripeFunding(invoicePaid('in_1', 'cus_1', PERIOD_START, PERIOD_END));
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(1500);

    // ── OVERSHOOT: gate allows (1500 spendable), but the call costs $12 -> 1800¢.
    // The 300¢ it can't cover becomes debt; the monthly bucket floors at 0. ─────────
    const g1 = await canConsumeAI('u1', 'pro');
    expect(g1.allowed).toBe(true);
    await consumeCredits({ aiUsageLogId: 'log_over', userId: 'u1', costDollars: 12, holdId: g1.holdId });
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(0);
    expect(balanceOf('u1')!.topupRemainingCents).toBe(0);
    expect(balanceOf('u1')!.debtCents).toBe(300); // the uncovered overage, now owed
    // Both the live debt counter AND an incurrence adjustment row are recorded.
    const debtRows = ledgerOf('u1').filter((r) => r.entryType === 'adjustment');
    expect(debtRows).toHaveLength(1);
    expect(debtRows[0]).toMatchObject({ amountCents: -300, aiUsageLogId: 'log_over' });

    // ── BLOCKED: net = 0 − 300 = −300 < floor → out_of_credits (must get positive) ─
    expect((await canConsumeAI('u1', 'pro'))).toMatchObject({ allowed: false, reason: 'out_of_credits' });

    // ── RECOVER: a $25 pack pays the 300¢ debt FIRST, banking the 2200¢ remainder. ─
    await applyStripeFunding(creditPackCheckout('cs_1', 'cus_1', 2500));
    expect(balanceOf('u1')!.debtCents).toBe(0);
    expect(balanceOf('u1')!.topupRemainingCents).toBe(2200);

    // ── UNBLOCKED: net positive again. ──────────────────────────────────────────
    expect((await canConsumeAI('u1', 'pro')).allowed).toBe(true);
  });

  it('forgives outstanding debt at the next renewal — full allowance, debt wiped', async () => {
    seedUser('u1', 'cus_1', 'pro');
    await applyStripeFunding(invoicePaid('in_1', 'cus_1', PERIOD_START, PERIOD_END));

    const g = await canConsumeAI('u1', 'pro');
    await consumeCredits({ aiUsageLogId: 'log_over', userId: 'u1', costDollars: 12, holdId: g.holdId });
    expect(balanceOf('u1')!.debtCents).toBe(300);
    expect((await canConsumeAI('u1', 'pro')).allowed).toBe(false); // blocked while in the red

    // ── RENEWAL: invoice.paid restores the FULL allowance and forgives the debt. ──
    await applyStripeFunding(invoicePaid('in_2', 'cus_1', PERIOD_START, PERIOD_END));
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(1500); // full, NOT reduced by the 300 debt
    expect(balanceOf('u1')!.debtCents).toBe(0); // forgiven
    expect((await canConsumeAI('u1', 'pro')).allowed).toBe(true);
  });

  it('a partial top-up (smaller than the debt) reduces debt but stays blocked until net-positive', async () => {
    seedUser('u1', 'cus_1', 'pro');
    await applyStripeFunding(invoicePaid('in_1', 'cus_1', PERIOD_START, PERIOD_END));

    const g = await canConsumeAI('u1', 'pro');
    // $20 call -> 3000¢; covers 1500 monthly, leaves 1500¢ debt.
    await consumeCredits({ aiUsageLogId: 'log_big', userId: 'u1', costDollars: 20, holdId: g.holdId });
    expect(balanceOf('u1')!.debtCents).toBe(1500);

    // A $5 pack (500¢) only chips the debt down to 1000; top-up stays 0; still blocked.
    await applyStripeFunding(creditPackCheckout('cs_partial', 'cus_1', 500));
    expect(balanceOf('u1')!.debtCents).toBe(1000);
    expect(balanceOf('u1')!.topupRemainingCents).toBe(0);
    expect((await canConsumeAI('u1', 'pro')).allowed).toBe(false);
  });

  it('ACCUMULATES debt across two in-flight overages (settle adds to existing debt, never overwrites)', async () => {
    seedUser('u1', 'cus_1', 'pro'); // 1500¢ monthly
    await applyStripeFunding(invoicePaid('in_1', 'cus_1', PERIOD_START, PERIOD_END));

    // Two calls go in-flight TOGETHER: both clear the gate (net 1500 − two 25¢
    // reservations still above the floor) before either settles. This is the only
    // path that drives a SECOND overage settle while debtCents is already > 0, which
    // is exactly what the additive `debtCents + shortfall` SQL increment exists to
    // handle — an overwrite would silently erase the first overage's debt.
    const g1 = await canConsumeAI('u1', 'pro');
    const g2 = await canConsumeAI('u1', 'pro');
    expect(g1.allowed).toBe(true);
    expect(g2.allowed).toBe(true);
    expect(store.creditHolds).toHaveLength(2); // both reservations live, nothing settled yet

    // ── SETTLE #1: $12 -> 1800¢. Spends the full 1500 monthly; 300¢ becomes debt. ──
    await consumeCredits({ aiUsageLogId: 'log_a', userId: 'u1', costDollars: 12, holdId: g1.holdId });
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(0);
    expect(balanceOf('u1')!.debtCents).toBe(300);

    // ── SETTLE #2: $4 -> 600¢. Buckets already empty, so the WHOLE 600¢ is shortfall
    // and must ADD to the existing 300 -> 900. (If the write overwrote rather than
    // incremented, debt would read 600 here.) ───────────────────────────────────────
    await consumeCredits({ aiUsageLogId: 'log_b', userId: 'u1', costDollars: 4, holdId: g2.holdId });
    expect(balanceOf('u1')!.debtCents).toBe(900); // 300 + 600, accumulated

    // Each overage left its own incurrence row; the two sum to the live debt counter.
    const debtRows = ledgerOf('u1').filter((r) => r.entryType === 'adjustment');
    expect(debtRows).toHaveLength(2);
    expect(debtRows.map((r) => r.amountCents).sort((a, b) => Number(a) - Number(b))).toEqual([-600, -300]);
    expect(store.creditHolds).toHaveLength(0); // both holds released at settle

    // Net = 0 − 900 < floor → blocked until paid down or forgiven.
    expect((await canConsumeAI('u1', 'pro')).allowed).toBe(false);
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
    expect(gate).toMatchObject({ allowed: true, reason: 'ok' });
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

  it('lazy-inits a brand-new user with a period-stamped allowance, then a paid invoice rolls over (adds allowance to remaining)', async () => {
    seedUser('u2', 'cus_2', 'pro');

    // No balance row yet → gate lazy-inits from the tier allowance and allows.
    const gate = await canConsumeAI('u2', 'pro');
    expect(gate).toMatchObject({ allowed: true, reason: 'ok' });
    expect(balanceOf('u2')!.monthlyRemainingCents).toBe(TIER_MONTHLY_ALLOWANCE_CENTS.pro);
    expect(balanceOf('u2')!.monthlyPeriodEnd).not.toBeNull();

    // Spend some, then invoice.paid ADDS the allowance to the remaining balance (rollover).
    await consumeCredits({ aiUsageLogId: 'log_x', userId: 'u2', costDollars: 1 }); // 150¢
    expect(balanceOf('u2')!.monthlyRemainingCents).toBe(1350);

    await applyStripeFunding(invoicePaid('in_2', 'cus_2', PERIOD_START, PERIOD_END));
    expect(balanceOf('u2')!.monthlyRemainingCents).toBe(1350 + TIER_MONTHLY_ALLOWANCE_CENTS.pro); // rollover: carry 1350 + new 1500 = 2850
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

    expect(result).toEqual({ retried: 0, orphans: 0, expiredHolds: 0 });
    expect(store.creditLedger).toHaveLength(0);
    expect(store.creditBalances).toHaveLength(0);
  });
});

describe('credits flow — async cost reconcile (/generation drift correction)', () => {
  const TEN_MIN_AGO = () => new Date(Date.now() - 10 * 60 * 1000);

  function seedBalance(userId: string, partial: Partial<{ monthly: number; topup: number; debt: number }> = {}) {
    store.creditBalances.push({
      userId,
      monthlyRemainingCents: partial.monthly ?? 1000,
      monthlyAllowanceCents: 1000,
      topupRemainingCents: partial.topup ?? 0,
      pendingMillicents: 0,
      debtCents: partial.debt ?? 0,
      monthlyPeriodStart: null,
      monthlyPeriodEnd: null,
      updatedAt: new Date(),
    });
  }

  function seedPendingUsage(id: string, userId: string, costDollars: number, generationIds: string[] | null, attempts = 0) {
    store.aiUsageLogs.push({
      id,
      userId,
      cost: costDollars,
      timestamp: TEN_MIN_AGO(),
      success: true,
      metadata: generationIds === null ? {} : { generationIds },
      reconcileStatus: 'pending',
      reconcileAttempts: attempts,
      reconciledAt: null,
    });
  }

  // Reconcile only CORRECTS an already-billed call, so a base `usage` ledger row must
  // exist for the aiUsageLogId or the row is deferred (see hasUsageLedgerRow). Seed one.
  function seedUsageLedger(aiUsageLogId: string, userId: string) {
    store.creditLedger.push({
      id: `led_${aiUsageLogId}`, userId, entryType: 'usage', bucket: 'monthly',
      amountCents: -150, appliedCents: -150, chargeMillicents: 150_000, aiUsageLogId,
      realCostCents: 100, markupBps: 15000, stripeRef: null, reconcileGenerationKey: null,
      consumeStatus: 'applied', createdAt: new Date(),
    });
  }

  const usageRow = (id: string) => store.aiUsageLogs.find((r) => r.id === id) as
    | { reconcileStatus: string; reconcileAttempts: number }
    | undefined;
  const adjustments = (userId: string) => ledgerOf(userId).filter((r) => r.entryType === 'adjustment');

  it('corrects an undercharge: authoritative cost > billed → adjustment + extra debit', async () => {
    seedBalance('u1', { monthly: 1000 });
    seedPendingUsage('log_1', 'u1', 1.0, ['gen-1']); // billed 100¢ real
    seedUsageLedger('log_1', 'u1');
    const fetcher: GenerationFetcher = async () => ({ totalCost: 1.1 }); // authoritative $1.10

    const r = await reconcileOpenRouterCosts({ fetcher });

    expect(r).toMatchObject({ fetched: 1, corrected: 1, unavailable: 0, skipped: 0 });
    expect(usageRow('log_1')!.reconcileStatus).toBe('reconciled');
    // 10¢ real delta × 1.5 = 15¢ extra charge → monthly 1000 − 15 = 985.
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(985);
    const adj = adjustments('u1');
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ aiUsageLogId: 'log_1', reconcileGenerationKey: 'gen-1', appliedCents: -15 });
  });

  it('corrects an overcharge: authoritative cost < billed → refund pays down debt first', async () => {
    seedBalance('u1', { monthly: 1000, debt: 50 });
    seedPendingUsage('log_1', 'u1', 1.0, ['gen-1']); // billed 100¢
    seedUsageLedger('log_1', 'u1');
    const fetcher: GenerationFetcher = async () => ({ totalCost: 0.8 }); // authoritative $0.80

    const r = await reconcileOpenRouterCosts({ fetcher });

    expect(r.corrected).toBe(1);
    // 20¢ delta × 1.5 = 30¢ refund → pays down 50¢ debt to 20¢ (topup stays 0).
    expect(balanceOf('u1')!.debtCents).toBe(20);
    expect(balanceOf('u1')!.topupRemainingCents).toBe(0);
  });

  it('leaves a within-tolerance row reconciled with no adjustment', async () => {
    seedBalance('u1', { monthly: 1000 });
    seedPendingUsage('log_1', 'u1', 1.0, ['gen-1']); // billed 100¢
    seedUsageLedger('log_1', 'u1');
    const fetcher: GenerationFetcher = async () => ({ totalCost: 1.02 }); // 2¢ drift < 5% band

    const r = await reconcileOpenRouterCosts({ fetcher });

    expect(r).toMatchObject({ fetched: 1, corrected: 0 });
    expect(usageRow('log_1')!.reconcileStatus).toBe('reconciled');
    expect(adjustments('u1')).toHaveLength(0);
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(1000);
  });

  it('keeps a not-yet-available generation pending and bumps its attempt count', async () => {
    seedBalance('u1');
    seedPendingUsage('log_1', 'u1', 1.0, ['gen-1'], 0);
    seedUsageLedger('log_1', 'u1');
    const fetcher: GenerationFetcher = async () => 'not_found';

    const r = await reconcileOpenRouterCosts({ fetcher });

    expect(r).toMatchObject({ fetched: 0, corrected: 0, unavailable: 0 });
    expect(usageRow('log_1')!.reconcileStatus).toBe('pending');
    expect(usageRow('log_1')!.reconcileAttempts).toBe(1);
  });

  it('gives up after the attempt budget is exhausted → unavailable', async () => {
    seedBalance('u1');
    seedPendingUsage('log_1', 'u1', 1.0, ['gen-1'], 5); // COST_RECONCILE_MAX_ATTEMPTS = 6
    seedUsageLedger('log_1', 'u1');
    const fetcher: GenerationFetcher = async () => 'not_found';

    const r = await reconcileOpenRouterCosts({ fetcher });

    expect(r.unavailable).toBe(1);
    expect(usageRow('log_1')!.reconcileStatus).toBe('unavailable');
  });

  it('is idempotent: a re-run over the same generation set inserts no second adjustment', async () => {
    seedBalance('u1', { monthly: 1000 });
    seedPendingUsage('log_1', 'u1', 1.0, ['gen-1']);
    seedUsageLedger('log_1', 'u1');
    const fetcher: GenerationFetcher = async () => ({ totalCost: 1.1 });

    await reconcileOpenRouterCosts({ fetcher });
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(985);
    expect(adjustments('u1')).toHaveLength(1);

    // Simulate a lost status update (row back to 'pending') and re-run: the reconcile-key
    // unique arbiter makes the claim a no-op, so the balance is NOT debited twice.
    usageRow('log_1')!.reconcileStatus = 'pending';
    await reconcileOpenRouterCosts({ fetcher });

    expect(adjustments('u1')).toHaveLength(1);
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(985);
  });

  it('marks a row with no generation ids skipped (never fetches)', async () => {
    seedBalance('u1');
    seedPendingUsage('log_1', 'u1', 1.0, null); // metadata has no generationIds
    let called = false;
    const fetcher: GenerationFetcher = async () => { called = true; return 'not_found'; };

    const r = await reconcileOpenRouterCosts({ fetcher });

    expect(r.skipped).toBe(1);
    expect(called).toBe(false);
    expect(usageRow('log_1')!.reconcileStatus).toBe('skipped');
  });

  it('defers (no adjustment, no fetch) when the base usage charge has not been billed yet', async () => {
    // No usage ledger row for log_1 → consumeCredits hasn't run. Correcting now would
    // leave the base charge unbilled AND mask it from credit-backfill's orphan sweep.
    seedBalance('u1', { monthly: 1000 });
    seedPendingUsage('log_1', 'u1', 1.0, ['gen-1']);
    let called = false;
    const fetcher: GenerationFetcher = async () => { called = true; return { totalCost: 1.1 }; };

    const r = await reconcileOpenRouterCosts({ fetcher });

    expect(r).toMatchObject({ fetched: 0, corrected: 0 });
    expect(called).toBe(false); // no /generation fetch spent on a not-yet-billed row
    expect(adjustments('u1')).toHaveLength(0); // nothing inserted to mask the orphan
    expect(usageRow('log_1')!.reconcileStatus).toBe('pending'); // deferred for a later run
    expect(usageRow('log_1')!.reconcileAttempts).toBe(1);
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(1000); // balance untouched
  });
});

describe('credits flow — per-user/day exposure cap (fund → consume past the cap → denied)', () => {
  afterEach(() => {
    delete process.env.DAILY_USER_EXPOSURE_CAP_CENTS;
  });

  it('denies the next call once the day\'s charged spend would exceed the cap, while credits remain', async () => {
    process.env.DAILY_USER_EXPOSURE_CAP_CENTS = '200'; // 200¢/day ceiling
    seedUser('u1', 'cus_1', 'pro'); // pro = 1500¢ monthly — far above the daily cap
    await applyStripeFunding(invoicePaid('in_1', 'cus_1', PERIOD_START, PERIOD_END));
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(TIER_MONTHLY_ALLOWANCE_CENTS.pro);

    // CALL 1: $1 real → 150¢ charged. day total 0 + EST(25) < 200 → allowed.
    let g = await canConsumeAI('u1', 'pro');
    expect(g).toMatchObject({ allowed: true, reason: 'ok' });
    await consumeCredits({ aiUsageLogId: 'log_1', userId: 'u1', costDollars: 1, holdId: g.holdId });

    // CALL 2: day total 150¢ + EST(25) = 175 < 200 → still allowed.
    g = await canConsumeAI('u1', 'pro');
    expect(g.allowed).toBe(true);
    await consumeCredits({ aiUsageLogId: 'log_2', userId: 'u1', costDollars: 1, holdId: g.holdId });

    // CALL 3: day total now 300¢ — already over the 200¢ cap → denied by the backstop,
    // NOT by credits (monthly still has 1200¢). No hold is reserved on the denial.
    expect(balanceOf('u1')!.monthlyRemainingCents).toBe(1200);
    g = await canConsumeAI('u1', 'pro');
    expect(g).toEqual({ allowed: false, reason: 'daily_cap_exceeded' });
    expect(store.creditHolds).toHaveLength(0);
  });
});
