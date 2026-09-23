/**
 * drive-wallet-service — the imperative shell behind the wallet routes (Spec SPEND-2,
 * SPEND-3, SPEND-9, SPEND-10, UI-9, UI-10, WAL-3, WAL-4, WAL-7; X-1 through the CLI and MCP,
 * which call the same routes).
 *
 * Every entry point decides access the same way: the person's standing in the drive is loaded
 * through the permissions module (`loadDriveWalletStanding`: the one org-aware membership
 * model, audited org power, the ACCEPTED org role) and judged by `wallet-access`; what a viewer
 * sees is picked by `wallet-views`' per-role allowlist; money moves are planned by
 * `wallet-admin` and written here under row locks. A person with no access to the drive gets
 * 404 (whether a drive or its wallet exists is itself drive data); a person with access but
 * not the action gets 403.
 *
 * Dark while ORGS_ENABLED is false: drive wallets are not resolved by the gate then, so the
 * surfaces that configure them answer 404. The personal default and the conversation source
 * work regardless (they are personal), and answer own credits while dark.
 */

import { db } from '@pagespace/db/db';
import { and, eq, gt, gte, inArray, isNull, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { conversations } from '@pagespace/db/schema/conversations';
import { pages } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { orgMembers } from '@pagespace/db/schema/organizations';
import {
  wallets,
  walletConsumerCaps,
  walletFundingLegs,
  personalRootWalletOf,
  type SpendSourceKindValue,
} from '@pagespace/db/schema/wallets';
import { isBillingEnabled } from '../deployment-mode';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';
import { getDriveIdsForUser } from '../permissions/permissions';
import { loadDriveWalletStanding, type DriveWalletStanding } from '../permissions/spend-standing';
import {
  mayTakeWalletAction,
  walletActionsFor,
  walletViewerRole,
  type WalletAction,
  type WalletViewer,
} from '../permissions/wallet-access';
import { ensurePersonalRootWalletId } from '../billing/personal-wallet';
import { listSpendChoices, resolveCallSpend, type SpendChoice } from '../billing/spend-resolution';
import { conversationSpend, type CallSpendDecision } from '../billing/spend-target';
import { toSubscriptionTier } from '../billing/subscription-tiers';
import { planDeleteWallet, planTopUp, planWalletPatch, type DeleteBlocker, type WalletPatchInput } from '../billing/wallet-admin';
import { donateToDriveWallet } from '../billing/wallet-funding-shell';
import { utcDayStartMs, utcMonthStartMs, type SpendSourceKind } from '../billing/wallet-core';
import {
  capRemainingCents,
  projectDriveWallet,
  walletRemainingCents,
  type ConsumerSpend,
  type DriveWalletFacts,
  type DriveWalletView,
  type PoolFacts,
} from '../billing/wallet-views';

export interface WalletServiceError {
  ok: false;
  status: 400 | 402 | 403 | 404 | 409;
  code: string;
  message: string;
  blockers?: DeleteBlocker[];
}

const notFound = (message = 'Drive not found'): WalletServiceError => ({ ok: false, status: 404, code: 'not_found', message });
const forbidden = (action: WalletAction): WalletServiceError => ({
  ok: false,
  status: 403,
  code: 'insufficient_role',
  message: `You cannot ${action.replace(/_/g, ' ')} this drive's wallet`,
});

/** The consumer key a person's cap is stored under on a wallet (WAL-7). */
export const userConsumerKey = (userId: string): string => `user:${userId}`;

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

interface WalletAccess {
  ok: true;
  standing: DriveWalletStanding;
  viewer: Exclude<WalletViewer, 'none'>;
  orgDrive: boolean;
  actions: WalletAction[];
}

async function walletAccess(userId: string, driveId: string): Promise<WalletAccess | WalletServiceError> {
  if (!ORGS_ENABLED) return notFound();
  const standing = await loadDriveWalletStanding(userId, driveId);
  if (!standing) return notFound();
  const viewer = walletViewerRole(standing);
  if (viewer === 'none') return notFound();
  const orgDrive = standing.orgId !== null;
  return { ok: true, standing, viewer, orgDrive, actions: walletActionsFor(viewer, { orgDrive }) };
}

function requireAction(access: WalletAccess, action: WalletAction): WalletServiceError | null {
  return mayTakeWalletAction(access.viewer, action, { orgDrive: access.orgDrive }) ? null : forbidden(action);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const WALLET_ROW = {
  id: wallets.id,
  subjectId: wallets.subjectId,
  parentWalletId: wallets.parentWalletId,
  status: wallets.status,
  monthlyAllowanceCents: wallets.monthlyAllowanceCents,
  spentCents: wallets.spentCents,
  topupRemainingCents: wallets.topupRemainingCents,
  debtCents: wallets.debtCents,
  monthlyPeriodStart: wallets.monthlyPeriodStart,
  monthlyPeriodEnd: wallets.monthlyPeriodEnd,
  fallbackRule: wallets.fallbackRule,
  donationsEnabled: wallets.donationsEnabled,
  defaultSpendSource: wallets.defaultSpendSource,
} as const;

async function driveWalletRow(executor: Pick<typeof db, 'select'>, driveId: string) {
  const [row] = await executor
    .select(WALLET_ROW)
    .from(wallets)
    .where(and(eq(wallets.subjectType, 'drive'), eq(wallets.subjectId, driveId)))
    .limit(1);
  return row ?? null;
}

async function orgPoolRow(executor: Pick<typeof db, 'select'>, orgId: string) {
  const [row] = await executor
    .select({
      id: wallets.id,
      monthlyRemainingCents: wallets.monthlyRemainingCents,
      topupRemainingCents: wallets.topupRemainingCents,
      debtCents: wallets.debtCents,
      monthlyPeriodStart: wallets.monthlyPeriodStart,
      monthlyPeriodEnd: wallets.monthlyPeriodEnd,
    })
    .from(wallets)
    .where(and(eq(wallets.ownerType, 'org'), eq(wallets.orgId, orgId), isNull(wallets.subjectType), isNull(wallets.parentWalletId)))
    .limit(1);
  return row ?? null;
}

async function liveHeldCents(walletIds: string[], includeChildrenOf: string[] = []): Promise<number> {
  if (walletIds.length === 0 && includeChildrenOf.length === 0) return 0;
  const now = new Date();
  const [row] = await db
    .select({ cents: sql<number>`coalesce(sum(${creditHolds.estCents}), 0)::int` })
    .from(creditHolds)
    .innerJoin(wallets, eq(wallets.id, creditHolds.walletId))
    .where(and(
      gt(creditHolds.expiresAt, now),
      includeChildrenOf.length > 0
        ? sql`(${inArray(wallets.id, [...walletIds, ...includeChildrenOf])} OR ${inArray(wallets.parentWalletId, includeChildrenOf)})`
        : inArray(wallets.id, walletIds),
    ));
  return Number(row?.cents ?? 0);
}

/** A person's usage on one wallet since `since` (usage rows carry the negative applied cents). */
async function usageCentsSince(walletId: string, userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ cents: sql<number>`coalesce(-sum(${creditLedger.appliedCents}), 0)::int` })
    .from(creditLedger)
    .where(and(
      eq(creditLedger.walletId, walletId),
      eq(creditLedger.userId, userId),
      eq(creditLedger.entryType, 'usage'),
      gte(creditLedger.createdAt, since),
    ));
  return Math.max(0, Number(row?.cents ?? 0));
}

async function myCapFacts(walletId: string, userId: string): Promise<DriveWalletFacts['myCap']> {
  const [cap] = await db
    .select({ dailyCapCents: walletConsumerCaps.dailyCapCents, monthlyCapCents: walletConsumerCaps.monthlyCapCents })
    .from(walletConsumerCaps)
    .where(and(eq(walletConsumerCaps.walletId, walletId), eq(walletConsumerCaps.consumerKey, userConsumerKey(userId))))
    .limit(1);
  if (!cap) return null;
  const nowMs = Date.now();
  return {
    dailyCapCents: cap.dailyCapCents,
    monthlyCapCents: cap.monthlyCapCents,
    spentTodayCents: await usageCentsSince(walletId, userId, new Date(utcDayStartMs(nowMs))),
    spentThisMonthCents: await usageCentsSince(walletId, userId, new Date(utcMonthStartMs(nowMs))),
  };
}

/** Spend on the wallet this period, per consumer (SPEND-10). Loaded only for a viewer who may see it. */
async function spendByConsumer(walletId: string, since: Date | null): Promise<ConsumerSpend[]> {
  const rows = await db
    .select({ userId: creditLedger.userId, cents: sql<number>`coalesce(-sum(${creditLedger.appliedCents}), 0)::int` })
    .from(creditLedger)
    .where(and(
      eq(creditLedger.walletId, walletId),
      eq(creditLedger.entryType, 'usage'),
      since ? gte(creditLedger.createdAt, since) : undefined,
    ))
    .groupBy(creditLedger.userId)
    .limit(500);
  return rows
    .map((r) => ({ consumerKey: userConsumerKey(r.userId), userId: r.userId, spentCents: Math.max(0, Number(r.cents)) }))
    .sort((a, b) => b.spentCents - a.spentCents || a.consumerKey.localeCompare(b.consumerKey));
}

async function poolFacts(orgId: string): Promise<PoolFacts | null> {
  const pool = await orgPoolRow(db, orgId);
  if (!pool) return null;
  const [children] = await db
    .select({ outstanding: sql<number>`coalesce(sum(greatest(${wallets.monthlyAllowanceCents} - ${wallets.spentCents}, 0)), 0)::int` })
    .from(wallets)
    .where(eq(wallets.parentWalletId, pool.id));
  const held = await liveHeldCents([], [pool.id]);
  return {
    walletId: pool.id,
    availableCents: pool.monthlyRemainingCents + pool.topupRemainingCents - pool.debtCents - held,
    outstandingChildAllocationsCents: Number(children?.outstanding ?? 0),
  };
}

export interface DriveWalletRead {
  ok: true;
  viewer: Exclude<WalletViewer, 'none'>;
  actions: WalletAction[];
  /** Null when the drive has no wallet yet. */
  wallet: DriveWalletView | null;
}

async function readView(userId: string, access: WalletAccess): Promise<DriveWalletRead> {
  const row = await driveWalletRow(db, access.standing.driveId);
  if (!row) return { ok: true, viewer: access.viewer, actions: access.actions, wallet: null };
  // Only what this viewer may see is even loaded: spend by consumer for the lead and org
  // admins, the pool for org admins.
  const seesSpend = mayTakeWalletAction(access.viewer, 'view_spend_by_member', { orgDrive: access.orgDrive });
  const facts: DriveWalletFacts = {
    wallet: {
      id: row.id,
      driveId: access.standing.driveId,
      status: row.status,
      monthlyAllowanceCents: row.monthlyAllowanceCents,
      spentCents: row.spentCents,
      topupRemainingCents: row.topupRemainingCents,
      debtCents: row.debtCents,
      monthlyPeriodStart: row.monthlyPeriodStart,
      monthlyPeriodEnd: row.monthlyPeriodEnd,
      fallbackRule: row.fallbackRule,
      donationsEnabled: row.donationsEnabled,
      defaultSpendSource: row.defaultSpendSource,
    },
    myCap: await myCapFacts(row.id, userId),
    spendByConsumer: seesSpend ? await spendByConsumer(row.id, row.monthlyPeriodStart) : [],
    pool: access.viewer === 'org_admin' && access.standing.orgId ? await poolFacts(access.standing.orgId) : null,
  };
  return { ok: true, viewer: access.viewer, actions: access.actions, wallet: projectDriveWallet(access.viewer, facts) };
}

/** GET a drive's wallet as this person may see it (SPEND-9, SPEND-10, UI-9). */
export async function getDriveWallet(userId: string, driveId: string): Promise<DriveWalletRead | WalletServiceError> {
  const access = await walletAccess(userId, driveId);
  if (!access.ok) return access;
  return readView(userId, access);
}

// ---------------------------------------------------------------------------
// Create, change, delete (UI-9)
// ---------------------------------------------------------------------------

/**
 * Create the drive's wallet under its parent (WAL-2): the org pool for an org drive, the
 * lead's personal wallet for a personal drive. Its allocation period follows the parent's
 * (D-OW-12); the reset sweep keeps it there.
 */
export async function createDriveWallet(
  userId: string,
  driveId: string,
  input: { allocationCents: number },
): Promise<DriveWalletRead | WalletServiceError> {
  const access = await walletAccess(userId, driveId);
  if (!access.ok) return access;
  const denied = requireAction(access, 'create');
  if (denied) return denied;
  const plan = planWalletPatch({ allocationCents: input.allocationCents }, { status: 'active', debtCents: 0 });
  if (plan.kind === 'refuse') return { ok: false, status: 400, code: plan.reason, message: 'The allocation must be a whole, non-negative number of cents' };

  const { standing } = access;
  const created = await db.transaction(async (tx) => {
    let parent: { id: string; monthlyPeriodStart: Date | null; monthlyPeriodEnd: Date | null } | null;
    if (standing.orgId !== null) {
      parent = await orgPoolRow(tx, standing.orgId);
    } else {
      const parentId = await ensurePersonalRootWalletId(tx, standing.ownerId);
      const [row] = await tx
        .select({ id: wallets.id, monthlyPeriodStart: wallets.monthlyPeriodStart, monthlyPeriodEnd: wallets.monthlyPeriodEnd })
        .from(wallets)
        .where(eq(wallets.id, parentId));
      parent = row ?? null;
    }
    if (!parent) return 'no_parent' as const;
    const inserted = await tx
      .insert(wallets)
      .values({
        ownerType: standing.orgId !== null ? 'org' : 'user',
        orgId: standing.orgId,
        userId: standing.orgId !== null ? null : standing.ownerId,
        subjectType: 'drive',
        subjectId: standing.driveId,
        parentWalletId: parent.id,
        monthlyAllowanceCents: input.allocationCents,
        monthlyPeriodStart: parent.monthlyPeriodStart,
        monthlyPeriodEnd: parent.monthlyPeriodEnd,
      })
      .onConflictDoNothing({ target: [wallets.subjectType, wallets.subjectId], where: sql`"subjectId" IS NOT NULL` })
      .returning({ id: wallets.id });
    return inserted.length > 0 ? ('created' as const) : ('exists' as const);
  });
  if (created === 'no_parent') {
    return { ok: false, status: 409, code: 'no_org_pool', message: 'This organization has no pool to allocate from yet' };
  }
  if (created === 'exists') return { ok: false, status: 409, code: 'wallet_exists', message: 'This drive already has a wallet' };
  return readView(userId, access);
}

/** Change a drive wallet's allocation, pause state, rules or default source; each field is its own action. */
export async function updateDriveWallet(
  userId: string,
  driveId: string,
  input: WalletPatchInput,
): Promise<DriveWalletRead | WalletServiceError> {
  const access = await walletAccess(userId, driveId);
  if (!access.ok) return access;

  const outcome = await db.transaction(async (tx): Promise<WalletServiceError | null> => {
    const [row] = await tx
      .select({ id: wallets.id, status: wallets.status, debtCents: wallets.debtCents })
      .from(wallets)
      .where(and(eq(wallets.subjectType, 'drive'), eq(wallets.subjectId, driveId)))
      .for('update');
    if (!row) return { ok: false, status: 404, code: 'no_wallet', message: 'This drive has no wallet' };
    const plan = planWalletPatch(input, row);
    if (plan.kind === 'refuse') {
      return { ok: false, status: 400, code: plan.reason, message: plan.reason === 'invalid_amount' ? 'The allocation must be a whole, non-negative number of cents' : 'Nothing to change' };
    }
    for (const action of plan.actions) {
      const denied = requireAction(access, action);
      if (denied) return denied;
    }
    await tx.update(wallets).set(plan.set).where(eq(wallets.id, row.id));
    return null;
  });
  if (outcome) return outcome;
  return readView(userId, access);
}

/** Delete a drive wallet that never moved money; anything else is paused instead (wallet-admin). */
export async function deleteDriveWallet(userId: string, driveId: string): Promise<{ ok: true } | WalletServiceError> {
  const access = await walletAccess(userId, driveId);
  if (!access.ok) return access;
  const denied = requireAction(access, 'delete');
  if (denied) return denied;

  return db.transaction(async (tx): Promise<{ ok: true } | WalletServiceError> => {
    const [row] = await tx
      .select({ id: wallets.id, topupRemainingCents: wallets.topupRemainingCents, debtCents: wallets.debtCents })
      .from(wallets)
      .where(and(eq(wallets.subjectType, 'drive'), eq(wallets.subjectId, driveId)))
      .for('update');
    if (!row) return { ok: false, status: 404, code: 'no_wallet', message: 'This drive has no wallet' };
    const [holds] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(creditHolds)
      .where(and(eq(creditHolds.walletId, row.id), gt(creditHolds.expiresAt, new Date())));
    const [ledger] = await tx.select({ n: sql<number>`count(*)::int` }).from(creditLedger).where(eq(creditLedger.walletId, row.id));
    const [legs] = await tx
      .select({ cents: sql<number>`coalesce(sum(${walletFundingLegs.remainingCents}), 0)::int` })
      .from(walletFundingLegs)
      .where(eq(walletFundingLegs.walletId, row.id));
    const plan = planDeleteWallet({
      liveHoldCount: Number(holds?.n ?? 0),
      ledgerEntryCount: Number(ledger?.n ?? 0),
      legsRemainingCents: Math.max(Number(legs?.cents ?? 0), row.topupRemainingCents),
      debtCents: row.debtCents,
    });
    if (plan.kind === 'refuse') {
      return { ok: false, status: 409, code: plan.reason, message: 'This wallet has moved money; pause it instead of deleting it', blockers: plan.blockers };
    }
    await tx.delete(wallets).where(eq(wallets.id, row.id));
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Money in: top-up (WAL-3) and donation (WAL-4)
// ---------------------------------------------------------------------------

/**
 * Top up a drive wallet from its funder: the org pool for an org drive (org admins only), the
 * lead's own personal wallet for a personal drive. One owner funding leg per `idempotencyKey`.
 */
export async function topUpDriveWallet(
  userId: string,
  driveId: string,
  input: { amountCents: number; idempotencyKey: string },
): Promise<{ ok: true; legId: string; amountCents: number; paidDebtCents: number; duplicate: boolean } | WalletServiceError> {
  const access = await walletAccess(userId, driveId);
  if (!access.ok) return access;
  const denied = requireAction(access, 'top_up');
  if (denied) return denied;
  if (!isBillingEnabled()) return { ok: false, status: 409, code: 'billing_disabled', message: 'Billing is not enabled on this deployment' };

  const { standing } = access;
  const sourceRef = `topup:${input.idempotencyKey}`;
  const target = await driveWalletRow(db, driveId);
  if (!target) return { ok: false, status: 404, code: 'no_wallet', message: 'This drive has no wallet' };
  const payerId = standing.orgId !== null
    ? (await orgPoolRow(db, standing.orgId))?.id ?? null
    : await ensurePersonalRootWalletId(db, standing.ownerId);
  if (!payerId) return { ok: false, status: 409, code: 'no_org_pool', message: 'This organization has no pool to pay from' };
  // Holds that reserve against the payer: its own, and (for a pool) its children's.
  const held = await liveHeldCents([payerId], standing.orgId !== null ? [payerId] : []);

  return db.transaction(async (tx) => {
    const [prior] = await tx.select({ id: walletFundingLegs.id }).from(walletFundingLegs).where(eq(walletFundingLegs.sourceRef, sourceRef)).limit(1);
    if (prior) return { ok: true as const, legId: prior.id, amountCents: input.amountCents, paidDebtCents: 0, duplicate: true };

    const locked = new Map<string, typeof wallets.$inferSelect>();
    for (const id of [payerId, target.id].sort()) {
      const [row] = await tx.select().from(wallets).where(eq(wallets.id, id)).for('update');
      if (row) locked.set(id, row);
    }
    const payer = locked.get(payerId);
    const drive = locked.get(target.id);
    if (!payer || !drive) return { ok: false as const, status: 404 as const, code: 'no_wallet', message: 'The wallet was removed' };

    const plan = planTopUp({
      amountCents: input.amountCents,
      payer: { walletId: payer.id, balance: { monthlyCents: payer.monthlyRemainingCents, topupCents: payer.topupRemainingCents, debtCents: payer.debtCents }, heldCents: held },
      target: { walletId: drive.id, legsRemainingCents: drive.topupRemainingCents, debtCents: drive.debtCents },
    });
    if (plan.kind === 'refuse') {
      return plan.reason === 'insufficient_funds'
        ? { ok: false as const, status: 402 as const, code: plan.reason, message: 'The funding wallet cannot cover this top-up' }
        : { ok: false as const, status: 400 as const, code: plan.reason, message: 'The amount must be a positive whole number of cents' };
    }
    const [leg] = await tx
      .insert(walletFundingLegs)
      .values({
        walletId: drive.id,
        funderKind: 'owner',
        funderUserId: standing.orgId === null ? standing.ownerId : null,
        funderOrgId: standing.orgId,
        originalCents: plan.leg.originalCents,
        remainingCents: plan.leg.remainingCents,
        nonRefundable: plan.leg.nonRefundable,
        sourceRef,
      })
      .returning({ id: walletFundingLegs.id });
    await tx
      .update(wallets)
      .set({ monthlyRemainingCents: plan.payer.monthlyRemainingCents, topupRemainingCents: plan.payer.topupRemainingCents })
      .where(eq(wallets.id, payer.id));
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
        userId,
        walletId: payer.id,
        entryType: 'wallet_topup',
        bucket: plan.payer.spentTopup > plan.payer.spentMonthly ? 'topup' : 'monthly',
        amountCents: -plan.amountCents,
        appliedCents: -plan.amountCents,
        stripeRef: `topup-out:${input.idempotencyKey}`,
        consumeStatus: 'applied',
      },
      {
        userId,
        walletId: drive.id,
        entryType: 'wallet_topup',
        bucket: 'topup',
        amountCents: plan.amountCents,
        appliedCents: plan.amountCents,
        stripeRef: `topup-in:${input.idempotencyKey}`,
        consumeStatus: 'applied',
      },
    ]);
    return { ok: true as const, legId: leg.id, amountCents: plan.amountCents, paidDebtCents: plan.target.paidDebtCents, duplicate: false };
  });
}

/** Donate from the caller's own balance to the drive's wallet (WAL-4); the donation shell re-checks visibility. */
export async function donateToDrive(
  userId: string,
  driveId: string,
  input: { amountCents: number; idempotencyKey: string },
): Promise<{ ok: true; legId: string | null; amountCents: number; paidDebtCents: number; duplicate: boolean } | WalletServiceError> {
  const access = await walletAccess(userId, driveId);
  if (!access.ok) return access;
  const denied = requireAction(access, 'donate');
  if (denied) return denied;
  const target = await driveWalletRow(db, driveId);
  if (!target) return { ok: false, status: 404, code: 'no_wallet', message: 'This drive has no wallet' };

  const outcome = await donateToDriveWallet({ donorUserId: userId, targetWalletId: target.id, amountCents: input.amountCents, donationId: input.idempotencyKey });
  if (outcome.kind === 'donated') return { ok: true, legId: outcome.legId, amountCents: outcome.amountCents, paidDebtCents: outcome.paidDebtCents, duplicate: false };
  if (outcome.kind === 'duplicate') return { ok: true, legId: outcome.legId, amountCents: input.amountCents, paidDebtCents: 0, duplicate: true };
  switch (outcome.reason) {
    case 'insufficient_funds':
      return { ok: false, status: 402, code: outcome.reason, message: 'Your balance cannot cover this donation' };
    case 'donations_disabled':
      return { ok: false, status: 409, code: outcome.reason, message: 'This drive does not accept donations' };
    case 'billing_disabled':
      return { ok: false, status: 409, code: outcome.reason, message: 'Billing is not enabled on this deployment' };
    case 'cannot_see_drive':
    case 'wallet_not_found':
      return notFound();
    default:
      return { ok: false, status: 400, code: outcome.reason, message: 'This donation cannot be made' };
  }
}

// ---------------------------------------------------------------------------
// Settings › Usage › Wallets (UI-10): what I spend from, what I fund, my default
// ---------------------------------------------------------------------------

export interface MyWallets {
  personal: { walletId: string; remainingCents: number; defaultSpendSource: SpendSourceKind | null };
  /** Drive wallets of drives I can open: the consumer amount only (SPEND-9). */
  driveWallets: { driveId: string; walletId: string; status: string; remainingCents: number }[];
  /** A seat on each org I belong to: my own cap only, never the pool (SPEND-9). */
  seats: { orgId: string; walletId: string }[];
  /** What I fund: drive wallets my personal wallet parents, pools I administer (SPEND-10), my donations. */
  funds: {
    driveWallets: { driveId: string; walletId: string }[];
    pools: { orgId: string; walletId: string; availableCents: number; unallocatedCents: number }[];
    donations: { walletId: string; driveId: string | null; originalCents: number; remainingCents: number; createdAt: string }[];
  };
}

export async function listMyWallets(userId: string): Promise<MyWallets> {
  const personalId = await ensurePersonalRootWalletId(db, userId);
  const [personal] = await db
    .select({ monthlyRemainingCents: wallets.monthlyRemainingCents, topupRemainingCents: wallets.topupRemainingCents, debtCents: wallets.debtCents, defaultSpendSource: wallets.defaultSpendSource })
    .from(wallets)
    .where(eq(wallets.id, personalId));
  const result: MyWallets = {
    personal: {
      walletId: personalId,
      remainingCents: Math.max(0, (personal?.monthlyRemainingCents ?? 0) + (personal?.topupRemainingCents ?? 0) - (personal?.debtCents ?? 0)),
      defaultSpendSource: personal?.defaultSpendSource ?? null,
    },
    driveWallets: [],
    seats: [],
    funds: { driveWallets: [], pools: [], donations: [] },
  };

  const donations = await db
    .select({ walletId: walletFundingLegs.walletId, subjectId: wallets.subjectId, originalCents: walletFundingLegs.originalCents, remainingCents: walletFundingLegs.remainingCents, createdAt: walletFundingLegs.createdAt })
    .from(walletFundingLegs)
    .innerJoin(wallets, eq(wallets.id, walletFundingLegs.walletId))
    .where(and(eq(walletFundingLegs.funderUserId, userId), eq(walletFundingLegs.funderKind, 'donation')))
    .limit(500);
  result.funds.donations = donations.map((d) => ({ walletId: d.walletId, driveId: d.subjectId, originalCents: d.originalCents, remainingCents: d.remainingCents, createdAt: d.createdAt.toISOString() }));

  if (!ORGS_ENABLED) return result;

  // The drives this person can open, through the one access model; nothing else is listed.
  const driveIds = await getDriveIdsForUser(userId);
  if (driveIds.length > 0) {
    const rows = await db
      .select({ id: wallets.id, subjectId: wallets.subjectId, parentWalletId: wallets.parentWalletId, status: wallets.status, monthlyAllowanceCents: wallets.monthlyAllowanceCents, spentCents: wallets.spentCents, topupRemainingCents: wallets.topupRemainingCents, debtCents: wallets.debtCents })
      .from(wallets)
      .where(and(eq(wallets.subjectType, 'drive'), inArray(wallets.subjectId, driveIds)))
      .limit(1000);
    for (const row of rows) {
      if (!row.subjectId) continue;
      result.driveWallets.push({ driveId: row.subjectId, walletId: row.id, status: row.status, remainingCents: walletRemainingCents(row) });
      if (row.parentWalletId === personalId) result.funds.driveWallets.push({ driveId: row.subjectId, walletId: row.id });
    }
  }

  const memberships = await db
    .select({ orgId: orgMembers.orgId, role: orgMembers.role })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    .limit(200);
  for (const m of memberships) {
    const pool = await orgPoolRow(db, m.orgId);
    if (!pool) continue;
    result.seats.push({ orgId: m.orgId, walletId: pool.id });
    if (m.role === 'OWNER' || m.role === 'ADMIN') {
      const facts = await poolFacts(m.orgId);
      if (facts) {
        result.funds.pools.push({
          orgId: m.orgId,
          walletId: facts.walletId,
          availableCents: facts.availableCents,
          unallocatedCents: facts.availableCents - facts.outstandingChildAllocationsCents,
        });
      }
    }
  }
  return result;
}

/** Set (or clear, with null) the person's own default source (SPEND-3, UI-10). */
export async function setPersonalDefaultSource(userId: string, source: SpendSourceKindValue | null): Promise<{ ok: true; defaultSpendSource: SpendSourceKind | null }> {
  const walletId = await ensurePersonalRootWalletId(db, userId);
  await db.update(wallets).set({ defaultSpendSource: source }).where(and(eq(wallets.id, walletId), personalRootWalletOf(userId)));
  return { ok: true, defaultSpendSource: source };
}

// ---------------------------------------------------------------------------
// Per-conversation source (SPEND-2, SPEND-3)
// ---------------------------------------------------------------------------

export interface ConversationSpendRead {
  ok: true;
  conversationId: string;
  driveId: string | null;
  chosenWalletId: string | null;
  /** What this person may pick here, by wallet. */
  options: SpendChoice[];
  /** What the next call would spend, as the gate would decide it now (the chip and strip). */
  resolved: CallSpendDecision;
}

/**
 * The caller's own conversation and the drive of its session (SPEND-7), resolved on the
 * server: a drive conversation's drive, a page conversation's page's drive. A global
 * conversation has no drive of its own — the assistant spends in whatever drive the person is
 * in — so `globalDriveId` (the drive the person is choosing for) is used for it, and only as
 * the context the options are listed in: the options are opened by the permissions module, so
 * a drive the person cannot open offers nothing but their own credits, and the gate re-resolves
 * the stored wallet against the real session drive on every call.
 */
async function ownConversation(userId: string, conversationId: string, globalDriveId: string | null) {
  const [row] = await db
    .select({ id: conversations.id, chosenWalletId: conversations.chosenWalletId, type: conversations.type, contextId: conversations.contextId })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);
  if (!row) return null;
  let sessionDriveId: string | null = null;
  if (row.type === 'drive') sessionDriveId = row.contextId;
  else if (row.type === 'page' && row.contextId) {
    const [page] = await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, row.contextId)).limit(1);
    sessionDriveId = page?.driveId ?? null;
  } else if (row.type === 'global') sessionDriveId = globalDriveId;
  return { id: row.id, chosenWalletId: row.chosenWalletId, sessionDriveId };
}

/**
 * The conversation's source as the person will see it before sending (SPEND-2): the stored
 * choice, the options, and the gate's own decision for a zero-cost preview (nothing reserved,
 * no refusal logged). `globalDriveId` is read only for a global conversation (see
 * ownConversation).
 */
export async function getConversationSpend(userId: string, conversationId: string, globalDriveId: string | null = null): Promise<ConversationSpendRead | WalletServiceError> {
  const conversation = await ownConversation(userId, conversationId, globalDriveId);
  if (!conversation) return notFound('Conversation not found');
  const { sessionDriveId } = conversation;
  const [user] = await db.select({ tier: users.subscriptionTier }).from(users).where(eq(users.id, userId)).limit(1);
  const options = await listSpendChoices(userId, sessionDriveId);
  const resolved = await resolveCallSpend({
    userId,
    consumerTier: toSubscriptionTier(user?.tier),
    target: conversationSpend(sessionDriveId, conversationId),
    reservationCents: 0,
    recordRefusal: false,
  });
  return { ok: true, conversationId, driveId: sessionDriveId, chosenWalletId: conversation.chosenWalletId, options, resolved };
}

/**
 * Choose (or clear, with null) the wallet a conversation spends from (SPEND-3). The ONLY
 * writer of conversations.chosenWalletId: a turn never changes it. The wallet must be one of
 * this person's options in the conversation's drive now; the gate re-resolves it on every call
 * anyway, and refuses it if it stops being one.
 */
export async function setConversationSpend(
  userId: string,
  conversationId: string,
  walletId: string | null,
  globalDriveId: string | null = null,
): Promise<ConversationSpendRead | WalletServiceError> {
  const conversation = await ownConversation(userId, conversationId, globalDriveId);
  if (!conversation) return notFound('Conversation not found');
  if (walletId !== null) {
    const options = await listSpendChoices(userId, conversation.sessionDriveId);
    if (!options.some((o) => o.walletId === walletId)) {
      return { ok: false, status: 400, code: 'wallet_not_available', message: 'That wallet is not one you can spend from in this conversation' };
    }
  }
  await db
    .update(conversations)
    .set({ chosenWalletId: walletId })
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
  return getConversationSpend(userId, conversationId, globalDriveId);
}
