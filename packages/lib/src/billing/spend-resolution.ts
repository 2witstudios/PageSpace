/**
 * spend-resolution — the imperative shell that names the ONE wallet an AI call spends
 * before it runs (Spec SPEND-1, SPEND-4, SPEND-7, SPEND-8, WAL-8).
 *
 * It reads the rows the pure decision needs (the caller's standing in the session's drive,
 * the drive wallet and its parent, the org pool behind a seat, the caller's personal root
 * wallet, the holds reserved against each, and the tier of the wallet's root owner) and
 * hands them to spend-target's `decideCallSpend`. The credit gate then reserves on the
 * answer under a row lock; this read is unlocked and only decides WHICH wallet, never
 * whether it can pay (the gate re-checks that on the locked row and never switches).
 *
 * While ORGS_ENABLED is false, and for the personal target, it reads nothing and answers
 * the personal root wallet: personal spend behaves exactly as before wallets.
 */

import { db } from '@pagespace/db/db';
import { and, eq, gt, inArray, isNull, or, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { creditHolds } from '@pagespace/db/schema/credits';
import { wallets, personalRootWalletOf } from '@pagespace/db/schema/wallets';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';
import { loadDriveSpendStanding } from '../permissions/spend-standing';
import { loggers } from '../logging/logger-config';
import { spendableCentsFor } from './credit-balance';
import { effectiveSpendPolicy, type FallbackRule, type SpendLeg, type WalletStatus } from './wallet-core';
import {
  ORG_ENTITLEMENT_TIER,
  PERSONAL_ROOT_NOT_YET_CREATED,
  decideCallSpend,
  personalRootDecision,
  personActor,
  reservedAgainstCents,
  resolvesDriveWallets,
  walletLeg,
  walletSpendableCents,
  type CallSpendDecision,
  type SpendTarget,
  type WalletBalanceFacts,
  type WalletHoldTotal,
} from './spend-target';
import { toSubscriptionTier, type SubscriptionTier } from './subscription-tiers';

const WALLET_FACTS = {
  id: wallets.id,
  status: wallets.status,
  parentWalletId: wallets.parentWalletId,
  monthlyRemainingCents: wallets.monthlyRemainingCents,
  monthlyAllowanceCents: wallets.monthlyAllowanceCents,
  spentCents: wallets.spentCents,
  topupRemainingCents: wallets.topupRemainingCents,
  debtCents: wallets.debtCents,
  monthlyPeriodEnd: wallets.monthlyPeriodEnd,
  fallbackRule: wallets.fallbackRule,
} as const;

type WalletRow = WalletBalanceFacts & { monthlyPeriodEnd: Date | null; fallbackRule: FallbackRule | null };

async function walletById(id: string): Promise<WalletRow | null> {
  const [row] = await db.select(WALLET_FACTS).from(wallets).where(eq(wallets.id, id)).limit(1);
  return row ?? null;
}

async function driveWalletOf(driveId: string): Promise<WalletRow | null> {
  const [row] = await db
    .select(WALLET_FACTS)
    .from(wallets)
    .where(and(eq(wallets.subjectType, 'drive'), eq(wallets.subjectId, driveId)))
    .limit(1);
  return row ?? null;
}

async function orgPoolOf(orgId: string): Promise<WalletRow | null> {
  const [row] = await db
    .select(WALLET_FACTS)
    .from(wallets)
    .where(and(
      eq(wallets.ownerType, 'org'),
      eq(wallets.orgId, orgId),
      isNull(wallets.subjectType),
      isNull(wallets.parentWalletId),
    ))
    .limit(1);
  return row ?? null;
}

async function personalRootOf(userId: string): Promise<WalletRow | null> {
  const [row] = await db.select(WALLET_FACTS).from(wallets).where(personalRootWalletOf(userId)).limit(1);
  return row ?? null;
}

/** Live holds on each of `walletIds` AND on each of their children, per holding wallet. */
async function liveHoldTotals(walletIds: string[], now: Date): Promise<WalletHoldTotal[]> {
  if (walletIds.length === 0) return [];
  const rows = await db
    .select({
      walletId: wallets.id,
      parentWalletId: wallets.parentWalletId,
      reservedCents: sql<number>`coalesce(sum(${creditHolds.estCents}), 0)`,
    })
    .from(creditHolds)
    .innerJoin(wallets, eq(wallets.id, creditHolds.walletId))
    .where(and(
      gt(creditHolds.expiresAt, now),
      or(inArray(wallets.id, walletIds), inArray(wallets.parentWalletId, walletIds)),
    ))
    .groupBy(wallets.id, wallets.parentWalletId);
  return rows.map((r) => ({ walletId: r.walletId, parentWalletId: r.parentWalletId, reservedCents: Number(r.reservedCents) }));
}

async function tierOf(userId: string): Promise<SubscriptionTier> {
  const [row] = await db.select({ tier: users.subscriptionTier }).from(users).where(eq(users.id, userId)).limit(1);
  return toSubscriptionTier(row?.tier);
}

function statusOf(row: WalletRow): WalletStatus {
  return row.status;
}

/**
 * Decide the wallet for a call by `userId` (a person) against `target`, reserving
 * `reservationCents`. `consumerTier` is the caller's own tier (their own credits' tier).
 */
export async function resolveCallSpend(input: {
  userId: string;
  consumerTier: SubscriptionTier;
  target: SpendTarget;
  reservationCents: number;
  now?: Date;
  /** Log a refusal (SPEND-4). Off for a read-only question that is not the gate itself. */
  recordRefusal?: boolean;
}): Promise<CallSpendDecision> {
  const { userId, consumerTier, target } = input;
  if (!resolvesDriveWallets({ orgsEnabled: ORGS_ENABLED, target }) || target.kind !== 'drive') {
    return personalRootDecision(consumerTier);
  }
  const now = input.now ?? new Date();

  const standing = await loadDriveSpendStanding(userId, target.driveId);
  const actor = personActor(userId, {
    orgId: standing?.orgId ?? null,
    isDriveMember: standing?.isDriveMember ?? false,
    isOrgMember: standing?.isOrgMember ?? false,
  });

  const driveWallet = standing ? await driveWalletOf(standing.driveId) : null;
  const driveParent = driveWallet?.parentWalletId ? await walletById(driveWallet.parentWalletId) : null;
  // A seat is the per-consumer leg on the org pool (WAL-2): only an org member holds one (DRV-8).
  const pool = standing?.orgId && standing.isOrgMember ? await orgPoolOf(standing.orgId) : null;
  const personal = await personalRootOf(userId);

  const holds = await liveHoldTotals(
    [driveWallet?.id, driveParent?.id, pool?.id, personal?.id].filter((id): id is string => typeof id === 'string'),
    now,
  );

  const driveLeg: SpendLeg | null = driveWallet
    ? walletLeg(driveWallet.id, statusOf(driveWallet), walletSpendableCents({
        wallet: driveWallet,
        ownReservedCents: reservedAgainstCents(holds, driveWallet.id, { includeChildren: false }),
        parent: driveParent
          ? { wallet: driveParent, reservedCents: reservedAgainstCents(holds, driveParent.id, { includeChildren: true, excludeWalletId: driveWallet.id }) }
          : null,
      }))
    : null;
  const seatLeg: SpendLeg | null = pool
    ? walletLeg(pool.id, statusOf(pool), walletSpendableCents({
        wallet: pool,
        ownReservedCents: reservedAgainstCents(holds, pool.id, { includeChildren: true }),
        parent: null,
      }))
    : null;
  // The personal leg reads as the gate will fund it (a missing row is lazily granted the
  // tier allowance there), net of what is already reserved against it.
  const personalLeg: SpendLeg = walletLeg(
    personal?.id ?? PERSONAL_ROOT_NOT_YET_CREATED,
    personal ? statusOf(personal) : 'active',
    spendableCentsFor(personal, consumerTier) - (personal ? reservedAgainstCents(holds, personal.id, { includeChildren: true }) : 0),
  );

  // POL-7: an org drive's rule may only be stricter than its org's. The org policy reader
  // (E1) has not landed, so the org rule is the strictest one, `refuse`: no fallback moves
  // a call off its chosen source until an org says so. A personal drive's own rule stands.
  const driveFallback = driveWallet?.fallbackRule ?? undefined;
  const fallback: FallbackRule = standing?.orgId
    ? effectiveSpendPolicy({ seatAllowanceCents: null, fallback: 'refuse' }, { fallback: driveFallback }).fallback
    : driveFallback ?? 'refuse';

  // WAL-8 / D-OW-14: the wallet's ROOT owner's tier governs a shared leg — the org inside
  // org drives, the drive owner (the funder of its wallet) on a personal drive.
  const walletOwnerTier: SubscriptionTier = standing?.orgId
    ? ORG_ENTITLEMENT_TIER
    : standing && !standing.isLead
      ? await tierOf(standing.ownerId)
      : consumerTier;

  const decision = decideCallSpend({
    actor,
    driveWallet: driveLeg,
    seatAllowance: seatLeg,
    personal: personalLeg,
    // D-OW-4: guests cannot spend a drive wallet by default; the per-drive switch has no
    // storage yet, so it is off everywhere.
    driveRule: { fallback, guestsMaySpendDriveWallet: false },
    chosen: target.chosen,
    // SPEND-5's "always my own credits" has no storage yet; both switches read off.
    userOverride: { alwaysOwnCredits: false, alwaysOwnCreditsInDrive: false },
    reservationCents: input.reservationCents,
    walletOwnerTier,
    consumerTier,
  });

  if (decision.kind !== 'spend' && input.recordRefusal !== false) {
    // SPEND-4: the refusal is recorded, naming the source and what was offered instead.
    loggers.ai.info('spend source refused', {
      userId,
      driveId: target.driveId,
      decision: decision.kind,
      source: decision.kind === 'refuse' ? decision.source : null,
      reason: decision.reason,
      options: decision.kind === 'refuse' ? decision.options.map((o) => o.source) : [],
    });
  }
  return decision;
}
