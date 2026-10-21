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
 * For the personal target it reads nothing and answers the personal root wallet.
 */

import { loadConsumerCapFacts } from './consumer-caps';
import { drives, pages } from '@pagespace/db/schema/core';
import { formatCreditCount } from './money-model';
import { seatCapCheck, seatSpentCents } from './wallet-core';
import { db } from '@pagespace/db/db';
import { and, eq, gt, inArray, isNull, or, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { conversations } from '@pagespace/db/schema/conversations';
import { creditHolds } from '@pagespace/db/schema/credits';
import { driveSpendOverrides, wallets, personalRootWalletOf } from '@pagespace/db/schema/wallets';
import { isOrgActive } from '../organizations/status';
import { orgLegStatus } from '../organizations/status-core';
import { automationCreatorRemains, loadDriveSpendStanding, sharedSpendLegsFor } from '../permissions/spend-standing';
import { loggers } from '../logging/logger-config';
import { notifyLeadOfAutomationSkip } from './automation-skip-notifier';
import { spendableCentsFor } from './credit-balance';
import { effectiveSpendPolicy, walletChainStatus, type FallbackRule, type SpendLeg, type SpendSourceKind, type WalletStatus } from './wallet-core';
import {
  orgEntitlementTier,
  PERSONAL_ROOT_NOT_YET_CREATED,
  automationSpendInput,
  availableSources,
  decideCallSpend,
  personalRootDecision,
  personActor,
  reservedAgainstCents,
  seatAllowanceLeg,
  walletLeg,
  walletSpendableCents,
  sourceToPin,
  type CallSpendDecision,
  type CallSpendInput,
  type SpendTarget,
  type StoredSpendChoice,
  type WalletBalanceFacts,
  type WalletHoldTotal,
  cappedConsumerLeg,
  driveWalletConsumerRemainingCents,
  spendChoiceLabel,
} from './spend-target';
import { toPersonalSubscriptionTier, type SubscriptionTier } from './subscription-tiers';
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
  guestSpendEnabled: wallets.guestSpendEnabled,
} as const;

type WalletRow = WalletBalanceFacts & {
  monthlyPeriodStart: Date | null;
  monthlyPeriodEnd: Date | null;
  fallbackRule: FallbackRule | null;
  defaultSpendSource: SpendSourceKind | null;
  alwaysOwnCredits: boolean;
  /** D-OW-4: the drive opened its wallet to guests (a drive wallet's switch; false on any other row). */
  guestSpendEnabled: boolean;
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

/**
 * SPEND-3: store `walletId` as the source of `userId`'s conversation, once — only while it stores
 * none, so an explicit choice (the conversation-spend route) or an earlier pin always wins and a
 * replay is a no-op. Only a conversation whose own drive is `driveId` (a page conversation on a
 * page of that drive, a drive or API-client conversation of it) is pinned, so a caller-supplied
 * id the route has not vetted yet can never pin another drive's wallet onto a conversation. A
 * GLOBAL conversation is never pinned: its drive is wherever the person is (SPEND-7), so a drive
 * wallet stored for it would refuse the moment they move drives. A conversation whose row does
 * not exist yet (a first turn gates before it is created) is pinned by its creator right after
 * the insert, with the wallet the gate returned.
 */
export async function pinConversationSource(input: { userId: string; conversationId: string; driveId: string; walletId: string }): Promise<void> {
  await db
    .update(conversations)
    .set({ chosenWalletId: input.walletId })
    .where(and(
      eq(conversations.id, input.conversationId),
      eq(conversations.userId, input.userId),
      isNull(conversations.chosenWalletId),
      or(
        and(inArray(conversations.type, ['drive', 'client']), eq(conversations.contextId, input.driveId)),
        and(
          eq(conversations.type, 'page'),
          inArray(conversations.contextId, db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, input.driveId))),
        ),
      ),
    ));
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
  return toPersonalSubscriptionTier(row?.tier);
}

function statusOf(row: WalletRow, orgLapsed = false): WalletStatus {
  return orgLegStatus(row.status, orgLapsed);
}

/** SEAT-9: whether the drive's org is lapsed (a personal drive has no org and never is). */
async function orgLapsedFor(orgId: string | null | undefined): Promise<boolean> {
  return typeof orgId === 'string' ? !(await isOrgActive(orgId)) : false;
}

/**
 * The drive wallet as a leg, net of every hold against it and (through the parent) its siblings.
 * WAL-7: it spends as paused when its parent is paused — an org pool's kill switch stops every
 * drive wallet it funds, not only its seats.
 */
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
    ? walletLeg(driveWallet.id, walletChainStatus(statusOf(driveWallet, orgLapsed), parent ? statusOf(parent, orgLapsed) : null), walletSpendableCents({
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
 * gated as: a workflow's creator, a trigger's scheduler, a mention's sender, a Run's presser)
 * is used to read their standing through the permissions layer: for a run no person is present
 * for, its creator must still stand behind it ([D-OW-34]); a person present must be able to draw
 * the drive wallet at all (sharedSpendLegsFor), and a guest only where the drive opened it to
 * guests (D-OW-4). Their caps bound the leg (WAL-7; a guest is always capped), so a spent cap
 * skips by name and the lead hears of it like any other skip.
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
  // A person present spends only a drive wallet they may draw (the chat path's rule); an automation's creator
  // was vetted above. A Home drive's wallet is never drawn, by anyone (sharedSpendLegsFor).
  const mayDraw = input.personPresent ? sharedSpendLegsFor(standing).driveWallet : standing !== null && standing.isHome !== true;
  const driveWallet = standing && mayDraw ? await driveWalletOf(standing.driveId) : null;
  // SEAT-9: a lapsed org's drive wallet reads as paused, so the run SKIPS — never a person.
  const orgLapsed = await orgLapsedFor(standing?.orgId);
  const gatedAs = personActor(input.userId, {
    orgId: standing?.orgId ?? null,
    isDriveMember: standing?.isDriveMember ?? false,
    isOrgMember: standing?.isOrgMember ?? false,
  });
  const gatedAsGuest = gatedAs.kind === 'person' && gatedAs.isGuest;
  const { leg: uncappedLeg } = await driveWalletLeg(driveWallet, input.now, [], orgLapsed);
  const leg = uncappedLeg && driveWallet
    ? cappedConsumerLeg(uncappedLeg, (await loadConsumerCapFacts(db, { walletId: driveWallet.id, userId: input.userId, now: input.now, isGuest: gatedAsGuest }))?.remaining ?? null)
    : uncappedLeg;
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
    gatedAsGuest,
    guestsMaySpendDriveWallet: driveWallet?.guestSpendEnabled ?? false,
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
}): Promise<CallSpendDecision & { preselectedWalletId?: string }> {
  const { userId, consumerTier, target } = input;
  if (target.kind === 'personal') {
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
    ? cappedConsumerLeg(uncappedDriveLeg, (await loadConsumerCapFacts(db, { walletId: driveWallet.id, userId, now, isGuest: actor.kind === 'person' && actor.isGuest }))?.remaining ?? null)
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

  const callInput: CallSpendInput = {
    actor,
    driveWallet: driveLeg,
    seatAllowance: seatLeg,
    personal: personalLeg,
    // D-OW-4: guests cannot spend a drive wallet by default; the drive's switch opens it to them.
    driveRule: { fallback, guestsMaySpendDriveWallet: driveWallet?.guestSpendEnabled ?? false },
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
  };
  const decision = decideCallSpend(callInput);

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
  // SPEND-3: the wallet of the source this call PRESELECTED (spend-target `sourceToPin`), if any.
  // Resolution only names it; the gate persists it (persistPreselectedSource).
  const preselected = preselectedWalletOf(callInput);
  return preselected ? { ...decision, preselectedWalletId: preselected } : decision;
}

/** The wallet of the source a call preselected (it may be the not-yet-created personal root's placeholder). */
function preselectedWalletOf(callInput: CallSpendInput): string | null {
  const source = sourceToPin(callInput);
  if (source === null) return null;
  const leg = source === 'drive_wallet' ? callInput.driveWallet : source === 'seat_allowance' ? callInput.seatAllowance : callInput.personal;
  return leg?.walletId ?? null;
}

/**
 * SPEND-3, the gate's write after resolving: store the wallet a conversation's first call
 * preselected as the conversation's own (pinConversationSource: once, never over a stored choice).
 * Own credits name the person's root wallet, created bare if it does not exist yet (the gate grants
 * into a bare row as it always has). Returns the wallet stored for, so a turn that creates its
 * conversation row after the gate can pin it then.
 */
/** @public Used by credit-gate through a lazy `await import()` that knip cannot follow. */
export async function persistPreselectedSource(input: { userId: string; target: SpendTarget; preselectedWalletId: string | undefined }): Promise<string | undefined> {
  const { target } = input;
  if (target.kind !== 'drive' || typeof target.conversationId !== 'string' || target.conversationId.length === 0) return undefined;
  if (!input.preselectedWalletId) return undefined;
  const walletId = input.preselectedWalletId === PERSONAL_ROOT_NOT_YET_CREATED ? await ensurePersonalRootWalletId(db, input.userId) : input.preselectedWalletId;
  await pinConversationSource({ userId: input.userId, conversationId: target.conversationId, driveId: target.driveId, walletId });
  return walletId;
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
  if (driveId === null) return [own];

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
    // D-OW-4: guests may spend a drive wallet only where the drive's switch is on.
    driveRule: { fallback: 'refuse' as const, guestsMaySpendDriveWallet: driveWallet?.guestSpendEnabled ?? false },
  };
  const names = await spendPlaceNames(driveId, standing?.orgId ?? null);
  const out: SpendChoice[] = [];
  for (const source of availableSources(legs)) {
    if (source === 'own_credits') out.push(own);
    if (source === 'drive_wallet' && driveWallet) {
      // SPEND-9: the wallet's own remaining amount bounded by their own caps — never a figure bounded by the
      // pool or the funder's personal wallet behind it. Whether that parent can cover a call is the gate's
      // question; when it cannot, the call is refused by name (source_empty), and no balance is disclosed.
      const caps = (await loadConsumerCapFacts(db, { walletId: driveWallet.id, userId, now, isGuest: actor.kind === 'person' && actor.isGuest }))?.remaining ?? null;
      out.push(choice('drive_wallet', driveWallet.id, names, driveWalletConsumerRemainingCents(driveWallet, caps)));
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
