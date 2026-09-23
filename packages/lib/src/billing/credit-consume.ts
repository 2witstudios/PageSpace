/**
 * credit-consume — imperative shell that debits a user's prepaid balance for one
 * AI call. Pure decisions (markup, monthly-first split) come from credit-core;
 * this file only does I/O.
 *
 * Correctness:
 *   - Idempotent: a unique index on credit_ledger.aiUsageLogId means each AI call
 *     is billed at most once. The claim insert uses onConflictDoNothing; a
 *     conflict short-circuits the decrement.
 *   - Atomic: the balance read+write is a single transaction with a row lock, so
 *     concurrent calls by the same user can't lose an update.
 *   - Safe: never throws into the AI request. A failed decrement leaves the
 *     ledger row 'pending' for the backfill cron (settlePendingLedgerRow); a
 *     failed claim leaves no row, and the cron's orphan sweep reconciles it.
 *   - Honest: never-throwing is not the same as always-succeeding, so the outcome
 *     is REPORTED instead of swallowed — see {@link CreditSettleStatus}. Callers
 *     use it to log and to count; they must NOT use a `deferred` to re-bill the
 *     window, because the backfill cron is about to settle exactly that charge.
 */

import { db } from '@pagespace/db/db';
import { creditLedger, creditHolds } from '@pagespace/db/schema/credits';
import { wallets } from '@pagespace/db/schema/wallets';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { and, eq, isNull, sql } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { chargeMillicents, accruePending, allocateSpend, applyPaymentToDebt } from './credit-core';
import { allocateWalletSpend, settleOvershoot, DEFAULT_OVERSHOOT_CHOICE } from './wallet-core';
import { childWalletFunds, type WalletBalanceFacts } from './spend-target';
import { drawWalletFundingLegs, creditWalletFundingLegs } from './wallet-legs';
import { parseWalletDraws, addWalletDraws, planWalletRefund, type WalletDraws } from './wallet-draws';
import { MARKUP_BPS } from './credit-pricing';
import { emitCreditsUpdated } from './credit-emit';
import { ensurePersonalRootWalletId } from './personal-wallet';
import { loggers } from '../logging/logger-config';

export interface ConsumeCreditsInput {
  aiUsageLogId: string;
  userId: string;
  costDollars: number;
  /**
   * The reservation placed by the gate for this call, released here at settle.
   * Live requests thread it through from canConsumeAI; the reconcile cron's
   * orphan/retry paths pass none (the hold, if any, is reclaimed by expiry).
   */
  holdId?: string;
  /**
   * The wallet the gate reserved on for this call (CreditGateResult.walletId), threaded
   * with the hold so the charge settles against exactly the wallet the call named (WAL-5).
   * Absent only for callers that never gated a shared wallet (the reconcile cron's orphan
   * path, un-gated system calls): those charge the payer's personal root wallet, as every
   * charge did before wallets.
   */
  walletId?: string;
  /**
   * Optional scope so the live `credits:updated` push can carry conversation/page
   * hints (the per-conversation usage monitor filters on them). Live chat routes
   * thread these through; background jobs and the reconcile cron leave them unset,
   * so the navbar still updates while the per-conversation view is untouched.
   */
  conversationId?: string;
  pageId?: string;
  /**
   * Per-call override for the markup applied at settle, in basis points.
   * Absent for every ordinary AI-model call (they get the shared global
   * {@link MARKUP_BPS}); terminal/Machine billing passes `MACHINE_MARKUP_BPS`
   * here so its 1.5× substrate floor holds independent of AI markup changes.
   */
  markupBpsOverride?: number;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * WAL-5: the AI usage row records the wallet its call was charged to. Written with the
 * charge itself (the settle transaction, or the zero-charge settle), and only while the
 * row names no wallet yet, so a retry or a replay never re-points it.
 */
async function recordUsageWallet(executor: Tx | typeof db, aiUsageLogId: string | null, walletId: string): Promise<void> {
  if (!aiUsageLogId) return;
  await executor
    .update(aiUsageLogs)
    .set({ walletId })
    .where(and(eq(aiUsageLogs.id, aiUsageLogId), isNull(aiUsageLogs.walletId)));
}

/**
 * Within a transaction: lock the balance row, fold this call's sub-cent charge into
 * the per-user remainder, draw the resulting whole cents down monthly-first via the
 * pure core, and persist the result. Three correctness guarantees beyond the naive
 * version:
 *   - Sub-cent (R3): the charge arrives in MILLICENTS; `accruePending` banks the
 *     fraction so cheap calls accumulate instead of rounding to $0.
 *   - Actual decrement (R2b): we record `appliedCents` = what truly left the balance,
 *     not the intended charge, so the ledger reconciles against the balance delta.
 *   - Debt (R2b): when the balance can't cover the charge, the uncovered remainder is
 *     BOTH raised on `debtCents` (the live materialized debt — so the net balance,
 *     monthly + topup − debt, goes negative and the gate blocks further AI) AND written
 *     as an 'adjustment' ledger row (the per-overage incurrence history). The buckets
 *     themselves stay >= 0; the negative lives in `debtCents`, which a purchase pays
 *     down or is netted against carry at the next renewal.
 * If no balance row exists yet, the ledger row is left untouched ('pending') so the
 * reconcile cron settles it once a balance is created. Shared by consumeCredits and
 * settlePendingLedgerRow.
 *
 * Returns whether the decrement actually landed. `false` is the balance-less case
 * above — a resolved transaction that settled NOTHING, which is exactly the shape
 * `consumeCredits` must not report to its caller as a completed settle.
 */
async function decrementAndSettle(
  tx: Tx,
  ledgerId: string,
  userId: string,
  walletId: string,
  chargeMc: number,
  aiUsageLogId: string | null,
  holdId: string | null = null,
): Promise<boolean> {
  const settled = await chargeWallet(tx, walletId, chargeMc, aiUsageLogId);

  // No balance row yet (e.g. an existing user before the gate lazy-inits one).
  // Leave the ledger row 'pending' so the reconcile cron retries once a balance
  // exists — never mark a call 'applied' without decrementing it, which would
  // silently drop the charge and hide it from both backfill sweeps.
  if (!settled) return false;

  await tx
    .update(creditLedger)
    .set({
      consumeStatus: 'applied',
      bucket: settled.bucket,
      // What actually came out of the wallets (signed, matching the usage row's negative
      // convention). The gap between this and the intended charge is the shortfall,
      // recorded as a debt row below. `|| 0` avoids storing -0 when a sub-cent call
      // accrues into pending without decrementing a whole cent.
      appliedCents: -settled.appliedCents || 0,
    })
    .where(eq(creditLedger.id, ledgerId));

  // Uncovered remainder -> persist as debt rather than discard it, on the wallet the debt
  // landed on (WAL-6c). Same txn, so the books reconcile atomically: buckets floored at
  // 0, the overage owed and queryable by aiUsageLogId. consumeStatus is terminal
  // ('applied') so the backfill cron's pending sweep never mistakes this debt row for an
  // unsettled decrement to retry.
  if (settled.debt) {
    await tx.insert(creditLedger).values({
      userId,
      walletId: settled.debt.walletId,
      entryType: 'adjustment',
      bucket: 'monthly',
      amountCents: -settled.debt.cents,
      aiUsageLogId,
      consumeStatus: 'applied',
    });
  }

  await recordUsageWallet(tx, aiUsageLogId, walletId);

  // Release the gate's reservation in the SAME transaction as the decrement: once
  // this call's real cost has left the balance, its hold no longer reserves spend
  // and must not keep shrinking spendable or counting against the in-flight cap.
  // Idempotent — a missing/expired hold (already swept) deletes zero rows.
  if (holdId) {
    await tx.delete(creditHolds).where(eq(creditHolds.id, holdId));
  }
  return true;
}

export interface WalletSettlement {
  appliedCents: number;
  bucket: 'monthly' | 'topup';
  debt: { walletId: string; cents: number } | null;
}

type LockedWallet = WalletBalanceFacts & { pendingMillicents: number };

async function lockWallet(tx: Tx, walletId: string): Promise<LockedWallet | null> {
  const rows = await tx.select().from(wallets).where(eq(wallets.id, walletId)).for('update');
  return (rows[0] as LockedWallet | undefined) ?? null;
}

/**
 * Charge `chargeMc` millicents to one wallet inside the caller's transaction — the ONE
 * charge path, shared by the settle (decrementAndSettle) and a cost-reconcile undercharge
 * correction, so neither can bypass the funding legs. Locks the wallet, then (for a drive
 * wallet) its parent, then its legs: the global order (wallet-legs). The sub-cent
 * remainder carries in the wallet's pendingMillicents. On a drive wallet the call's draws
 * are added to its usage row's record (wallet-draws), so a later refund can return them
 * exactly. `null` when the wallet row does not exist.
 */
export async function chargeWallet(
  tx: Tx,
  walletId: string,
  chargeMc: number,
  aiUsageLogId: string | null,
): Promise<WalletSettlement | null> {
  const bal = await lockWallet(tx, walletId);
  if (!bal) return null;
  // Fold the sub-cent charge into the charged wallet's carried remainder, then spend the
  // whole cents.
  const accrual = accruePending(bal.pendingMillicents ?? 0, chargeMc);
  if (!bal.parentWalletId) return settleOnRootWallet(tx, bal, accrual.wholeCents, accrual.newPending);

  const { settlement, draws } = await settleOnChildWallet(tx, bal, accrual.wholeCents, accrual.newPending);
  if (aiUsageLogId) {
    const usage = await usageMetadata(tx, aiUsageLogId);
    if (usage) {
      const prior = parseWalletDraws(usage.metadata, bal.id);
      await writeWalletDraws(tx, aiUsageLogId, usage.metadata, addWalletDraws(prior.ok ? prior.draws : null, { walletId: bal.id, ...draws }));
    }
  }
  return settlement;
}

async function usageMetadata(tx: Tx, aiUsageLogId: string): Promise<{ metadata: unknown } | null> {
  const [row] = await tx.select({ metadata: aiUsageLogs.metadata }).from(aiUsageLogs).where(eq(aiUsageLogs.id, aiUsageLogId));
  return row ?? null;
}

async function writeWalletDraws(tx: Tx, aiUsageLogId: string, metadata: unknown, draws: WalletDraws): Promise<void> {
  const base = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  await tx.update(aiUsageLogs).set({ metadata: { ...base, walletDraws: draws } }).where(eq(aiUsageLogs.id, aiUsageLogId));
}

/**
 * Give `refundCents` back to the wallet a call was charged to (a cost-reconcile overcharge
 * correction), inside the caller's transaction. The caller makes it idempotent: it runs
 * only when the correction's own ledger row was freshly claimed.
 *   - A ROOT wallet: debt first, the rest to its never-expiring top-up (as before wallets).
 *   - A DRIVE wallet: the call's recorded draws in the inverse order (wallet-draws) —
 *     landed debt, then the legs newest-drawn first (each at most what this call took,
 *     never past a leg's originalCents), then the allocation (spentCents down, the parent
 *     credited debt-first). The record is untrusted: if it is missing (a charge settled
 *     before the record existed, or a pruned usage row), malformed, names another wallet,
 *     disagrees with the refund, or names a leg that is gone or cannot take it back, the
 *     WHOLE refund goes to the parent, debt first, with the legs untouched — logged,
 *     never thrown, never a guessed leg. Either way topupRemainingCents == SUM(legs).
 * Returns the cents actually credited.
 */
export async function refundWalletCharge(tx: Tx, walletId: string, refundCents: number, aiUsageLogId: string | null): Promise<number> {
  const bal = await lockWallet(tx, walletId);
  if (!bal || refundCents <= 0) return 0;
  if (!bal.parentWalletId) {
    const r = applyPaymentToDebt(bal.debtCents ?? 0, bal.topupRemainingCents, refundCents);
    await tx.update(wallets).set({ debtCents: r.debtCents, topupRemainingCents: r.topupCents }).where(eq(wallets.id, walletId));
    return refundCents;
  }
  const parent = await lockWallet(tx, bal.parentWalletId);

  const creditParent = async (cents: number): Promise<number> => {
    if (cents <= 0) return 0;
    if (!parent) {
      loggers.ai.error('reconcile refund has no parent wallet to credit', { walletId, aiUsageLogId, cents });
      return 0;
    }
    const r = applyPaymentToDebt(parent.debtCents ?? 0, parent.topupRemainingCents, cents);
    await tx.update(wallets).set({ debtCents: r.debtCents, topupRemainingCents: r.topupCents }).where(eq(wallets.id, parent.id));
    return cents;
  };
  const legacy = (reason: string): Promise<number> => {
    loggers.ai.warn('reconcile refund on a drive wallet took the parent-debt-first path', { walletId, aiUsageLogId, reason, refundCents });
    return creditParent(refundCents);
  };

  const usage = aiUsageLogId ? await usageMetadata(tx, aiUsageLogId) : null;
  if (!usage) return legacy('usage_row_missing');
  const parsed = parseWalletDraws(usage.metadata, bal.id);
  if (!parsed.ok) return legacy(parsed.reason);
  const plan = planWalletRefund(parsed.draws, refundCents);
  if (!plan) return legacy('refund_exceeds_record');
  if (plan.debtCents > 0 && plan.debtWalletId !== bal.parentWalletId && plan.debtWalletId !== bal.id) return legacy('debt_wallet_unknown');

  const legs = await creditWalletFundingLegs(tx, bal.id, plan.legCredits);
  if (!legs) return legacy('legs_changed');

  // Debt this call landed on the drive wallet itself comes off that debt; any part a later
  // payment already cleared goes to the parent with the rest.
  const ownDebt = plan.debtWalletId === bal.id ? Math.min(plan.debtCents, Math.max(0, bal.debtCents)) : 0;
  const toParent = plan.debtCents - ownDebt + plan.allocationCents;
  await tx
    .update(wallets)
    .set({
      spentCents: Math.max(0, bal.spentCents - plan.allocationCents),
      ...(ownDebt > 0 ? { debtCents: bal.debtCents - ownDebt } : {}),
    })
    .where(eq(wallets.id, bal.id));
  const parentCredited = await creditParent(toParent);
  await writeWalletDraws(tx, aiUsageLogId as string, usage.metadata, plan.remaining);
  return ownDebt + legs.appliedCents + parentCredited;
}

/**
 * A ROOT wallet (a personal wallet, an org pool): draw monthly-first via the pure core.
 * Uncovered cost becomes debt on the same wallet (WAL-6: a seat's overshoot lands on the
 * pool, own credits' on the person who chose them): the net balance (monthly + topup −
 * debt) goes negative and the gate blocks further AI until a purchase pays it down or the
 * next renewal nets it against carry. Buckets still floor at 0; debt carries the overage.
 *
 * Rollover: the carry balance is always spendable, even after the monthly period ends.
 * allocateSpend draws monthly-first, so if we excluded the monthly here a call approved
 * via carry credits would draw from top-up instead, misattributing the spend bucket.
 */
async function settleOnRootWallet(
  tx: Tx,
  bal: WalletBalanceFacts,
  wholeCents: number,
  newPending: number,
): Promise<WalletSettlement> {
  const spend = allocateSpend(
    { monthlyCents: bal.monthlyRemainingCents, topupCents: bal.topupRemainingCents },
    wholeCents,
  );
  await tx
    .update(wallets)
    .set({
      monthlyRemainingCents: spend.monthlyCents,
      topupRemainingCents: spend.topupCents,
      pendingMillicents: newPending,
      ...(spend.shortfallCents > 0
        ? { debtCents: sql`${wallets.debtCents} + ${spend.shortfallCents}` }
        : {}),
    })
    .where(eq(wallets.id, bal.id));
  return {
    appliedCents: spend.appliedCents,
    bucket: spend.spentTopup > spend.spentMonthly ? 'topup' : 'monthly',
    debt: spend.shortfallCents > 0 ? { walletId: bal.id, cents: spend.shortfallCents } : null,
  };
}

/**
 * A CHILD wallet (a drive wallet): the allocation is drawn from the parent as the spend
 * happens (WAL-3), then the wallet's own funding legs, FIFO, through the locked-legs draw
 * that keeps topupRemainingCents equal to SUM(legs.remainingCents) (D-OW-13) — so a
 * refund plans from what a leg truly still holds and each donor's share stays attributed.
 * Overshoot never lands on the consumer: it lands where the wallet's funder chose
 * (WAL-6b/c) — absorbed into the parent's debt by default (D20.2), or carried as this
 * wallet's debt. Locks: this wallet (the caller), its parent, then its legs — the global
 * order (wallet-legs).
 */
async function settleOnChildWallet(
  tx: Tx,
  bal: WalletBalanceFacts,
  wholeCents: number,
  newPending: number,
): Promise<{ settlement: WalletSettlement; draws: Omit<WalletDraws, 'walletId' | 'totalCents'> }> {
  const parentId = bal.parentWalletId as string;
  const parentRows = await tx
    .select()
    .from(wallets)
    .where(eq(wallets.id, parentId))
    .for('update');
  const parent = parentRows[0] as WalletBalanceFacts | undefined;

  // The allocation draw alone (no legs): what the parent funds of this spend.
  const draw = allocateWalletSpend({
    parent: parent
      ? { monthlyCents: parent.monthlyRemainingCents, topupCents: parent.topupRemainingCents, debtCents: parent.debtCents }
      : { monthlyCents: 0, topupCents: 0, debtCents: 0 },
    wallet: { ...childWalletFunds(bal), topupLegs: [] },
    amountCents: wholeCents,
  });
  // The rest from the stored legs, which also moves topupRemainingCents by what they gave.
  const legs = draw.shortfallCents > 0
    ? await drawWalletFundingLegs(tx, bal.id, draw.shortfallCents)
    : { draws: [], appliedCents: 0, shortfallCents: 0 };
  const appliedCents = draw.appliedCents + legs.appliedCents;
  const landing = settleOvershoot({
    source: 'drive_wallet',
    overshootCents: legs.shortfallCents,
    chargedWalletId: bal.id,
    parentWalletId: parent ? parent.id : null,
    // The funder's overshoot choice has no storage yet; the default applies (D20.2).
    funderChoice: DEFAULT_OVERSHOOT_CHOICE,
    fallbackFrom: null,
  });

  if (parent) {
    await tx
      .update(wallets)
      .set({
        monthlyRemainingCents: draw.parent.monthlyCents,
        topupRemainingCents: draw.parent.topupCents,
        ...(landing.kind === 'parent_debt' ? { debtCents: sql`${wallets.debtCents} + ${landing.cents}` } : {}),
      })
      .where(eq(wallets.id, parent.id));
  }
  // topupRemainingCents is NOT written here: drawWalletFundingLegs moved it with the legs.
  await tx
    .update(wallets)
    .set({
      spentCents: draw.wallet.allocationSpentCents,
      pendingMillicents: newPending,
      ...(landing.kind === 'wallet_debt' ? { debtCents: sql`${wallets.debtCents} + ${landing.cents}` } : {}),
    })
    .where(eq(wallets.id, bal.id));

  const debt = landing.kind === 'none' ? null : { walletId: landing.walletId, cents: landing.cents };
  return {
    settlement: {
      appliedCents,
      bucket: legs.appliedCents > draw.allocationDrawCents ? 'topup' : 'monthly',
      debt,
    },
    draws: {
      allocationCents: draw.allocationDrawCents,
      legs: legs.draws,
      debtCents: debt?.cents ?? 0,
      debtWalletId: debt?.walletId ?? null,
    },
  };
}

/**
 * What one `consumeCredits` call did with the charge — the honest answer to
 * "is this call's money accounted for?", which `Promise<void>` could not give.
 *
 *  - `settled`    the charge is accounted for: decremented, or deliberately not
 *                 owed (a $0 call recorded as 'skipped', a duplicate claim that
 *                 was already consumed, or a deployment where billing is off).
 *  - `deferred`   a write did not land and the ledger row is left for
 *                 `credit-backfill.ts` to recover — the pending sweep if a row was
 *                 claimed, the orphan sweep if it was not. NOT a lost charge, and
 *                 nothing upstream should re-bill the window on it: the sweep will
 *                 settle it, and re-billing would charge the payer twice.
 *  - `unbillable` the cost was not a finite non-negative number, so there is
 *                 nothing to settle and nothing to recover. A programming/upstream
 *                 error, reported rather than folded into `deferred` so it cannot
 *                 be mistaken for work a cron will finish.
 */
export type CreditSettleStatus = 'settled' | 'deferred' | 'unbillable';

/**
 * The wallet a call settles on (WAL-5). The gate's hold names the wallet the call was
 * admitted against, so while the hold is present IT decides: a caller's `walletId` that
 * disagrees is refused (logged, never charged) and the charge settles where the hold was
 * placed — a hold on one wallet is never settled on another, and the drive hold is never
 * deleted by a settle on the personal root. Refusing by writing nothing would not help:
 * the orphan sweep re-bills an unclaimed call to the payer's personal root, the same
 * wrong wallet. With no hold (the reconcile cron, an expired hold), the caller's wallet,
 * else the payer's personal root, as before wallets.
 */
async function settleWalletId(input: ConsumeCreditsInput): Promise<string> {
  if (input.holdId) {
    const [hold] = await db
      .select({ walletId: creditHolds.walletId })
      .from(creditHolds)
      .where(eq(creditHolds.id, input.holdId));
    if (hold) {
      if (input.walletId !== undefined && input.walletId !== hold.walletId) {
        loggers.ai.error('credit settle wallet does not match its hold', {
          holdId: input.holdId,
          holdWalletId: hold.walletId,
          requestedWalletId: input.walletId,
          aiUsageLogId: input.aiUsageLogId,
        });
      }
      return hold.walletId;
    }
  }
  return input.walletId ?? ensurePersonalRootWalletId(db, input.userId);
}

export async function consumeCredits(input: ConsumeCreditsInput): Promise<CreditSettleStatus> {
  if (!isBillingEnabled()) return 'settled'; // tenant/onprem are unlimited

  // Guard a malformed cost before it can produce a bogus ledger claim. A
  // non-finite or negative cost is a programming/upstream error, not a billable
  // event — skip it rather than persist a garbage row. (cost 0 is valid: free
  // models bill nothing.)
  if (!Number.isFinite(input.costDollars) || input.costDollars < 0) {
    loggers.ai.debug('credit consume skipped: invalid cost', {
      costDollars: input.costDollars,
      aiUsageLogId: input.aiUsageLogId,
    });
    return 'unbillable';
  }

  // The precise charge in millicents (sub-cent accurate). The whole-cent `amountCents`
  // on the claim row is the per-call nominal charge for audit; the authoritative
  // sub-cent value is `chargeMillicents`, which settlement and any retry replay.
  const markupBps = input.markupBpsOverride ?? MARKUP_BPS;
  const chargeMc = chargeMillicents(input.costDollars, markupBps);
  const nominalCents = Math.round(chargeMc / 1000);
  // Signed (negative) for the usage row; `|| 0` avoids storing -0 for a sub-cent charge.
  const amountCents = -nominalCents || 0;
  const realCostCents = Math.max(0, Math.round(input.costDollars * 100));

  // 1. Idempotent claim — one usage ledger row per aiUsageLogId, against the wallet the
  // gate reserved on (WAL-5), or the payer's personal root wallet when the call named
  // none. A user with no wallet yet gets a bare one: its empty buckets settle the charge
  // as debt, which their first grant then nets (see personal-wallet).
  let ledgerId: string;
  let walletId: string;
  try {
    walletId = await settleWalletId(input);
    const claimed = await db
      .insert(creditLedger)
      .values({
        userId: input.userId,
        walletId,
        entryType: 'usage',
        bucket: 'monthly',
        amountCents,
        chargeMillicents: chargeMc,
        aiUsageLogId: input.aiUsageLogId,
        realCostCents,
        markupBps,
        consumeStatus: 'pending',
      })
      // The unique index on aiUsageLogId is partial (WHERE aiUsageLogId IS NOT NULL
      // AND entryType = 'usage'); Postgres can only infer it as the conflict arbiter
      // if we restate that predicate. Scoping to 'usage' lets a debt 'adjustment' row
      // share the same aiUsageLogId without tripping the usage-decrement uniqueness.
      .onConflictDoNothing({
        target: creditLedger.aiUsageLogId,
        where: sql`${creditLedger.aiUsageLogId} IS NOT NULL AND ${creditLedger.entryType} = 'usage'`,
      })
      .returning({ id: creditLedger.id });
    if (claimed.length === 0) return 'settled'; // already consumed — idempotent no-op
    ledgerId = claimed[0].id;
  } catch (error) {
    // No ledger row persisted; the cron's orphan sweep will reconcile.
    loggers.ai.debug('credit claim failed', {
      error: (error as Error).message,
      aiUsageLogId: input.aiUsageLogId,
    });
    return 'deferred';
  }

  // A zero-charge call (free/local model, or a tool-only analytics log carrying
  // no tokens) has nothing to draw down — not even a sub-cent fraction to carry.
  // Settle the claimed row as 'skipped' without opening the balance transaction —
  // no row lock, no $0 decrement. The claim row still exists, so the reconcile
  // cron's orphan sweep treats this call as already handled and never re-processes
  // it. NOTE: a sub-cent call has chargeMc > 0 and is NOT skipped here — it goes
  // through the transaction so its fraction accrues into pendingMillicents.
  if (chargeMc === 0) {
    let zeroChargeSettled = true;
    try {
      await db
        .update(creditLedger)
        .set({ consumeStatus: 'skipped' })
        .where(eq(creditLedger.id, ledgerId));
      await recordUsageWallet(db, input.aiUsageLogId, walletId);
      // A zero-charge call still placed a hold at the gate (the gate runs before the
      // real cost is known). Release it so it doesn't reserve phantom spend or keep
      // counting against the in-flight cap until it expires.
      if (input.holdId) {
        await db.delete(creditHolds).where(eq(creditHolds.id, input.holdId));
        // Releasing the hold frees the user's spendable — push the fresh balance.
        void emitCreditsUpdated(input.userId, {
          conversationId: input.conversationId,
          pageId: input.pageId,
        });
      }
    } catch (error) {
      // The claim row exists but never reached a terminal status, so the backfill
      // cron's pending sweep owns it from here.
      zeroChargeSettled = false;
      loggers.ai.debug('credit zero-charge settle failed', {
        error: (error as Error).message,
        aiUsageLogId: input.aiUsageLogId,
      });
    }
    return zeroChargeSettled ? 'settled' : 'deferred';
  }

  // 2. Decrement the balance and settle the ledger row, atomically.
  // Captured from INSIDE the callback rather than read off the transaction's return
  // value: what we need to know is whether the decrement ran, and a driver/mock that
  // does not pass the callback's result back through would silently turn every
  // successful settle into a `deferred`.
  let applied = false;
  try {
    await db.transaction(async (tx) => {
      applied = await decrementAndSettle(
        tx,
        ledgerId,
        input.userId,
        walletId,
        chargeMc,
        input.aiUsageLogId,
        input.holdId ?? null,
      );
    });
    // A committed transaction that decremented NOTHING (no balance row yet) left
    // the ledger row 'pending' on purpose — report it as deferred rather than as a
    // settle, or the meters above would treat a charge the cron still owes as done.
    if (!applied) return 'deferred';
    // The debit + hold release committed: push the user's fresh balance so the navbar
    // reflects this call's spend live (no refresh). Best-effort, never blocks the call.
    void emitCreditsUpdated(input.userId, {
      conversationId: input.conversationId,
      pageId: input.pageId,
    });
  } catch (error) {
    // Leave the row 'pending' for the backfill cron to retry. Never throw.
    loggers.ai.debug('credit consume failed', {
      error: (error as Error).message,
      aiUsageLogId: input.aiUsageLogId,
    });
    return 'deferred';
  }
  return 'settled';
}

/**
 * Release a gate reservation without billing. Used when a request placed a hold
 * but produced no billable usage — e.g. a pre-generation failure (0 tokens) that
 * never reaches consumeCredits — so the reservation isn't left to linger against
 * the user's spendable / in-flight cap until the reconcile cron expires it.
 * Deletes in EVERY deployment mode: billing-off deployments reserve holds too
 * (the daily-ceiling path in canConsumeAI), and those must not linger either.
 * Idempotent and never throws: a missing/expired hold deletes zero rows.
 */
export async function releaseHold(holdId: string): Promise<void> {
  try {
    // Return the hold's owner so we can push their freed balance. A missing/expired
    // hold deletes zero rows and yields no userId — then there's nothing to emit.
    const deleted = await db
      .delete(creditHolds)
      .where(eq(creditHolds.id, holdId))
      .returning({ userId: creditHolds.userId });
    const userId = deleted[0]?.userId;
    // The credits push is a billing-UI concern — skip it when billing is off.
    if (userId && isBillingEnabled()) void emitCreditsUpdated(userId);
  } catch (error) {
    loggers.ai.debug('credit hold release failed', { error: (error as Error).message, holdId });
  }
}

/**
 * Re-apply a ledger row that was claimed but never settled (consumeCredits
 * crashed/failed after the claim). Reads the row's stored amount, then decrements
 * atomically. A no-op if the row is missing or already applied — safe to retry.
 */
export async function settlePendingLedgerRow(ledgerId: string): Promise<void> {
  let settledUserId: string | null = null;
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.id, ledgerId))
      .for('update');
    const row = rows[0] as
      | {
          userId: string;
          walletId: string;
          amountCents: number;
          chargeMillicents: number | null;
          aiUsageLogId: string | null;
          consumeStatus: string;
        }
      | undefined;
    if (!row || row.consumeStatus !== 'pending') return;
    // Replay the precise sub-cent charge. Pre-migration rows have no millicents
    // stored; fall back to the whole-cent intended charge (loses <1 cent of
    // precision on those legacy rows only).
    const chargeMc = row.chargeMillicents ?? Math.abs(row.amountCents) * 1000;
    // Settle against the wallet the claim named (WAL-5), never re-derived from the user.
    await decrementAndSettle(tx, ledgerId, row.userId, row.walletId, chargeMc, row.aiUsageLogId);
    settledUserId = row.userId;
  });
  // A pending row settled this run (cron retry): push the user's fresh balance so a
  // call that never emitted at its own finish still reaches the navbar live.
  if (settledUserId) void emitCreditsUpdated(settledUserId);
}
