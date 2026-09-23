/**
 * wallet-funding-shell — the I/O around wallet-funding's pure decisions (Spec MON-3,
 * WAL-3, WAL-4; D-OW-12, D-OW-13, [D-OW-23] pending).
 *
 *   - applyOrgPoolRefill: an org invoice paid refills the org pool (MON-3), exactly
 *     once per invoice (the ledger's stripeRef unique index), rolling the pool's period
 *     forward to the invoice's service period — the date org allocations reset on.
 *   - resetDueAllocations: the period-reset sweep over CHILD wallets. Each resets on its
 *     governing root's period (pool refill for org, personal renewal for personal,
 *     D-OW-12). Root wallets are not touched here: invoice.paid refills them, and the
 *     gate's lazy roll for comped personal accounts (credit-gate.ts) is deliberately
 *     left where it is until C3 lands.
 *   - donateToDriveWallet: moves a one-off amount from the donor's personal root wallet
 *     into a drive wallet as its own non-refundable funding leg, with a ledger pair.
 *   - refundFundingLeg (and wallet-legs drawWalletFundingLegs, the settle's draw): the only
 *     writers of a leg's remaining.
 *
 * Every money write runs inside one transaction with its rows locked FOR UPDATE, so a
 * concurrent writer is serialised, never overwritten. Idempotency keys:
 *   - pool refill: credit_ledger.stripeRef = the invoice id;
 *   - donation:    wallet_funding_legs.sourceRef = `donation:<donationId>`, and the
 *                  ledger pair `donation-out:<id>` / `donation-in:<id>`;
 *   - reset:       the wallet's own monthlyPeriodStart (the update only lands while the
 *                  stored period is older than the governing one).
 */

import { db } from '@pagespace/db/db';
import { creditLedger, creditHolds } from '@pagespace/db/schema/credits';
import { wallets, walletFundingLegs, personalRootWalletOf } from '@pagespace/db/schema/wallets';
import { organizations } from '@pagespace/db/schema/organizations';
import { and, asc, eq, gt, isNotNull, isNull, or, lt, sql } from '@pagespace/db/operators';
import { alias } from 'drizzle-orm/pg-core';
import { isBillingEnabled } from '../deployment-mode';
import { getUserDriveAccess } from '../permissions/permissions';
import { loggers } from '../logging/logger-config';
import { MONEY_MODEL_V2_ACTIVE } from './money-model';
import {
  orgPoolRefillGrant,
  refillPool,
  invoiceServicePeriodMs,
  planAllocationReset,
  planLegRefund,
  planDonation,
  type DonationRefusal,
  type LegRefundPlan,
} from './wallet-funding';


const STRIPE_REF_ARBITER = {
  target: creditLedger.stripeRef,
  where: sql`${creditLedger.stripeRef} IS NOT NULL`,
} as const;

const ORG_POOL_ARBITER = {
  target: wallets.orgId,
  where: sql`"ownerType" = 'org' AND "subjectType" IS NULL AND "parentWalletId" IS NULL`,
} as const;

const SOURCE_REF_ARBITER = {
  target: walletFundingLegs.sourceRef,
  where: sql`"sourceRef" IS NOT NULL`,
} as const;

/** The org pool of `orgId`: org-owned, no subject, no parent (WAL-2). */
function orgPoolOf(orgId: string) {
  return and(eq(wallets.orgId, orgId), eq(wallets.ownerType, 'org'), isNull(wallets.subjectType), isNull(wallets.parentWalletId));
}

// ---------------------------------------------------------------------------
// Org pool refill (MON-3)
// ---------------------------------------------------------------------------

/** Structural subset of a Stripe invoice the pool refill reads (a Stripe.Invoice satisfies it). */
export interface OrgInvoice {
  id?: string | null;
  customer?: string | { id?: string | null } | null;
  amount_paid?: number | null;
  subtotal?: number | null;
  billing_reason?: string | null;
  period_start?: number | null;
  period_end?: number | null;
  parent?: {
    subscription_details?: {
      metadata?: Record<string, string> | null;
      subscription?: string | { id?: string | null } | null;
    } | null;
  } | null;
  lines?: {
    data?: Array<{
      amount?: number | null;
      discount_amounts?: ReadonlyArray<{ amount?: number | null } | null> | null;
      period?: { start?: number | null; end?: number | null } | null;
    } | null | undefined> | null;
  } | null;
}

export type OrgPoolRefillOutcome =
  /** The customer is not an org's: the personal funding path owns this invoice. */
  | { kind: 'not_org' }
  | { kind: 'billing_disabled' }
  | { kind: 'granted'; orgId: string; walletId: string; allowanceCents: number }
  | { kind: 'duplicate'; orgId: string }
  | { kind: 'nothing'; orgId: string; reason: string };

const GIFT_SUBSCRIPTION_METADATA_TYPE = 'gift_subscription';

function customerIdOf(invoice: OrgInvoice): string | null {
  const c = invoice.customer;
  if (!c) return null;
  return typeof c === 'string' ? c : c.id ?? null;
}

function hasSubscriptionParent(invoice: OrgInvoice): boolean {
  const s = invoice.parent?.subscription_details?.subscription;
  if (typeof s === 'string') return s.length > 0;
  return typeof s?.id === 'string' && s.id.length > 0;
}

export interface OrgPoolRefillOptions {
  /** Extra seats on the subscription, for a trial or gift funded at list price ([D-OW-23]). */
  extraSeats?: number;
  /** D-OW-17 test seam only; production callers never pass it. */
  active?: boolean;
}

/**
 * invoice.paid for an ORG customer: refill that org's pool with (base + extra-seat
 * items) paid × ratio (MON-3), once per invoice, and roll the pool's period to the
 * invoice's service period — the date the org's allocations then reset on (D-OW-12).
 * The ledger row is written under the org Owner's user id (the ledger is keyed on a
 * person) and the pool's wallet id. Throws on a genuine failure so Stripe redelivers.
 */
export async function applyOrgPoolRefill(invoice: OrgInvoice, opts: OrgPoolRefillOptions = {}): Promise<OrgPoolRefillOutcome> {
  const customerId = customerIdOf(invoice);
  if (!customerId) return { kind: 'not_org' };
  const [org] = await db
    .select({ id: organizations.id, ownerId: organizations.ownerId })
    .from(organizations)
    .where(eq(organizations.stripeCustomerId, customerId))
    .limit(1);
  if (!org) return { kind: 'not_org' };
  if (!isBillingEnabled()) return { kind: 'billing_disabled' };

  const stripeRef = invoice.id ?? null;
  if (!stripeRef) return { kind: 'nothing', orgId: org.id, reason: 'no_invoice_id' };

  const lines = invoice.lines?.data ?? [];
  const grant = orgPoolRefillGrant(
    {
      lines,
      amountPaidCents: invoice.amount_paid,
      hasSubscriptionParent: hasSubscriptionParent(invoice),
      billingReason: invoice.billing_reason,
      subtotalCents: invoice.subtotal,
      gifted: invoice.parent?.subscription_details?.metadata?.type === GIFT_SUBSCRIPTION_METADATA_TYPE,
      extraSeats: opts.extraSeats,
    },
    opts.active ?? MONEY_MODEL_V2_ACTIVE,
  );
  if (grant.allowanceCents <= 0) {
    loggers.api.info('org pool refill: invoice grants nothing', { orgId: org.id, stripeRef, reason: grant.reason, paidCents: grant.paidCents });
    return { kind: 'nothing', orgId: org.id, reason: grant.reason };
  }
  const period = invoiceServicePeriodMs({ lines, periodStart: invoice.period_start, periodEnd: invoice.period_end });

  const result = await db.transaction(async (tx) => {
    await tx.insert(wallets).values({ ownerType: 'org', orgId: org.id }).onConflictDoNothing(ORG_POOL_ARBITER);
    const [pool] = await tx
      .select({
        id: wallets.id,
        monthlyRemainingCents: wallets.monthlyRemainingCents,
        debtCents: wallets.debtCents,
        monthlyPeriodStart: wallets.monthlyPeriodStart,
      })
      .from(wallets)
      .where(orgPoolOf(org.id))
      .for('update')
      .limit(1);
    if (!pool) throw new Error(`org pool for ${org.id} could not be found or created`);

    const inserted = await tx
      .insert(creditLedger)
      .values({
        userId: org.ownerId,
        walletId: pool.id,
        entryType: 'monthly_grant',
        bucket: 'monthly',
        amountCents: grant.allowanceCents,
        paidCents: grant.paidCents,
        stripeRef,
        consumeStatus: 'applied',
      })
      .onConflictDoNothing(STRIPE_REF_ARBITER)
      .returning({ id: creditLedger.id });
    if (inserted.length === 0) return { kind: 'duplicate' as const, walletId: pool.id };

    const refill = refillPool(pool, grant.allowanceCents);
    // Stripe does not order invoice.paid deliveries: an older invoice settled late
    // (dunning) still refills once, but it must never move the pool's period — the
    // date its org allocations reset on — backwards.
    const periodMovesForward =
      period.startMs !== null &&
      period.endMs !== null &&
      (pool.monthlyPeriodStart === null || pool.monthlyPeriodStart.getTime() < period.startMs);
    await tx
      .update(wallets)
      .set({
        monthlyRemainingCents: refill.monthlyRemainingCents,
        monthlyAllowanceCents: refill.monthlyAllowanceCents,
        debtCents: refill.debtCents,
        ...(periodMovesForward && period.startMs !== null && period.endMs !== null
          ? { monthlyPeriodStart: new Date(period.startMs), monthlyPeriodEnd: new Date(period.endMs) }
          : {}),
      })
      .where(eq(wallets.id, pool.id));
    return { kind: 'granted' as const, walletId: pool.id };
  });

  if (result.kind === 'duplicate') return { kind: 'duplicate', orgId: org.id };
  loggers.api.info('org pool refill applied', { orgId: org.id, stripeRef, allowanceCents: grant.allowanceCents, basis: grant.basis });
  return { kind: 'granted', orgId: org.id, walletId: result.walletId, allowanceCents: grant.allowanceCents };
}

// ---------------------------------------------------------------------------
// Period reset sweep (D-OW-12)
// ---------------------------------------------------------------------------

export interface ResetSweepResult {
  scanned: number;
  reset: number;
  failed: number;
}

const RESET_BATCH = 500;

/**
 * Reset every child wallet whose governing period has started since its own. Pages
 * through child wallets by id; each reset re-reads its wallet under FOR UPDATE and
 * re-plans, and the update is guarded on the stored period being older than the new
 * one, so a second run in the same period — or two runs at once — resets once.
 * A wallet whose parent is itself a child is skipped: its governing root is not its
 * parent, and no lane creates such a wallet yet.
 */
export async function resetDueAllocations(opts: { now: Date; batchSize?: number }): Promise<ResetSweepResult> {
  const nowMs = opts.now.getTime();
  const batch = opts.batchSize ?? RESET_BATCH;
  const parent = alias(wallets, 'parent');
  const result: ResetSweepResult = { scanned: 0, reset: 0, failed: 0 };
  let cursor = '';

  for (;;) {
    const rows = await db
      .select({
        id: wallets.id,
        periodStart: wallets.monthlyPeriodStart,
        periodEnd: wallets.monthlyPeriodEnd,
        parentOwnerType: parent.ownerType,
        parentPeriodStart: parent.monthlyPeriodStart,
        parentPeriodEnd: parent.monthlyPeriodEnd,
      })
      .from(wallets)
      .innerJoin(parent, eq(wallets.parentWalletId, parent.id))
      .where(and(isNotNull(wallets.parentWalletId), isNull(parent.parentWalletId), gt(wallets.id, cursor)))
      .orderBy(asc(wallets.id))
      .limit(batch);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      result.scanned += 1;
      const governing = {
        ownerType: row.parentOwnerType,
        periodStartMs: row.parentPeriodStart?.getTime() ?? null,
        periodEndMs: row.parentPeriodEnd?.getTime() ?? null,
      };
      const cheap = planAllocationReset({
        wallet: {
          periodStartMs: row.periodStart?.getTime() ?? null,
          periodEndMs: row.periodEnd?.getTime() ?? null,
          allocationCents: 0,
          spentCents: 0,
          debtCents: 0,
          paused: false,
        },
        governing,
        nowMs,
      });
      if (!cheap.due) continue;
      try {
        if (await resetOne(row.id, governing, nowMs)) result.reset += 1;
      } catch (error) {
        result.failed += 1;
        loggers.api.error('allocation reset failed', error instanceof Error ? error : undefined, { walletId: row.id });
      }
    }
    if (rows.length < batch) break;
  }
  return result;
}

async function resetOne(
  walletId: string,
  governing: { ownerType: 'org' | 'user'; periodStartMs: number | null; periodEndMs: number | null },
  nowMs: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        periodStart: wallets.monthlyPeriodStart,
        periodEnd: wallets.monthlyPeriodEnd,
        allocationCents: wallets.monthlyAllowanceCents,
        spentCents: wallets.spentCents,
        debtCents: wallets.debtCents,
        status: wallets.status,
      })
      .from(wallets)
      .where(eq(wallets.id, walletId))
      .for('update');
    if (!locked) return false;
    const plan = planAllocationReset({
      wallet: {
        periodStartMs: locked.periodStart?.getTime() ?? null,
        periodEndMs: locked.periodEnd?.getTime() ?? null,
        allocationCents: locked.allocationCents,
        spentCents: locked.spentCents,
        debtCents: locked.debtCents,
        paused: locked.status === 'paused',
      },
      governing,
      nowMs,
    });
    if (!plan.due) return false;
    const newStart = new Date(plan.periodStartMs);
    const updated = await tx
      .update(wallets)
      .set({
        spentCents: plan.spentCents,
        debtCents: plan.debtCents,
        status: plan.status,
        monthlyPeriodStart: newStart,
        monthlyPeriodEnd: new Date(plan.periodEndMs),
      })
      .where(and(eq(wallets.id, walletId), or(isNull(wallets.monthlyPeriodStart), lt(wallets.monthlyPeriodStart, newStart))))
      .returning({ id: wallets.id });
    return updated.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Funding legs (D-OW-13)
// ---------------------------------------------------------------------------

/**
 * Take `cents` back out of one funding leg for a refund. A donation leg ALWAYS refuses
 * (D-OW-13) and nothing is written; an owner leg gives back at most what it holds. The
 * caller issues the actual refund (e.g. to Stripe) only on `kind: 'refund'`.
 *
 * Locks the leg's wallet BEFORE the leg (the global order, see wallet-legs): a settle
 * holds the wallet and then locks its legs, so a refund taking the leg first would wait
 * on the settle while the settle waited on it.
 */
export async function refundFundingLeg(legId: string, cents: number): Promise<LegRefundPlan> {
  return db.transaction(async (tx) => {
    // A leg never moves between wallets, so the unlocked read names the wallet to lock.
    const [owner] = await tx
      .select({ walletId: walletFundingLegs.walletId })
      .from(walletFundingLegs)
      .where(eq(walletFundingLegs.id, legId));
    if (!owner) return { kind: 'refuse', legId, reason: 'invalid_amount' };
    await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.id, owner.walletId)).for('update');
    const [row] = await tx
      .select({
        id: walletFundingLegs.id,
        walletId: walletFundingLegs.walletId,
        funderKind: walletFundingLegs.funderKind,
        funderUserId: walletFundingLegs.funderUserId,
        remainingCents: walletFundingLegs.remainingCents,
        nonRefundable: walletFundingLegs.nonRefundable,
        createdAt: walletFundingLegs.createdAt,
      })
      .from(walletFundingLegs)
      .where(eq(walletFundingLegs.id, legId))
      .for('update');
    if (!row) return { kind: 'refuse', legId, reason: 'invalid_amount' };
    const plan = planLegRefund({ ...row, createdAtMs: row.createdAt.getTime() }, cents);
    if (plan.kind === 'refuse') return plan;
    await tx.update(walletFundingLegs).set({ remainingCents: plan.remainingCents }).where(eq(walletFundingLegs.id, legId));
    await tx
      .update(wallets)
      .set({ topupRemainingCents: sql`${wallets.topupRemainingCents} - ${plan.cents}` })
      .where(eq(wallets.id, row.walletId));
    return plan;
  });
}

// ---------------------------------------------------------------------------
// Donations (WAL-4)
// ---------------------------------------------------------------------------

export type DonationOutcome =
  | { kind: 'donated'; legId: string; amountCents: number; paidDebtCents: number }
  | { kind: 'duplicate'; legId: string | null }
  | { kind: 'refused'; reason: DonationRefusal | 'wallet_not_found' | 'billing_disabled' };

export interface DonateInput {
  donorUserId: string;
  targetWalletId: string;
  amountCents: number;
  /** Idempotency key minted by the caller (the route) per donate action. */
  donationId: string;
}

/**
 * WAL-4: donate a one-off amount from the donor's personal root wallet to a drive
 * wallet. The drive-visibility decision goes through the permissions module
 * (getUserDriveAccess) before anything is locked. In one transaction: the donor wallet
 * and the target wallet are locked (drive wallet first, then the donor root: the global order), the
 * plan is made from the locked rows, a non-refundable donation leg is written (its
 * sourceRef makes a replay a no-op), both balances move, and a ledger pair records the
 * donor on both sides.
 */
export async function donateToDriveWallet(input: DonateInput): Promise<DonationOutcome> {
  if (!isBillingEnabled()) return { kind: 'refused', reason: 'billing_disabled' };
  const [target] = await db
    .select({ id: wallets.id, subjectType: wallets.subjectType, subjectId: wallets.subjectId })
    .from(wallets)
    .where(eq(wallets.id, input.targetWalletId))
    .limit(1);
  if (!target) return { kind: 'refused', reason: 'wallet_not_found' };
  const donorCanSeeDrive =
    target.subjectType === 'drive' && target.subjectId !== null
      ? await getUserDriveAccess(input.donorUserId, target.subjectId)
      : false;

  const sourceRef = `donation:${input.donationId}`;
  return db.transaction(async (tx): Promise<DonationOutcome> => {
    const [donorRow] = await tx.select({ id: wallets.id }).from(wallets).where(personalRootWalletOf(input.donorUserId)).limit(1);
    if (!donorRow) return { kind: 'refused', reason: 'insufficient_funds' };

    // Lock the drive wallet, then the donor's root: the global order (child, then root —
    // see wallet-legs). The donor's root may BE the drive wallet's parent (an owner giving
    // to their own drive), which a settle locks second; an id sort could invert that.
    const lockOrder = [target.id, donorRow.id];
    const locked = new Map<string, typeof wallets.$inferSelect>();
    for (const id of lockOrder) {
      const [row] = await tx.select().from(wallets).where(eq(wallets.id, id)).for('update');
      if (row) locked.set(id, row);
    }
    const donor = locked.get(donorRow.id);
    const drive = locked.get(target.id);
    if (!donor || !drive) return { kind: 'refused', reason: 'wallet_not_found' };

    // A replay of a donation that already landed is a duplicate, whatever the balances
    // or the drive's donation switch say NOW — the check runs before any planning. The
    // leg insert's ON CONFLICT below stays as the backstop for a concurrent replay.
    const [prior] = await tx
      .select({ id: walletFundingLegs.id })
      .from(walletFundingLegs)
      .where(eq(walletFundingLegs.sourceRef, sourceRef))
      .limit(1);
    if (prior) return { kind: 'duplicate', legId: prior.id };

    const [held] = await tx
      .select({ cents: sql<number>`coalesce(sum(${creditHolds.estCents}), 0)::int` })
      .from(creditHolds)
      .where(and(eq(creditHolds.walletId, donor.id), gt(creditHolds.expiresAt, new Date())));

    const plan = planDonation({
      amountCents: input.amountCents,
      donorCanSeeDrive,
      donor: {
        walletId: donor.id,
        isPersonalRoot: donor.ownerType === 'user' && donor.subjectType === null && donor.parentWalletId === null,
        balance: { monthlyCents: donor.monthlyRemainingCents, topupCents: donor.topupRemainingCents, debtCents: donor.debtCents },
        heldCents: Number(held?.cents ?? 0),
      },
      target: {
        walletId: drive.id,
        subjectType: drive.subjectType,
        donationsEnabled: drive.donationsEnabled,
        legsRemainingCents: drive.topupRemainingCents,
        debtCents: drive.debtCents,
      },
    });
    if (plan.kind === 'refuse') return { kind: 'refused', reason: plan.reason };

    const leg = await tx
      .insert(walletFundingLegs)
      .values({
        walletId: drive.id,
        funderKind: 'donation',
        funderUserId: input.donorUserId,
        originalCents: plan.leg.originalCents,
        remainingCents: plan.leg.remainingCents,
        nonRefundable: plan.leg.nonRefundable,
        sourceRef,
      })
      .onConflictDoNothing(SOURCE_REF_ARBITER)
      .returning({ id: walletFundingLegs.id });
    if (leg.length === 0) {
      const [existing] = await tx
        .select({ id: walletFundingLegs.id })
        .from(walletFundingLegs)
        .where(eq(walletFundingLegs.sourceRef, sourceRef))
        .limit(1);
      return { kind: 'duplicate', legId: existing?.id ?? null };
    }

    await tx
      .update(wallets)
      .set({ monthlyRemainingCents: plan.donor.monthlyRemainingCents, topupRemainingCents: plan.donor.topupRemainingCents })
      .where(eq(wallets.id, donor.id));
    await tx
      .update(wallets)
      .set({
        topupRemainingCents: plan.target.topupRemainingCents,
        debtCents: plan.target.debtCents,
        ...(drive.status === 'over' && plan.target.debtCents === 0 ? { status: 'active' as const } : {}),
      })
      .where(eq(wallets.id, drive.id));

    await tx.insert(creditLedger).values([
      {
        userId: input.donorUserId,
        walletId: donor.id,
        entryType: 'donation',
        bucket: plan.donor.spentTopup > plan.donor.spentMonthly ? 'topup' : 'monthly',
        amountCents: -plan.amountCents,
        appliedCents: -plan.amountCents,
        stripeRef: `donation-out:${input.donationId}`,
        consumeStatus: 'applied',
      },
      {
        userId: input.donorUserId,
        walletId: drive.id,
        entryType: 'donation',
        bucket: 'topup',
        amountCents: plan.amountCents,
        appliedCents: plan.amountCents,
        stripeRef: `donation-in:${input.donationId}`,
        consumeStatus: 'applied',
      },
    ]);

    return { kind: 'donated', legId: leg[0].id, amountCents: plan.amountCents, paidDebtCents: plan.target.paidDebtCents };
  });
}
