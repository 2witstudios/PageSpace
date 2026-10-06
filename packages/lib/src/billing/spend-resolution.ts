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

import { loadConsumerCapFacts } from './consumer-caps';
import { drives } from '@pagespace/db/schema/core';
import { formatCreditCount } from './money-model';
import { seatCapCheck, seatSpentCents } from './wallet-core';
import { db } from '@pagespace/db/db';
import { and, eq, gt, inArray, isNull, or, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { conversations } from '@pagespace/db/schema/conversations';
import { creditHolds } from '@pagespace/db/schema/credits';
import { driveSpendOverrides, wallets, personalRootWalletOf } from '@pagespace/db/schema/wallets';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';
import { isOrgActive } from '../organizations/status';
import { orgLegStatus } from '../organizations/status-core';
import { automationCreatorRemains, loadDriveSpendStanding, sharedSpendLegsFor } from '../permissions/spend-standing';
import { loggers } from '../logging/logger-config';
import { notifyLeadOfAutomationSkip } from './automation-skip-notifier';
import { spendableCentsFor } from './credit-balance';
import { effectiveSpendPolicy, type FallbackRule, type SpendLeg, type SpendSourceKind, type WalletStatus } from './wallet-core';
import {
  orgEntitlementTier,
  PERSONAL_ROOT_NOT_YET_CREATED,
  automationSpendInput,
  availableSources,
  decideCallSpend,
  personalRootDecision,
  personActor,
  reservedAgainstCents,
  resolvesDriveWallets,
  seatAllowanceLeg,
  walletLeg,
  walletSpendableCents,
  type CallSpendDecision,
  type SpendTarget,
  type StoredSpendChoice,
  type WalletBalanceFacts,
  type WalletHoldTotal,
  cappedConsumerLeg,
  spendChoiceLabel,
} from './spend-target';
import { toSubscriptionTier, type SubscriptionTier } from './subscription-tiers';
import { ensurePersonalRootWalletId } from './personal-wallet';
import { loadSeatCapFacts, loadSeatCapFactsForUsers } from './seat-allowance';
import { readOrgSpendPolicy } from '../organizations/policy-reader';
import { findOrganizationNames } from '../organizations/repository';

const WALLET_FACTS = {
  id: wallets.id,
  status: wallets.status,
  parentWalletId: wallets.parentWalletId,
  monthlyRemainingCents: wallets.monthlyRemainingCents,
  monthlyAllowanceCents: wallets.monthlyAllowanceCents,
  spentCents: wallets.spentCents,
  topupRemainingCents: wallets.topupRemainingCents,
  debtCents: wallets.debtCents,
  monthlyPeriodStart: wallets.monthlyPeriodStart,
  monthlyPeriodEnd: wallets.monthlyPeriodEnd,
  fallbackRule: wallets.fallbackRule,
  defaultSpendSource: wallets.defaultSpendSource,
  alwaysOwnCredits: wallets.alwaysOwnCredits,
} as const;

type WalletRow = WalletBalanceFacts & {
  monthlyPeriodStart: Date | null;
  monthlyPeriodEnd: Date | null;
  fallbackRule: FallbackRule | null;
  defaultSpendSource: SpendSourceKind | null;
  alwaysOwnCredits: boolean;
};

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

/**
 * The wallet `userId` stored as this conversation's choice (SPEND-3), or null when nothing was
 * chosen, the call has no conversation, or the conversation is not theirs (a choice is one
 * person's, and a caller-supplied id may not have been vetted yet when the gate runs). Whether
 * the id is one this person may spend is decided against their legs (spend-target
 * `sourceOfWallet`), never by the row.
 */
async function chosenWalletOf(userId: string, conversationId: string | null | undefined): Promise<string | null> {
  if (typeof conversationId !== 'string' || conversationId.length === 0) return null;
  const [row] = await db
    .select({ chosenWalletId: conversations.chosenWalletId })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);
  return row?.chosenWalletId ?? null;
}

/** SPEND-5: whether `userId` turned "Always my own credits" on for `driveId`. */
async function alwaysOwnCreditsInDrive(userId: string, driveId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: driveSpendOverrides.userId })
    .from(driveSpendOverrides)
    .where(and(eq(driveSpendOverrides.userId, userId), eq(driveSpendOverrides.driveId, driveId)))
    .limit(1);
  return row !== undefined;
}

async function tierOf(userId: string): Promise<SubscriptionTier> {
  const [row] = await db.select({ tier: users.subscriptionTier }).from(users).where(eq(users.id, userId)).limit(1);
  return toSubscriptionTier(row?.tier);
}

function statusOf(row: WalletRow, orgLapsed = false): WalletStatus {
  return orgLegStatus(row.status, orgLapsed);
}

/** SEAT-9: whether the drive's org is lapsed (a personal drive has no org and never is). */
async function orgLapsedFor(orgId: string | null | undefined): Promise<boolean> {
  return typeof orgId === 'string' ? !(await isOrgActive(orgId)) : false;
}

/** The drive wallet as a leg, net of every hold against it and (through the parent) its siblings. */
async function driveWalletLeg(driveWallet: WalletRow | null, now: Date, extraHoldWalletIds: string[] = [], orgLapsed = false): Promise<{
  leg: SpendLeg | null;
  holds: WalletHoldTotal[];
}> {
  const parent = driveWallet?.parentWalletId ? await walletById(driveWallet.parentWalletId) : null;
  const holds = await liveHoldTotals(
    [driveWallet?.id, parent?.id, ...extraHoldWalletIds].filter((id): id is string => typeof id === 'string'),
    now,
  );
  const leg: SpendLeg | null = driveWallet
    ? walletLeg(driveWallet.id, statusOf(driveWallet, orgLapsed), walletSpendableCents({
        wallet: driveWallet,
        ownReservedCents: reservedAgainstCents(holds, driveWallet.id, { includeChildren: false }),
        parent: parent
          ? { wallet: parent, reservedCents: reservedAgainstCents(holds, parent.id, { includeChildren: true, excludeWalletId: driveWallet.id }) }
          : null,
      }))
    : null;
  return { leg, holds };
}

/**
 * The wallet for a person-less run (SPEND-6): the drive's wallet or a skip. It reads the
 * drive and its wallet only — never a person's wallet, never the org pool as a seat — so
 * no automation can reach a person's credits or allowance. `userId` (the person the run is
 * recorded against: a workflow's creator, a trigger's scheduler, a mention's sender) is
 * used to read the drive's org and owner through the permissions layer, and — for a run no person
 * is present for — to require that its creator still stands behind it ([D-OW-34]).
 */
async function resolveAutomationSpend(input: {
  userId: string;
  driveId: string;
  reservationCents: number;
  now: Date;
  /** Log the skip and tell the lead (off for a read-only question that is not the gate itself). */
  recordSkip: boolean;
  /** A person caused this run (a mention, a manual Run) and it is gated as them, not as a creator. */
  personPresent: boolean;
}): Promise<CallSpendDecision> {
  const standing = await loadDriveSpendStanding(input.userId, input.driveId);
  // [D-OW-34] a run no person is present for runs on behalf of its creator and is bounded by their cap. A creator
  // who left took their caps with them: refuse, fail closed, before any wallet read or hold (review #2817 P2-2).
  if (!input.personPresent && !automationCreatorRemains(standing)) {
    if (input.recordSkip) loggers.ai.info('automation run refused: creator departed', { driveId: input.driveId, userId: input.userId });
    return { kind: 'skip', reason: 'creator_departed', walletId: null, chargeCents: 0 };
  }
  const driveWallet = standing ? await driveWalletOf(standing.driveId) : null;
  // SEAT-9: a lapsed org's drive wallet reads as paused, so the run SKIPS — never a person.
  const orgLapsed = await orgLapsedFor(standing?.orgId);
  const { leg } = await driveWalletLeg(driveWallet, input.now, [], orgLapsed);
  // WAL-8: the drive wallet's root owner governs — the org inside org drives, the drive
  // owner (whose personal wallet funds the drive wallet) on a personal drive.
  const walletOwnerTier: SubscriptionTier = standing?.orgId
    ? orgEntitlementTier(orgLapsed)
    : standing
      ? await tierOf(standing.ownerId)
      : 'free';
  const decision = decideCallSpend(automationSpendInput({
    driveId: input.driveId,
    driveWallet: leg,
    walletOwnerTier,
    reservationCents: input.reservationCents,
  }));
  if (decision.kind === 'skip' && input.recordSkip) {
    // SPEND-6: an empty wallet skips the run and logs it, and the lead hears of it once a period.
    loggers.ai.info('automation run skipped', {
      driveId: input.driveId,
      walletId: decision.walletId,
      reason: decision.reason,
    });
    if (orgLapsed) loggers.ai.info('automation run skipped: org lapsed', { driveId: input.driveId, orgId: standing?.orgId ?? null });
    if (standing) {
      try {
        await notifyLeadOfAutomationSkip({
          driveId: standing.driveId,
          leadUserId: standing.ownerId,
          walletId: decision.walletId,
          walletPeriodStart: driveWallet?.monthlyPeriodStart ?? null,
          reason: decision.reason,
          now: input.now,
        });
      } catch (error) {
        // The skip stands whether or not the notice lands; a failed notice is retried by the next skip.
        loggers.ai.error('automation skip notice failed', error as Error, { driveId: input.driveId });
      }
    }
  }
  return decision;
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
  if (!resolvesDriveWallets({ orgsEnabled: ORGS_ENABLED, target }) || target.kind === 'personal') {
    return personalRootDecision(consumerTier);
  }
  const now = input.now ?? new Date();
  if (target.kind === 'automation') {
    return resolveAutomationSpend({
      userId,
      driveId: target.driveId,
      reservationCents: input.reservationCents,
      now,
      recordSkip: input.recordRefusal !== false,
      personPresent: target.personPresent === true,
    });
  }

  const standing = await loadDriveSpendStanding(userId, target.driveId);
  const actor = personActor(userId, {
    orgId: standing?.orgId ?? null,
    isDriveMember: standing?.isDriveMember ?? false,
    isOrgMember: standing?.isOrgMember ?? false,
  });

  // Which shared legs this person may draw at all is decided by the permissions module from
  // their effective drive membership, NOT by the actor's guest flag: an org member with no
  // membership of a Restricted or Private org drive gets no drive-wallet leg and no seat
  // there, so no source, default or stored wallet id can reach either (review P1-2).
  const shared = sharedSpendLegsFor(standing);
  const driveWallet = standing && shared.driveWallet ? await driveWalletOf(standing.driveId) : null;
  // A seat is the per-consumer leg on the org pool (WAL-2): only an org member of the drive holds one (DRV-8).
  const pool = standing?.orgId && shared.seat ? await orgPoolOf(standing.orgId) : null;
  const personal = await personalRootOf(userId);
  // SEAT-9: while the org is lapsed its legs (drive wallet, seat) read as paused; own credits stay.
  const orgLapsed = await orgLapsedFor(standing?.orgId);
  const stored: StoredSpendChoice = {
    chosenWalletId: await chosenWalletOf(userId, target.conversationId),
    driveDefault: driveWallet?.defaultSpendSource ?? null,
    personalDefault: personal?.defaultSpendSource ?? null,
  };

  const { leg: uncappedDriveLeg, holds } = await driveWalletLeg(
    driveWallet,
    now,
    [pool?.id, personal?.id].filter((id): id is string => typeof id === 'string'),
    orgLapsed,
  );
  // WAL-7: this person's own caps on the drive wallet bound their leg of it; a spent cap refuses
  // by name (source_cap_reached). The gate re-checks under the wallet's lock.
  const driveLeg = uncappedDriveLeg && driveWallet
    ? cappedConsumerLeg(uncappedDriveLeg, (await loadConsumerCapFacts(db, { walletId: driveWallet.id, userId, now }))?.remaining ?? null)
    : uncappedDriveLeg;
  // WAL-2: a seat is the pool capped per consumer — never more than what is left of this
  // person's monthly allowance this pool period (D-OW-12). The gate re-checks it under the lock.
  // POL-7: both the allowance and the fallback come from the org's policy row, read now.
  const orgPolicy = standing?.orgId ? await readOrgSpendPolicy(db, standing.orgId) : null;
  const seatLeg: SpendLeg | null = pool && orgPolicy
    ? seatAllowanceLeg({
        poolId: pool.id,
        status: statusOf(pool, orgLapsed),
        poolSpendableCents: walletSpendableCents({
          wallet: pool,
          ownReservedCents: reservedAgainstCents(holds, pool.id, { includeChildren: true }),
          parent: null,
        }),
        ...(await loadSeatCapFacts(db, {
          poolId: pool.id,
          poolPeriodStart: pool.monthlyPeriodStart,
          userId,
          policySeatAllowanceCents: orgPolicy.seatAllowanceCents,
          now,
        })),
      })
    : null;
  // The personal leg reads as the gate will fund it (a missing row is lazily granted the
  // tier allowance there), net of what is already reserved against it.
  const personalLeg: SpendLeg = walletLeg(
    personal?.id ?? PERSONAL_ROOT_NOT_YET_CREATED,
    personal ? statusOf(personal) : 'active',
    spendableCentsFor(personal, consumerTier) - (personal ? reservedAgainstCents(holds, personal.id, { includeChildren: true }) : 0),
  );

  // POL-7: an org drive's rule may only be stricter than its org's (effectiveSpendPolicy): it applies
  // when it restates the org rule or is `refuse`, and any other value resolves to `refuse`. A personal
  // drive's own rule stands.
  const driveFallback = driveWallet?.fallbackRule ?? undefined;
  const fallback: FallbackRule = orgPolicy
    ? effectiveSpendPolicy(orgPolicy, { fallback: driveFallback }).fallback
    : driveFallback ?? 'refuse';

  // WAL-8 / D-OW-14: the wallet's ROOT owner's tier governs a shared leg — the org inside
  // org drives, the drive owner (the funder of its wallet) on a personal drive.
  const walletOwnerTier: SubscriptionTier = standing?.orgId
    ? orgEntitlementTier(orgLapsed)
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
    followOn: target.followOn === true,
    fallbackFromWalletId: target.fallbackFromWalletId ?? null,
    stored,
    // SPEND-5 "Always my own credits": the global switch on the person's own root wallet and
    // the switch for this drive. Either makes the call own credits or a refusal; it opens no
    // other wallet, so it cannot widen what this person may spend or pass a seat's cap.
    userOverride: {
      alwaysOwnCredits: personal?.alwaysOwnCredits ?? false,
      alwaysOwnCreditsInDrive: await alwaysOwnCreditsInDrive(userId, target.driveId),
    },
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
      chosenWalletId: stored.chosenWalletId,
      options: decision.kind === 'refuse' ? decision.options.map((o) => o.source) : [],
      orgLapsed,
    });
  }
  return decision;
}

/** One source a person may pick for a call, named by the wallet it spends. */
export interface SpendChoice {
  source: SpendSourceKind;
  walletId: string;
  /** What the chip and popover call it (spendChoiceLabel): never a raw id (UI-8). */
  label: string;
  /** The drive a drive wallet funds, or the org a seat is in; null for own credits. */
  driveName: string | null;
  orgName: string | null;
  /**
   * What THIS person can still spend from it now, whole cents and as a credit count (SPEND-9):
   * a drive wallet's remaining amount bounded by their own caps; a seat's remaining allowance
   * (their own cap, never the pool); their own credits. `null` (both) when the source sets no
   * limit of its own on this person — never a sentinel number.
   */
  remainingCents: number | null;
  remainingCredits: string | null;
}

/**
 * The sources `userId` may pick in a session of `driveId` (null: no drive, SPEND-8), each
 * with the wallet it spends — the ids a conversation may store as its choice (SPEND-3). The
 * same legs the gate reads, opened by the same permissions rule (sharedSpendLegsFor), with
 * no balances: whether a source can cover a call is the gate's question, asked per call.
 * The personal root wallet is created bare if missing, so own credits always has an id (the
 * gate grants into a bare row exactly as it always has).
 */
export async function listSpendChoices(userId: string, driveId: string | null): Promise<SpendChoice[]> {
  const personalId = await ensurePersonalRootWalletId(db, userId);
  const personal = await personalRootOf(userId);
  const ownRemaining = Math.max(0, spendableCentsFor(personal, await tierOf(userId)));
  const choice = (source: SpendSourceKind, walletId: string, names: { driveName: string | null; orgName: string | null }, remainingCents: number | null): SpendChoice => ({
    source,
    walletId,
    label: spendChoiceLabel({ source, ...names }),
    ...names,
    remainingCents,
    remainingCredits: remainingCents === null ? null : formatCreditCount(remainingCents),
  });
  const own = choice('own_credits', personalId, { driveName: null, orgName: null }, ownRemaining);
  if (!ORGS_ENABLED || driveId === null) return [own];

  const now = new Date();
  const standing = await loadDriveSpendStanding(userId, driveId);
  const shared = sharedSpendLegsFor(standing);
  const driveWallet = standing && shared.driveWallet ? await driveWalletOf(standing.driveId) : null;
  const pool = standing?.orgId && shared.seat ? await orgPoolOf(standing.orgId) : null;
  const actor = personActor(userId, {
    orgId: standing?.orgId ?? null,
    isDriveMember: standing?.isDriveMember ?? false,
    isOrgMember: standing?.isOrgMember ?? false,
  });
  const orgLapsed = await orgLapsedFor(standing?.orgId);
  const legs = {
    actor,
    driveWallet: driveWallet ? walletLeg(driveWallet.id, statusOf(driveWallet, orgLapsed), 0) : null,
    seatAllowance: pool ? walletLeg(pool.id, statusOf(pool, orgLapsed), 0) : null,
    personal: walletLeg(personalId, 'active', 0),
    // D-OW-4: guests may not spend a drive wallet until the per-drive switch has storage.
    driveRule: { fallback: 'refuse' as const, guestsMaySpendDriveWallet: false },
  };
  const names = await spendPlaceNames(driveId, standing?.orgId ?? null);
  const out: SpendChoice[] = [];
  for (const source of availableSources(legs)) {
    if (source === 'own_credits') out.push(own);
    if (source === 'drive_wallet' && driveWallet) {
      const { leg } = await driveWalletLeg(driveWallet, now, [], orgLapsed);
      const capped = leg ? cappedConsumerLeg(leg, (await loadConsumerCapFacts(db, { walletId: driveWallet.id, userId, now }))?.remaining ?? null) : null;
      out.push(choice('drive_wallet', driveWallet.id, names, capped?.spendableCents ?? 0));
    }
    if (source === 'seat_allowance' && pool && standing?.orgId) {
      // The seat's own remaining allowance (SPEND-9: their cap, never the pool's balance).
      const seat = await seatAllowanceFor(db, { orgId: standing.orgId, poolId: pool.id, poolPeriodStart: pool.monthlyPeriodStart, userId, now });
      out.push(choice('seat_allowance', pool.id, names, seat.remainingCents));
    }
  }
  return out;
}

/** A member's seat on an org's pool as they may see it: their own allowance, never the pool (SPEND-9). */
export interface SeatAllowanceView {
  /** Their monthly seat allowance (WAL-2: a seat is never unlimited). */
  allowanceCents: number;
  /** What they have spent of it this period, as the cap counts it. */
  spentCents: number;
  /** What they can still spend now: the tighter of the monthly and (when set) daily windows. */
  remainingCents: number;
}

/** One seat in full, for the org's Members & seats (its Owner and Admins see each window and the caps set). */
export interface SeatAllowanceDetail extends SeatAllowanceView {
  /** What is left this period and today; daily null = no daily limit. */
  monthlyRemainingCents: number;
  dailyRemainingCents: number | null;
  /** The member's own caps on their seat; null = none set (the monthly then falls to the org's allowance). */
  dailyCapCents: number | null;
  monthlyCapCents: number | null;
}

/**
 * The ONE computation of seat allowance remaining (D-OW-38 read model), for any number of members of one
 * org pool: the policy through its one reader (readOrgSpendPolicy), the gate's own facts
 * (loadSeatCapFactsForUsers: four queries whatever the member count) and the gate's own cap check at a
 * zero reservation. seatAllowanceFor (the spending-from popover, Settings › Usage › Wallets) and
 * listOrgSeatCaps (Members & seats) both read through it, so every surface and the gate agree.
 */
export async function seatAllowancesFor(
  executor: typeof db,
  input: { orgId: string; poolId: string; poolPeriodStart: Date | null; userIds: readonly string[]; now: Date },
): Promise<{ seatAllowanceCents: number; seats: Map<string, SeatAllowanceDetail> }> {
  const policy = await readOrgSpendPolicy(executor, input.orgId);
  const facts = await loadSeatCapFactsForUsers(executor, { poolId: input.poolId, poolPeriodStart: input.poolPeriodStart, userIds: input.userIds, policySeatAllowanceCents: policy.seatAllowanceCents, now: input.now });
  const seats = new Map<string, SeatAllowanceDetail>();
  for (const [userId, seat] of facts) {
    const cap = seatCapCheck({ capCents: seat.capCents, dailyCapCents: seat.dailyCapCents, usage: seat.usage, reservationCents: 0 });
    // The monthly window always exists on a seat (WAL-2: never unlimited), so it is always a number.
    const monthlyRemainingCents = cap.monthlyRemainingCents ?? seat.capCents;
    seats.set(userId, {
      allowanceCents: seat.capCents,
      spentCents: seatSpentCents(seat.usage.periodChargedMillicents),
      monthlyRemainingCents,
      dailyRemainingCents: cap.dailyRemainingCents,
      remainingCents: Math.min(monthlyRemainingCents, cap.dailyRemainingCents ?? monthlyRemainingCents),
      dailyCapCents: seat.dailyCapCents,
      monthlyCapCents: seat.consumerMonthlyCapCents,
    });
  }
  return { seatAllowanceCents: policy.seatAllowanceCents, seats };
}

/** One member's seat allowance as they see it (seatAllowancesFor, for one member). */
export async function seatAllowanceFor(
  executor: typeof db,
  input: { orgId: string; poolId: string; poolPeriodStart: Date | null; userId: string; now: Date },
): Promise<SeatAllowanceView> {
  const { seats } = await seatAllowancesFor(executor, { ...input, userIds: [input.userId] });
  const seat = seats.get(input.userId);
  if (!seat) throw new Error('seatAllowanceFor: no seat for the requested member');
  return { allowanceCents: seat.allowanceCents, spentCents: seat.spentCents, remainingCents: seat.remainingCents };
}

/** The drive's and the org's names, for labels (UI-8). */
async function spendPlaceNames(driveId: string, orgId: string | null): Promise<{ driveName: string | null; orgName: string | null }> {
  const [drive] = await db.select({ name: drives.name }).from(drives).where(eq(drives.id, driveId));
  const orgName = orgId ? (await findOrganizationNames([orgId])).get(orgId) ?? null : null;
  return { driveName: drive?.name ?? null, orgName };
}
