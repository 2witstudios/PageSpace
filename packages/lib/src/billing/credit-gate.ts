/**
 * credit-gate — the fast, pre-request prepaid check. Reads the denormalized
 * personal root wallet (the former credit_balances row) and asks the pure evaluateGate
 * whether the user may spend.
 * Never calls Stripe; the hot path stays a single indexed read.
 *
 * A missing balance row is lazy-initialized from the tier's allowance (this is how a
 * brand-new free user gets their ONE-TIME starter grant without a Stripe
 * subscription — the `free-init-<userId>` ledger key makes it happen exactly once)
 * and then re-evaluated.
 *
 * Paid tiers WITHOUT a renewal-capable subscription (comped/founder accounts) get
 * their periodic top-up HERE: there's no invoice.paid to drive a refill, so when the
 * period has expired the gate ADDS the tier allowance to the carry balance (rollover)
 * and rolls the window forward. Which tiers refill at all is data
 * (TIER_ALLOWANCE_REFILLS): the free tier does NOT — its allowance is a single grant,
 * so an expired free window is simply left alone. This is the imperative shell, so
 * it owns the real clock; the period math stays trivial and the rollover itself
 * comes from the pure computeMonthlyRefill.
 */

import { db } from '@pagespace/db/db';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { wallets, personalRootWalletOf, PERSONAL_ROOT_WALLET_ARBITER } from '@pagespace/db/schema/wallets';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { and, eq, gt, gte, inArray, or, sql } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import {
  evaluateGate,
  evaluateDailyCap,
  computeMonthlyRefill,
  reservationCents,
  holdExpiresAt,
  type GateResult,
} from './credit-core';
import {
  RESERVE_FLOOR_CENTS,
  allowanceRefills,
  isOneTimeAllowanceTier,
  CREDIT_HOLD_ESTIMATE_CENTS,
  CREDIT_HOLD_TTL_SECONDS,
  MAX_FREE_INFLIGHT,
  dailyExposureCapForTier,
} from './credit-pricing';
import { readSpendableCents } from './credit-balance';
import { tierAllowanceCents } from './money-model';
import { isSubscriptionTier } from './subscription-tiers';
import { ensurePersonalRootWalletId } from './personal-wallet';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';
import {
  personalRootDecision,
  resolvesDriveWallets,
  walletSpendableCents,
  type SpendTarget,
  type WalletBalanceFacts,
} from './spend-target';
import type { RefusalReason, SkipReason, SpendSourceKind } from './wallet-core';
import type { SubscriptionTier } from '../services/subscription-utils';

// The partial unique index credit_ledger_stripe_ref_unique is defined WHERE
// stripeRef IS NOT NULL; Postgres only infers it as the ON CONFLICT arbiter when
// we restate that predicate (mirrors the same constant in credit-funding.ts).
const STRIPE_REF_ARBITER = {
  target: creditLedger.stripeRef,
  where: sql`${creditLedger.stripeRef} IS NOT NULL`,
} as const;

/**
 * One calendar month after `from`, clamped to the last valid day of the target
 * month so a month-end start doesn't overflow. Naive `setUTCMonth(+1)` turns
 * Jan 31 into Mar 3 (Feb has no 31st), which would make a "monthly" window longer
 * than a month and delay the next allowance reset for users initialized near
 * month end. Clamping maps Jan 31 -> Feb 28/29. Time-of-day is preserved.
 * Exported for direct edge-case testing.
 */
export function addOneMonth(from: Date): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1); // avoid overflow while we shift the month
  d.setUTCMonth(d.getUTCMonth() + 1);
  const lastDayOfTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTarget));
  return d;
}

/**
 * Midnight UTC of the day containing `from`. Defines the window for the per-user/day
 * exposure cap; UTC (not local) so the cap resets at a fixed instant regardless of where
 * a user is. Exported for direct testing.
 */
export function startOfUtcDay(from: Date): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
}

interface BalanceRow {
  /** The personal root wallet's id (WAL-5): every ledger and hold row written here names it. */
  id: string;
  monthlyRemainingCents: number;
  topupRemainingCents: number;
  debtCents: number;
  monthlyPeriodEnd: Date | null;
}

/**
 * Subscription statuses whose renewal invoice may still arrive: `invoice.paid`
 * stays authoritative for these (a gate roll would double-grant when the invoice
 * lands or replays). `unpaid` is included — Stripe keeps its open invoices
 * collectible, so a later payment still fires invoice.paid. Everything else —
 * canceled, incomplete, incomplete_expired, or no subscription row at all
 * (comped/founder accounts) — will never produce an invoice, so the gate is the
 * only thing that can roll them. Exported so other surfaces that need a "live
 * subscription" filter converge on one definition instead of drifting copies.
 */
export const RENEWAL_CAPABLE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid'];

/**
 * The ledger row for a tier's first-ever allowance grant. The stripeRef is
 * USER-scoped (no timestamp) on purpose: the partial unique index on stripeRef makes
 * it the exactly-once key shared by the lazy-init path and the bare-row starter-grant
 * path, so whichever lands first wins and the other is a no-op.
 */
function starterGrantLedgerRow(userId: string, walletId: string, monthly: number) {
  return {
    userId,
    walletId,
    entryType: 'monthly_grant',
    bucket: 'monthly',
    amountCents: monthly,
    stripeRef: `free-init-${userId}`,
    consumeStatus: 'applied',
  } as const;
}

/**
 * Whether ANY of the user's subscriptions could still deliver an invoice-driven
 * refill. Takes the executor so the reset transaction can RE-CHECK on `tx`
 * right before granting — a subscription created between the unlocked pre-check
 * and the grant (checkout completing concurrently with an AI request) would
 * otherwise double-grant when its first invoice.paid lands.
 */
async function hasRenewalCapableSubscription(
  executor: Pick<typeof db, 'select'>,
  userId: string,
): Promise<boolean> {
  const rows = await executor
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, RENEWAL_CAPABLE_STATUSES)))
    .limit(1);
  return rows.length > 0;
}

export interface GateOptions {
  /**
   * Override the per-call reservation (in whole cents) for this gate check. The
   * chat path omits it and uses the CREDIT_HOLD_ESTIMATE_CENTS default; voice
   * routes pass a per-call estimate so a sub-cent STT/TTS call doesn't reserve the
   * full chat estimate. Only bounds the in-flight hold — the real cost still settles
   * exactly via consumeCredits.
   */
  estCostCents?: number;
  /**
   * Cap on this user's concurrent in-flight calls, applied to ALL tiers (combined
   * with the free-tier cap via min). Voice routes pass VOICE_MAX_INFLIGHT to bound
   * concurrent paid voice spend, which the per-call hold alone can't (the real cost
   * only lands at settle). Omitted by chat, which leaves paid tiers uncapped.
   */
  maxInFlight?: number;
  /**
   * Skip the per-user/day exposure cap for this call. Set by internal/system callers
   * (e.g. the scheduled pulse cron) whose spend shouldn't be bounded by a per-user daily
   * ceiling meant for interactive runaway protection. User-driven routes omit it.
   */
  skipDailyCap?: boolean;
  /**
   * Per-user/day charged-spend ceiling (whole cents) applied IN ADDITION to the tier
   * cap — the effective cap is the smaller of the two — and, unlike the tier cap,
   * it binds even on deployments where DAILY_USER_EXPOSURE_CAP_CENTS is unset
   * (0 = disabled) AND on billing-disabled deployments (tenant/onprem), where the
   * day's spend is metered from aiUsageLogs instead of the credit ledger. Passed by
   * callers whose runs are forced by a bearer credential (the page-webhook trigger
   * path), so an unconfigured deployment still bounds what a leaked secret can spend
   * per day. Zero/negative values are ignored. Independent of skipDailyCap: an
   * explicit ceiling is the caller's own opt-in bound, not the interactive runaway
   * backstop that skipDailyCap exists to bypass.
   */
  dailyCapCeilingCents?: number;
  /**
   * WHERE the call spends, named before it runs (SPEND-1): the drive of the session it runs
   * in (SPEND-7) and the source the caller chose, or {@link PERSONAL_SPEND} for a call with
   * no drive (SPEND-8). Required, so no caller can reach a wallet it did not name: the gate
   * reserves on exactly the wallet this resolves to and never switches (SPEND-4).
   */
  spend: SpendTarget;
}

/**
 * A refused source (SPEND-4): the source that was refused, why, and the other sources this
 * person may pick that cover the call. Nothing was reserved or charged.
 */
export interface SpendRefusal {
  source: SpendSourceKind | null;
  reason: RefusalReason | SkipReason;
  options: SpendSourceKind[];
}

/**
 * The gate's answer. On an allowed call it names the wallet the hold was placed on
 * (`walletId`, WAL-5), which the caller threads to settlement with the hold, the source it
 * spends, and the tier whose entitlements govern the call (WAL-8). A refused source carries
 * `refusal` with reason `source_refused`.
 */
export interface CreditGateResult extends GateResult {
  walletId?: string;
  spendSource?: SpendSourceKind;
  entitlementTier?: SubscriptionTier;
  refusal?: SpendRefusal;
}

/** Normalize the caller-supplied daily ceiling: zero/negative/absent → null (off). */
function callerCeilingCents(opts: GateOptions): number | null {
  return opts.dailyCapCeilingCents !== undefined && opts.dailyCapCeilingCents > 0
    ? opts.dailyCapCeilingCents
    : null;
}

type GateTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface CallBounds {
  estCost: number;
  maxInFlight: number | null;
  expiresAt: Date;
  dailyCap: number | null;
  dayStart: Date;
}

/** The per-call bounds every wallet path applies: reservation, in-flight cap, hold expiry, daily cap. */
function callBounds(tier: SubscriptionTier, opts: GateOptions, now: Date): CallBounds {
  const estCost = reservationCents(opts.estCostCents ?? CREDIT_HOLD_ESTIMATE_CENTS);
  // Free users are capped on concurrent in-flight calls; paid tiers are bounded by
  // credits alone UNLESS the caller supplies its own cap (voice passes one to bound
  // concurrent paid voice spend). When both apply, the tighter (min) cap wins.
  const caps = [
    tier === 'free' ? MAX_FREE_INFLIGHT : null,
    opts.maxInFlight ?? null,
  ].filter((c): c is number => c !== null);
  const maxInFlight = caps.length > 0 ? Math.min(...caps) : null;
  const expiresAt = new Date(holdExpiresAt(now.getTime(), CREDIT_HOLD_TTL_SECONDS * 1000));

  // Per-user/day exposure cap (null = disabled, the default). Resolved here; the day's
  // charged total is summed inside the gate transaction on the allow path. A caller
  // ceiling tightens (never loosens) the tier cap and applies even when the tier cap
  // is disabled or skipped — see GateOptions.dailyCapCeilingCents.
  const tierDailyCap = opts.skipDailyCap ? null : dailyExposureCapForTier(tier);
  const callerCeiling = callerCeilingCents(opts);
  const dailyCap =
    tierDailyCap !== null && callerCeiling !== null
      ? Math.min(tierDailyCap, callerCeiling)
      : (tierDailyCap ?? callerCeiling);
  return { estCost, maxInFlight, expiresAt, dailyCap, dayStart: startOfUtcDay(now) };
}

/**
 * Per-user/day exposure cap: a runaway loop can stay within the in-flight cap yet
 * accrue real cost all day. Checked only on the allow path (the credit gate denied
 * otherwise) and only when a cap is configured. Sums chargeMillicents — the full
 * intended charge, positive on usage rows and NULL elsewhere (so monthly/topup/debt
 * rows don't count) — rather than appliedCents, so an in-debt user who keeps spending
 * real provider money is still bounded. It bounds the PERSON, whichever wallet pays:
 * the ledger and holds are summed by the caller's userId. Same transaction →
 * consistent read. Returns the denial, or null; NO hold is inserted on a denial.
 */
async function dailyCapDenial(
  tx: GateTx,
  userId: string,
  input: { dailyCap: number | null; dayStart: Date; estCost: number; userReserved: number },
): Promise<CreditGateResult | null> {
  if (input.dailyCap === null) return null;
  const chargedAgg = await tx
    .select({ chargedMc: sql<number>`coalesce(sum(${creditLedger.chargeMillicents}), 0)` })
    .from(creditLedger)
    .where(and(
      eq(creditLedger.userId, userId),
      inArray(creditLedger.entryType, ['usage', 'adjustment']),
      gte(creditLedger.createdAt, input.dayStart),
    ));
  const dailyChargedCents = Math.max(0, Math.floor(Number(chargedAgg[0]?.chargedMc ?? 0) / 1000));
  // Add this user's still-active hold reservations to the settled total: a burst of
  // concurrent requests reserves holds that haven't reached the ledger yet, so without
  // this each serialized gate check would see the same dailyChargedCents and up to
  // maxInFlight estimates could blow past the cap before any settles. estCost is THIS
  // call's reservation (not yet counted).
  const cap = evaluateDailyCap({
    dailyChargedCents: dailyChargedCents + input.userReserved,
    estCostCents: input.estCost,
    capCents: input.dailyCap,
  });
  return cap.allowed ? null : { allowed: false, reason: cap.reason };
}

export async function canConsumeAI(
  userId: string,
  tier: SubscriptionTier,
  opts: GateOptions,
): Promise<CreditGateResult> {
  if (!isBillingEnabled()) {
    // Billing-off deployments (tenant/onprem) have no credit ledger, but a
    // caller-supplied daily ceiling must still bind: a metered provider (e.g.
    // Azure OpenAI on-prem) spends real money, and the ceiling exists precisely
    // for runs forced by a bearer credential. aiUsageLogs is written in EVERY
    // deployment mode, so meter the day's cost from it; concurrent in-flight
    // runs are accounted via creditHolds reservations (a webhook fan-out starts
    // runs concurrently — settled usage alone would let every run of a burst
    // observe the same below-cap total). The per-user advisory lock serializes
    // concurrent decisions the way the billed path's balance row lock does
    // (there is no balance row to lock in this mode). The caller releases the
    // hold after the run (releaseHold deletes in every mode); an abandoned hold
    // expires via its TTL. Without a ceiling this stays the query-free
    // unlimited fast path.
    const ceiling = callerCeilingCents(opts);
    if (ceiling === null) return { allowed: true, reason: 'unlimited' };
    const now = new Date();
    const dayStart = startOfUtcDay(now);
    const estCost = reservationCents(opts.estCostCents ?? CREDIT_HOLD_ESTIMATE_CENTS);
    const expiresAt = new Date(holdExpiresAt(now.getTime(), CREDIT_HOLD_TTL_SECONDS * 1000));
    return await db.transaction(async (tx): Promise<GateResult> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${'billing-off-daily-ceiling:' + userId}))`,
      );
      const holdAgg = await tx
        .select({ reserved: sql<number>`coalesce(sum(${creditHolds.estCents}), 0)` })
        .from(creditHolds)
        .where(and(eq(creditHolds.userId, userId), gt(creditHolds.expiresAt, now)));
      const reserved = Number(holdAgg[0]?.reserved ?? 0);
      const agg = await tx
        .select({ costUsd: sql<number>`coalesce(sum(${aiUsageLogs.cost}), 0)` })
        .from(aiUsageLogs)
        .where(and(eq(aiUsageLogs.userId, userId), gte(aiUsageLogs.timestamp, dayStart)));
      const spentCents = Math.floor(Number(agg[0]?.costUsd ?? 0) * 100);
      const cap = evaluateDailyCap({
        dailyChargedCents: spentCents + reserved,
        estCostCents: estCost,
        capCents: ceiling,
      });
      if (!cap.allowed) return { allowed: false, reason: cap.reason };
      // Holds are per wallet (WAL-5). A billing-off deployment has no balance, so the
      // user's personal root wallet may not exist yet; a bare one carries no money.
      const walletId = await ensurePersonalRootWalletId(tx, userId);
      const inserted = await tx
        .insert(creditHolds)
        .values({ userId, walletId, estCents: estCost, expiresAt })
        .returning({ id: creditHolds.id });
      return { allowed: true, reason: 'unlimited', holdId: inserted[0]?.id };
    });
  }

  // Name the wallet before anything else (SPEND-1). A refusal reserves nothing and charges
  // nothing (SPEND-4). Own credits are the personal root wallet, whose lifecycle (lazy
  // init, starter grant, gate-driven refill) runs below exactly as before wallets; a drive
  // wallet or a seat on the org pool is reserved by gateSharedWallet.
  const reservation = reservationCents(opts.estCostCents ?? CREDIT_HOLD_ESTIMATE_CENTS);
  // The drive-wallet reads (and the permissions they go through) load only when a drive
  // session can resolve to a shared wallet: while orgs are dark, and for a call with no
  // drive, the personal root is answered with no reads, exactly as before wallets.
  const decision = resolvesDriveWallets({ orgsEnabled: ORGS_ENABLED, target: opts.spend })
    ? await (await import('./spend-resolution')).resolveCallSpend({
        userId,
        consumerTier: tier,
        target: opts.spend,
        reservationCents: reservation,
      })
    : personalRootDecision(tier);
  if (decision.kind !== 'spend') {
    return {
      allowed: false,
      reason: 'source_refused',
      refusal: {
        source: decision.kind === 'refuse' ? decision.source : 'drive_wallet',
        reason: decision.reason,
        options: decision.kind === 'refuse' ? decision.options.map((o) => o.source) : [],
      },
    };
  }
  if (decision.source !== 'own_credits') {
    return gateSharedWallet(userId, tier, opts, {
      walletId: decision.walletId,
      source: decision.source,
      entitlementTier: decision.entitlementTier,
    });
  }
  const personalResult = await gatePersonalRoot(userId, tier, opts);
  return personalResult.allowed
    ? { ...personalResult, spendSource: 'own_credits', entitlementTier: decision.entitlementTier }
    : personalResult;
}

/**
 * The caller's personal root wallet: lazy-init, the one-time starter grant, the gate-driven
 * refill for renewal-less paid accounts, then the locked decision and hold. Unchanged from
 * before wallets except that the reservation it nets is what is held against THIS wallet
 * (and its child wallets, which draw their allocation from it), while the in-flight count
 * stays the caller's own calls.
 */
async function gatePersonalRoot(
  userId: string,
  tier: SubscriptionTier,
  opts: GateOptions,
): Promise<CreditGateResult> {
  const now = new Date();

  const readBalance = async (): Promise<BalanceRow | null> => {
    const rows = await db
      .select({
        id: wallets.id,
        monthlyRemainingCents: wallets.monthlyRemainingCents,
        topupRemainingCents: wallets.topupRemainingCents,
        debtCents: wallets.debtCents,
        monthlyPeriodEnd: wallets.monthlyPeriodEnd,
      })
      .from(wallets)
      .where(personalRootWalletOf(userId))
      .limit(1);
    return rows[0] ?? null;
  };

  let row = await readBalance();

  // Gate-driven monthly reset for users whose refill can never come from Stripe.
  // Only tiers that REFILL (TIER_ALLOWANCE_REFILLS) are eligible: the free tier's
  // allowance is a one-time starter grant, so an expired or never-stamped free
  // window is left alone and the user spends down what they have (plus top-ups).
  // A refilling tier rolls here when its window has expired (monthlyPeriodEnd < now)
  // or was never stamped (monthlyPeriodEnd IS NULL — e.g. a top-up funding row
  // created bare before the user's first AI request), and ONLY when no
  // renewal-capable subscription exists (comped/founder accounts — see
  // hasRenewalCapableSubscription): with a live subscription, invoice.paid stays
  // authoritative (keyed to the invoice stripeRef), because resetting here would
  // over-grant if a renewal invoice is late or retried after the period end — the
  // gate would refill, the user could spend, then the webhook would refill again.
  // A paid user with a live subscription and an expired window is therefore
  // (correctly) blocked until their renewal lands. The subscription lookup only
  // runs on the rare expired-window path, never on the hot path.
  //
  // The unlocked `row` read above is only a cheap pre-check: it decides whether a
  // reset is even worth attempting (don't open a transaction when the window is
  // clearly still active). The authoritative balance read + refill computation happen
  // INSIDE the transaction under `FOR UPDATE`, mirroring applyMonthlyRefill in
  // credit-funding.ts. Computing the refill from this pre-transaction snapshot races
  // any concurrent mutation committed between the read and the write: a concurrent
  // settle would have its spend silently un-billed (the reset would overwrite the
  // drawn-down balance with stale_remaining + allowance), and a concurrent
  // debt-clearing top-up would have its debt collected twice (the reset re-nets the
  // already-paid debt). Reading the row under the lock closes both interleavings.
  const windowExpired = row !== null && (row.monthlyPeriodEnd === null || row.monthlyPeriodEnd < now);
  // Only tiers in the canonical vocabulary may roll: callers pass users.subscriptionTier
  // through unchecked casts, and a legacy/unknown value (e.g. 'normal') reaching
  // computeMonthlyRefill would silently rewrite the account to the free allowance.
  const tierHasAllowance = isSubscriptionTier(tier);
  // Free never refills, so the (rare) subscription lookup is only ever reached by a
  // refilling tier with an expired window.
  if (
    windowExpired &&
    tierHasAllowance &&
    allowanceRefills(tier) &&
    !(await hasRenewalCapableSubscription(db, userId))
  ) {
    const newEnd = addOneMonth(now);
    await db.transaction(async (tx) => {
      // Lock the balance row and RE-READ the current monthly/debt values inside the
      // transaction. The lock serialises concurrent resets for this user and forces
      // us to observe any settle/top-up that committed since the unlocked pre-check.
      const lockedRows = await tx
        .select({
          id: wallets.id,
          monthlyRemainingCents: wallets.monthlyRemainingCents,
          debtCents: wallets.debtCents,
          monthlyPeriodEnd: wallets.monthlyPeriodEnd,
        })
        .from(wallets)
        .where(personalRootWalletOf(userId))
        .for('update');
      const locked = lockedRows[0] ?? null;

      // Re-check the reset predicate against the LOCKED row. A concurrent reset may
      // have rolled the window forward (or the row may have vanished) between our
      // unlocked pre-check and acquiring the lock; if the window is no longer expired,
      // that other request already granted this period — skip to avoid a double grant.
      if (!locked || !(locked.monthlyPeriodEnd === null || locked.monthlyPeriodEnd < now)) {
        return;
      }

      // RE-CHECK the subscription state on the transaction right before
      // granting. The unlocked pre-check races a concurrent checkout — if the
      // customer.subscription.* webhook committed a renewal-capable row since,
      // invoice.paid now owns this user's refill and granting here would double it.
      // (Not fully serialized against the webhook's own transaction, but it shrinks
      // the race from "any time since the pre-check" to the instant before commit.)
      if (await hasRenewalCapableSubscription(tx, userId)) {
        return;
      }

      // Compute the refill from the LOCKED, current balance so unspent credits roll
      // over and outstanding debt is netted against the up-to-date carry (matching the
      // paid invoice.paid path), not against the stale pre-transaction snapshot.
      // No invoice on this path (comped / no-subscription paid account): the grant is
      // derived from the tier's list price (MON-2).
      const refill = computeMonthlyRefill(
        tierAllowanceCents(tier),
        locked.monthlyRemainingCents ?? 0,
        locked.debtCents ?? 0,
      );

      await tx
        .update(wallets)
        .set({
          monthlyRemainingCents: refill.monthlyRemainingCents,
          monthlyAllowanceCents: refill.monthlyAllowanceCents,
          // The renewal-equivalent for free/no-sub users: debt is netted against the
          // carried balance before the allowance is added (refill.debtCents === 0).
          debtCents: refill.debtCents,
          monthlyPeriodStart: now,
          monthlyPeriodEnd: newEnd,
        })
        .where(personalRootWalletOf(userId));

      // Record the grant. We only reach here holding the lock with a confirmed-expired
      // window, so this call owns the reset; onConflictDoNothing on the period-keyed
      // stripeRef is a belt-and-suspenders guard against a same-instant duplicate key.
      await tx
        .insert(creditLedger)
        .values({
          userId,
          walletId: locked.id,
          entryType: 'monthly_grant',
          bucket: 'monthly',
          amountCents: refill.monthlyAllowanceCents,
          // Historical free-tier rolls (before free became a one-time grant) were
          // keyed 'free-reset-…'; only refilling tiers reach here now, so every new
          // row gets the 'gate-reset-' prefix.
          stripeRef: `gate-reset-${userId}-${now.toISOString()}`,
          consumeStatus: 'applied',
        })
        .onConflictDoNothing(STRIPE_REF_ARBITER);
    });
    row = await readBalance();
  }

  // Lazy-init from tier defaults so a balance row always exists before the
  // authoritative hold transaction below. A free user's very first request has no
  // row yet; init it from the tier allowance and stamp a period window so the reset
  // path above can later roll it (a free user with no Stripe invoice would otherwise
  // never reset). onConflictDoNothing tolerates a concurrent init — the transaction
  // judges the REAL persisted balance under a row lock, never our assumed allowance,
  // so we can't allow when a racing request already drew the row down.
  if (!row) {
    const monthly = tierAllowanceCents(tier);
    await db.transaction(async (tx) => {
      const balanceInserted = await tx
        .insert(wallets)
        .values({
          userId,
          monthlyRemainingCents: monthly,
          monthlyAllowanceCents: monthly,
          topupRemainingCents: 0,
          monthlyPeriodStart: now,
          monthlyPeriodEnd: addOneMonth(now),
        })
        .onConflictDoNothing(PERSONAL_ROOT_WALLET_ARBITER)
        .returning({ id: wallets.id });
      // Only record the grant when THIS transaction created the balance row.
      // If a concurrent top-up or invoice.paid already created the row between
      // readBalance() and here, balanceInserted is empty and we skip the ledger
      // write — that path writes its own grant/purchase entry, and a phantom
      // monthly_grant here would overstate the user's credits in the drift formula.
      if (balanceInserted.length > 0) {
        await tx
          .insert(creditLedger)
          .values(starterGrantLedgerRow(userId, balanceInserted[0].id, monthly))
          .onConflictDoNothing(STRIPE_REF_ARBITER);
      }
    });
  }

  // Starter grant for a NON-refilling tier whose row already exists but was never
  // granted. A top-up purchase before the user's first AI call (or a top-up racing
  // the lazy-init above, caught on the next call) creates a bare personal wallet
  // row with no period stamped.
  // A refilling tier gets such a row rolled by the reset path; free is excluded from
  // that path, so without this branch a user who bought credits first would
  // permanently miss the advertised starter grant. Eligibility is decided by the
  // LEDGER, not by the row: the user-scoped `free-init-<userId>` key is inserted
  // FIRST, and the balance is funded only when that insert actually lands — so a
  // concurrent init, or a grant already recorded under the old monthly scheme, can
  // never double-fund. The increment is one relative UPDATE, atomic against a
  // concurrent top-up's own locked write to the same row.
  if (row && row.monthlyPeriodEnd === null && isOneTimeAllowanceTier(tier)) {
    const monthly = tierAllowanceCents(tier);
    const walletId = row.id;
    await db.transaction(async (tx) => {
      const granted = await tx
        .insert(creditLedger)
        .values(starterGrantLedgerRow(userId, walletId, monthly))
        .onConflictDoNothing(STRIPE_REF_ARBITER)
        .returning({ id: creditLedger.id });
      if (granted.length === 0) return;
      await tx
        .update(wallets)
        .set({
          monthlyRemainingCents: sql`${wallets.monthlyRemainingCents} + ${monthly}`,
          monthlyAllowanceCents: monthly,
          monthlyPeriodStart: now,
          monthlyPeriodEnd: addOneMonth(now),
        })
        .where(personalRootWalletOf(userId));
    });
    row = await readBalance();
  }

  const { estCost, maxInFlight, expiresAt, dailyCap, dayStart } = callBounds(tier, opts, now);

  // Authoritative decision + reservation, atomic under a balance row lock. The lock
  // serializes this user's concurrent requests so they observe each other's holds —
  // two simultaneous calls can't both pass a check that only one call's worth of
  // credit can cover, and the free-tier in-flight count can't be undercounted.
  const result = await db.transaction(async (tx): Promise<CreditGateResult> => {
    const balRows = await tx
      .select({
        id: wallets.id,
        monthlyRemainingCents: wallets.monthlyRemainingCents,
        topupRemainingCents: wallets.topupRemainingCents,
        debtCents: wallets.debtCents,
        monthlyPeriodEnd: wallets.monthlyPeriodEnd,
      })
      .from(wallets)
      .where(personalRootWalletOf(userId))
      .for('update');
    const bal = balRows[0] ?? null;

    // Still-active holds (calls in flight). Expired holds are excluded — they no longer
    // reserve spend and are reclaimed by the reconcile cron — so a crashed stream can't
    // permanently shrink spendable or block the in-flight cap forever.
    //   - reserved: what is held against THIS wallet (WAL-5), including holds on its child
    //     wallets, whose allocation is drawn from it as they spend.
    //   - inFlight / userReserved: this caller's own calls, on any wallet — the in-flight
    //     cap and the daily exposure backstop bound a person, not a wallet.
    const heldAgainstWallet = bal
      ? sql`(${creditHolds.walletId} = ${bal.id} OR ${creditHolds.walletId} IN (SELECT ${wallets.id} FROM ${wallets} WHERE ${wallets.parentWalletId} = ${bal.id}))`
      : sql`false`;
    const heldByUser = sql`${creditHolds.userId} = ${userId}`;
    const holdAgg = await tx
      .select({
        reserved: sql<number>`coalesce(sum(${creditHolds.estCents}) FILTER (WHERE ${heldAgainstWallet}), 0)`,
        inFlight: sql<number>`count(*) FILTER (WHERE ${heldByUser})`,
        userReserved: sql<number>`coalesce(sum(${creditHolds.estCents}) FILTER (WHERE ${heldByUser}), 0)`,
      })
      .from(creditHolds)
      .where(and(or(heldByUser, heldAgainstWallet), gt(creditHolds.expiresAt, now)));
    const reserved = Number(holdAgg[0]?.reserved ?? 0);
    const inFlight = Number(holdAgg[0]?.inFlight ?? 0);
    const userReserved = Number(holdAgg[0]?.userReserved ?? 0);

    // Rollover: the monthly bucket is always spendable — credits never expire. A paid user
    // whose window has lapsed continues to spend from their carried balance; the renewal
    // invoice.paid will then add the new allowance on top of whatever remains (not reset).
    // A free user's allowance is a one-time grant (never refilled), so an expired free
    // window is simply a user spending down what they have — no reset applies to it.
    // The gate still does NOT refill paid tiers — invoice.paid is
    // authoritative for that — so there is no double-grant risk: the refill reads the
    // current DB balance inside its own transaction and adds the allowance to whatever is
    // there, exactly accounting for any spend that happened during the gap.
    const result = evaluateGate({
      billingEnabled: true,
      balance: bal
        ? {
            monthlyCents: bal.monthlyRemainingCents,
            topupCents: bal.topupRemainingCents,
            // Outstanding overage drags net spendable down: a user in the red must get
            // back to net-positive (buy credits, or wait for the renewal that nets
            // the debt against carry) before the gate allows again.
            debtCents: bal.debtCents,
          }
        : null,
      reserveFloorCents: RESERVE_FLOOR_CENTS,
      reservedCents: reserved,
      estCostCents: estCost,
      inFlightCount: inFlight,
      maxInFlight,
    });

    // evaluateGate never allows a missing balance (needs_init), so `bal` is set past here.
    if (!result.allowed || !bal) return result;

    // Per-user/day exposure cap: a runaway loop can stay within the in-flight cap yet
    // accrue real cost all day. Checked only on the allow path (the credit gate denied
    // otherwise) and only when a cap is configured. Sums chargeMillicents — the full
    // intended charge, positive on usage rows and NULL elsewhere (so monthly/topup/debt
    // rows don't count) — rather than appliedCents, so an in-debt user who keeps spending
    // real provider money is still bounded. Same transaction → consistent read. NO hold
    // is inserted on a cap denial.
    const capDenied = await dailyCapDenial(tx, userId, { dailyCap, dayStart, estCost, userReserved });
    if (capDenied) return capDenied;

    // Reserve this call's estimated spend AND register it as one in-flight call.
    // consumeCredits deletes the hold at settle; a crashed stream leaves it for the
    // reconcile sweep to expire.
    const inserted = await tx
      .insert(creditHolds)
      .values({ userId, walletId: bal.id, estCents: estCost, expiresAt })
      .returning({ id: creditHolds.id });

    // Net spendable after ALL holds (existing `reserved` + this call's `estCost`) and
    // debt — the same quantity evaluateGate checked. Stored so onStepFinish can guard
    // the per-stream abort budget without an extra DB read. Each concurrent stream gets
    // only its fair slice, not the gross bucket balance (which would let N streams each
    // consume nearly the full balance before aborting, collectively exceeding the cap).
    const netSpendableCents = bal
      ? bal.monthlyRemainingCents + bal.topupRemainingCents - (bal.debtCents ?? 0) - reserved - estCost
      : 0;

    return {
      ...result,
      holdId: inserted[0]?.id,
      walletId: bal.id,
      balanceSnapshot: bal ? { netSpendableCents } : undefined,
    };
  });

  // NOTE: we deliberately do NOT emit a balance update when the hold is placed. Holds
  // are hidden from the displayed balance (see getCreditBalance), and the navbar should
  // step down only when the call SETTLES to its real cost (consumeCredits emits then).
  // Emitting here pushed the reservation into the headline, making it dip on call start
  // and pop back up at settle — the "more → less → more" flicker. An abandoned/crashed
  // call leaves a dangling hold for the reconcile sweep (credit-backfill) to expire; it
  // no longer affects the displayed balance, so no gate-time push is needed.

  return result;
}

const SHARED_WALLET_FACTS = {
  id: wallets.id,
  status: wallets.status,
  parentWalletId: wallets.parentWalletId,
  monthlyRemainingCents: wallets.monthlyRemainingCents,
  monthlyAllowanceCents: wallets.monthlyAllowanceCents,
  spentCents: wallets.spentCents,
  topupRemainingCents: wallets.topupRemainingCents,
  debtCents: wallets.debtCents,
} as const;

/**
 * A shared wallet the caller chose (WAL-5, WAL-6a): a drive wallet, or the org pool behind
 * a seat. The reservation is taken on THAT wallet under its row lock (and its parent's,
 * whose allocation a drive wallet draws — child first, the order settlement locks in), and
 * refused when the wallet cannot cover it, so a wallet is never spent past zero by design.
 * A wallet that cannot cover the call is refused, never swapped for another (SPEND-4).
 * No lazy-init and no refill here: those are the personal root's lifecycle, and a shared
 * wallet's allocation and refill belong to its funder.
 */
async function gateSharedWallet(
  userId: string,
  tier: SubscriptionTier,
  opts: GateOptions,
  chosen: { walletId: string; source: SpendSourceKind; entitlementTier: SubscriptionTier },
): Promise<CreditGateResult> {
  const now = new Date();
  const { estCost, maxInFlight, expiresAt, dailyCap, dayStart } = callBounds(tier, opts, now);
  const refused = (reason: RefusalReason): CreditGateResult => ({
    allowed: false,
    reason: 'source_refused',
    refusal: { source: chosen.source, reason, options: [] },
  });

  return db.transaction(async (tx): Promise<CreditGateResult> => {
    // Lock order is CHILD, then parent — the order settlement uses — so a gate and a
    // settle on the same drive wallet can never wait on each other in a cycle. A root
    // wallet's own paths lock only the root.
    const lock = async (id: string): Promise<WalletBalanceFacts | null> => {
      const rows = await tx.select(SHARED_WALLET_FACTS).from(wallets).where(eq(wallets.id, id)).for('update');
      return rows[0] ?? null;
    };
    const wallet = await lock(chosen.walletId);
    if (!wallet) return refused('source_unavailable');
    const parent = wallet.parentWalletId ? await lock(wallet.parentWalletId) : null;
    if (wallet.status === 'paused') return refused('source_paused');

    // Holds reserved against this wallet and (for a drive wallet) against its parent by
    // everything else, plus this caller's own in-flight calls on any wallet.
    const parentId = parent?.id ?? null;
    const heldByUser = sql`${creditHolds.userId} = ${userId}`;
    const heldOnWallet = sql`${creditHolds.walletId} = ${wallet.id}`;
    const heldOnChildren = sql`${creditHolds.walletId} IN (SELECT ${wallets.id} FROM ${wallets} WHERE ${wallets.parentWalletId} = ${wallet.id})`;
    const heldAgainstParent = parentId
      ? sql`${creditHolds.walletId} <> ${wallet.id} AND (${creditHolds.walletId} = ${parentId} OR ${creditHolds.walletId} IN (SELECT ${wallets.id} FROM ${wallets} WHERE ${wallets.parentWalletId} = ${parentId}))`
      : sql`false`;
    const holdAgg = await tx
      .select({
        own: sql<number>`coalesce(sum(${creditHolds.estCents}) FILTER (WHERE ${heldOnWallet} OR ${heldOnChildren}), 0)`,
        parentReserved: sql<number>`coalesce(sum(${creditHolds.estCents}) FILTER (WHERE ${heldAgainstParent}), 0)`,
        inFlight: sql<number>`count(*) FILTER (WHERE ${heldByUser})`,
        userReserved: sql<number>`coalesce(sum(${creditHolds.estCents}) FILTER (WHERE ${heldByUser}), 0)`,
      })
      .from(creditHolds)
      .where(and(or(heldByUser, heldOnWallet, heldOnChildren, heldAgainstParent), gt(creditHolds.expiresAt, now)));
    const ownReserved = Number(holdAgg[0]?.own ?? 0);
    const parentReserved = Number(holdAgg[0]?.parentReserved ?? 0);
    const inFlight = Number(holdAgg[0]?.inFlight ?? 0);
    const userReserved = Number(holdAgg[0]?.userReserved ?? 0);

    // What this wallet can still cover, already net of its debt and every hold against it
    // (and, for a drive wallet, of what its parent can still fund) — then evaluateGate's
    // one rule: spendable above the reserve floor after this call's reservation.
    const spendable = walletSpendableCents({
      wallet,
      ownReservedCents: ownReserved,
      parent: parent ? { wallet: parent, reservedCents: parentReserved } : null,
    });
    const result = evaluateGate({
      billingEnabled: true,
      balance: { monthlyCents: spendable, topupCents: 0, debtCents: 0 },
      reserveFloorCents: RESERVE_FLOOR_CENTS,
      reservedCents: 0,
      estCostCents: estCost,
      inFlightCount: inFlight,
      maxInFlight,
    });
    if (!result.allowed) return result;

    const capDenied = await dailyCapDenial(tx, userId, { dailyCap, dayStart, estCost, userReserved });
    if (capDenied) return capDenied;

    const inserted = await tx
      .insert(creditHolds)
      .values({ userId, walletId: wallet.id, estCents: estCost, expiresAt })
      .returning({ id: creditHolds.id });

    return {
      ...result,
      holdId: inserted[0]?.id,
      walletId: wallet.id,
      spendSource: chosen.source,
      entitlementTier: chosen.entitlementTier,
      balanceSnapshot: { netSpendableCents: spendable - estCost },
    };
  });
}

/**
 * hasSpendableBalance — the READ-ONLY twin of {@link canConsumeAI}: "could this
 * user spend right now?", asked without reserving anything.
 *
 * Exists for the published-app routing edge's BALANCE-CHECK-BEFORE-WAKE, and the
 * difference from `canConsumeAI` is the whole reason it exists: `canConsumeAI`
 * INSERTS A HOLD. That is right for an AI call — one gate check, one bounded
 * unit of work, one settle — and catastrophic on a serving edge, where the gate
 * runs once per HTTP request (the metered tier has no replay cache, by design)
 * and would write a `credit_holds` row per image, per stylesheet, per favicon,
 * each of them reserving spend against a run that has no settle to release it.
 *
 * The decision RULE is the one `evaluateGate` applies — spendable above the
 * reserve floor, debt netted, billing-disabled deployments unlimited — reached
 * through `readSpendableCents`, which shares its arithmetic with the display read
 * (including the pending one-time starter grant on a bare free row, which the gate
 * applies lazily on the next call — so a free user who topped up before their first
 * AI request is not read as broke for the gap before that call).
 *
 * It reads the funded-balance columns and NOTHING else: ONE indexed row, no
 * aggregate. Going through `getCreditBalance` here would also run its `SUM` over
 * active `credit_holds` — a figure this gate then discards — on a path that runs
 * once per image and per stylesheet.
 *
 * The INPUT differs by one term, and deliberately: `evaluateGate` nets out
 * `reserved` and this call's `estCost`, and this does not subtract in-flight AI
 * holds at all. So the two can disagree for a user mid-stream, which is the
 * intended behaviour rather than drift — those holds are reservations against
 * chat calls, and a user with a stream running must not have their published
 * site go dark for the duration. The awake-seconds meter
 * settles separately, and overspend on this path is bounded by the metering
 * cron parking the app — not by this read.
 *
 * Never lazy-inits and never rolls the period: this is a hot read-only path, and
 * both of those writes belong to `canConsumeAI`, which owns the row lock.
 */
export async function hasSpendableBalance(
  userId: string,
  tier: SubscriptionTier = 'free',
): Promise<boolean> {
  if (!isBillingEnabled()) return true;
  const spendable = await readSpendableCents(userId, tier);
  return spendable > RESERVE_FLOOR_CENTS;
}
