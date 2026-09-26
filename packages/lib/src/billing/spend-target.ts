/**
 * spend-target — the PURE decisions the wallet-aware credit gate makes before any AI call
 * (Spec WAL-5, WAL-6, WAL-8, SPEND-1, SPEND-4, SPEND-7, SPEND-8).
 *
 * The gate is told three things: WHO spends (the actor), WHERE the call runs (the drive of
 * the session, SPEND-7) and WHAT the caller chose (the chosen source, SPEND-1). This module
 * turns those, plus the wallet rows the shell read, into the ONE wallet the call names
 * before it runs, or a refusal that charges nothing (SPEND-4). The source decision itself is
 * wallet-core's `resolveSpendSource`; this module only builds its input and reads its
 * answer, so there is still one resolver.
 *
 * INVARIANT: zero I/O, as wallet-core. The shell (spend-resolution.ts) loads rows and holds
 * and calls these; credit-gate.ts reserves on the answer.
 */

import {
  childSpendableCents,
  coveredSpendOptions,
  entitlementTierFor,
  resolveSpendSource,
  type DriveSpendRule,
  type RefusalReason,
  type SkipReason,
  type SpendActor,
  type SpendLeg,
  type SpendOption,
  type SpendSourceKind,
  type UserSpendOverride,
  type WalletFunds,
  type WalletStatus,
} from './wallet-core';
import type { SubscriptionTier } from './subscription-tiers';

// ---------------------------------------------------------------------------
// The target a caller names (SPEND-1, SPEND-7, SPEND-8)
// ---------------------------------------------------------------------------

/**
 * Where an AI call spends from, as its caller names it before the call.
 *
 * - `personal`: no drive. The global assistant with no drive (SPEND-8), and every surface
 *   that is not a drive session (a personal dashboard summary, voice, compute), spends the
 *   caller's personal root wallet exactly as before wallets existed.
 * - `drive`: the call runs in a session of `driveId`. That is the drive of the SESSION, not
 *   the drive an agent page lives in (SPEND-7). `chosen` is the source picked before the
 *   call; null when the caller has none to pass (the gate then refuses unless exactly one
 *   source exists for this person, see {@link preselectSoleSource}).
 * - `automation`: a run no person is present for — an automation, a trigger, a scheduled
 *   workflow, a channel mention — in `driveId`. The consumer is the drive and the only
 *   source is its wallet; an uncovered wallet skips the run (SPEND-6). There is no chosen
 *   source to pass, because there is nothing to choose between.
 */
export type SpendTarget =
  | { kind: 'personal' }
  | {
      kind: 'drive';
      driveId: string;
      chosen: SpendSourceKind | null;
      /**
       * The conversation the call answers, whose stored choice (conversations.chosenWalletId)
       * the gate resolves (SPEND-3). Absent or null for a call with no conversation; the
       * drive's and the person's defaults still apply.
       */
      conversationId?: string | null;
    }
  | { kind: 'automation'; driveId: string };

/** The personal root wallet: no drive (SPEND-8). */
export const PERSONAL_SPEND: SpendTarget = Object.freeze({ kind: 'personal' });

/**
 * The target for a call running in a session of `driveId`. A session with no drive (the
 * global assistant outside any drive) is the personal target (SPEND-8), so callers can pass
 * an optional driveId straight through.
 */
export function driveSpend(driveId: string | null | undefined, chosen: SpendSourceKind | null = null): SpendTarget {
  return typeof driveId === 'string' && driveId.length > 0 ? { kind: 'drive', driveId, chosen } : PERSONAL_SPEND;
}

/**
 * The target for a turn of `conversationId` running in a session of `driveId`: the gate
 * reads the conversation's stored choice (SPEND-3). `driveId` must be SERVER-resolved (the
 * conversation's or page's drive), never a drive id the client sent. No drive is personal.
 */
export function conversationSpend(driveId: string | null | undefined, conversationId: string | null | undefined): SpendTarget {
  const target = driveSpend(driveId);
  return target.kind === 'drive' && typeof conversationId === 'string' && conversationId.length > 0
    ? { ...target, conversationId }
    : target;
}

/**
 * The target for a person-less run in `driveId` (SPEND-6): it spends the drive wallet or
 * is skipped, never a person's credits or allowance.
 */
export function automationSpend(driveId: string): SpendTarget {
  return { kind: 'automation', driveId };
}

/**
 * SPEND-6, fail closed: an automation about to call a model with NO reserved wallet. Its
 * usage would settle through consumeCredits' fallback onto the recorded person's personal
 * root, which an automation must never reach. Refuse the run before the model is called.
 * Only while wallets are live (orgs on, billing on); while orgs are dark an automation
 * bills as before wallets, and with billing off nothing settles at all.
 */
export function automationRunUnreserved(input: {
  orgsEnabled: boolean;
  billingEnabled: boolean;
  target: SpendTarget;
  walletId: string | undefined;
}): boolean {
  return input.billingEnabled
    && input.orgsEnabled
    && input.target.kind === 'automation'
    && (input.walletId === undefined || input.walletId.length === 0);
}

/**
 * The target a follow-on call in the same turn names once the turn's gate resolved
 * `source`: the same drive and exactly the source already chosen, so a tool that gates
 * its own model call can never land on a different wallet than the turn it runs in.
 */
export function resolvedSpend(target: SpendTarget, source: SpendSourceKind | undefined): SpendTarget {
  if (target.kind !== 'drive' || source === undefined) return target;
  return { ...target, chosen: source };
}

/**
 * Whether the gate resolves a wallet at all. While orgs are dark (ORGS_ENABLED false),
 * and for the personal target, every call spends the personal root wallet exactly as it
 * did before wallets: no wallet reads, no new refusals. That includes an automation while
 * orgs are dark: it bills the person it has always billed until wallets turn on.
 */
export function resolvesDriveWallets(input: { orgsEnabled: boolean; target: SpendTarget }): boolean {
  return input.orgsEnabled && input.target.kind !== 'personal';
}

// ---------------------------------------------------------------------------
// Who spends (DRV-8, D-OW-4)
// ---------------------------------------------------------------------------

/** A person's standing in the drive their call runs in, as the permissions layer answers it. */
export interface SpendStanding {
  /** The drive's org, or null for a personal drive. */
  orgId: string | null;
  /** The lead or an effective member of the drive. */
  isDriveMember: boolean;
  /** An accepted member of the drive's org (never true for a personal drive). */
  isOrgMember: boolean;
}

/**
 * The spending actor for a person. A guest is a drive member who is not in the drive's org
 * (DRV-8); a person with no drive membership at all is treated the same (fail closed: they
 * spend no shared money by default, D-OW-4). A personal drive has no org, so its members are
 * not guests.
 */
export function personActor(userId: string, standing: SpendStanding): SpendActor {
  const isGuest = standing.orgId !== null ? !standing.isOrgMember : !standing.isDriveMember;
  return { kind: 'person', userId, isGuest };
}

// ---------------------------------------------------------------------------
// Wallet rows → legs (WAL-2, WAL-3)
// ---------------------------------------------------------------------------

/** The money columns of one wallets row (whole cents), as the shell reads them. */
export interface WalletBalanceFacts {
  id: string;
  status: WalletStatus;
  parentWalletId: string | null;
  monthlyRemainingCents: number;
  monthlyAllowanceCents: number;
  spentCents: number;
  topupRemainingCents: number;
  debtCents: number;
}

function whole(cents: number): number {
  return Number.isFinite(cents) ? Math.round(cents) : 0;
}

/**
 * A ROOT wallet's (personal wallet, org pool) available cents: monthly + top-up − debt −
 * what its outstanding holds already reserve. May be negative (debt, over-reservation).
 */
export function rootAvailableCents(wallet: WalletBalanceFacts, reservedCents: number): number {
  return (
    whole(wallet.monthlyRemainingCents) +
    whole(wallet.topupRemainingCents) -
    Math.max(0, whole(wallet.debtCents)) -
    Math.max(0, whole(reservedCents))
  );
}

/**
 * A CHILD wallet's (drive wallet) funds for wallet-core: its allocation is the budget drawn
 * against the parent (monthlyAllowanceCents, of which spentCents is drawn), and its top-up
 * remainder is one owner funding leg.
 */
export function childWalletFunds(wallet: WalletBalanceFacts): WalletFunds {
  return {
    allocationCents: Math.max(0, whole(wallet.monthlyAllowanceCents)),
    allocationSpentCents: Math.max(0, whole(wallet.spentCents)),
    topupLegs: [{ legId: `${wallet.id}:topup`, funder: 'owner', donorUserId: null, remainingCents: Math.max(0, whole(wallet.topupRemainingCents)) }],
    debtCents: Math.max(0, whole(wallet.debtCents)),
  };
}

/**
 * What a wallet can still spend for a new call, net of every hold already reserved against
 * it. `ownReservedCents` is the holds on this wallet; for a child wallet, `parent` is its
 * parent and the holds reserved against the parent by everything else (the parent's own
 * holds and its other children's), which bound how much allocation can still be drawn.
 * Never negative.
 */
export function walletSpendableCents(input: {
  wallet: WalletBalanceFacts;
  ownReservedCents: number;
  parent: { wallet: WalletBalanceFacts; reservedCents: number } | null;
}): number {
  const own = Math.max(0, whole(input.ownReservedCents));
  if (input.wallet.parentWalletId === null || input.parent === null) {
    return Math.max(0, rootAvailableCents(input.wallet, own));
  }
  const parentAvailable = Math.max(0, rootAvailableCents(input.parent.wallet, input.parent.reservedCents));
  return Math.max(0, childSpendableCents(childWalletFunds(input.wallet), parentAvailable) - own);
}

/** Live holds on one wallet, with that wallet's parent (so holds on children can be rolled up). */
export interface WalletHoldTotal {
  walletId: string;
  parentWalletId: string | null;
  reservedCents: number;
}

/**
 * What outstanding holds reserve against `walletId`. A child wallet's spend draws its
 * allocation from the parent, so holds on a wallet's CHILDREN also reserve against it
 * (`includeChildren`), except `excludeWalletId` — the child being evaluated, whose own
 * holds are counted once, against itself.
 */
export function reservedAgainstCents(
  holds: readonly WalletHoldTotal[],
  walletId: string,
  options: { includeChildren: boolean; excludeWalletId?: string },
): number {
  return holds.reduce((sum, h) => {
    if (h.walletId === options.excludeWalletId) return sum;
    const counts = h.walletId === walletId || (options.includeChildren && h.parentWalletId === walletId);
    return counts ? sum + Math.max(0, whole(h.reservedCents)) : sum;
  }, 0);
}

/** One wallet as a SpendLeg for wallet-core. */
export function walletLeg(walletId: string, status: WalletStatus, spendableCents: number): SpendLeg {
  return { walletId, status, spendableCents: Math.max(0, whole(spendableCents)) };
}

// ---------------------------------------------------------------------------
// Chosen source (SPEND-1, SPEND-2, SPEND-4)
// ---------------------------------------------------------------------------

export interface CallSpendLegs {
  actor: SpendActor;
  driveWallet: SpendLeg | null;
  seatAllowance: SpendLeg | null;
  personal: SpendLeg | null;
  driveRule: DriveSpendRule;
}

/** The sources this actor may spend at all, whatever their balance. */
export function availableSources(legs: CallSpendLegs): SpendSourceKind[] {
  if (legs.actor.kind === 'automation') return legs.driveWallet ? ['drive_wallet'] : [];
  const isGuest = legs.actor.isGuest;
  const sources: SpendSourceKind[] = [];
  if (legs.driveWallet && (!isGuest || legs.driveRule.guestsMaySpendDriveWallet)) sources.push('drive_wallet');
  if (legs.seatAllowance && !isGuest) sources.push('seat_allowance');
  if (legs.personal) sources.push('own_credits');
  return sources;
}

/**
 * The chosen source, or the ONLY source this person has when the caller passed none.
 * Where one source exists there is nothing to choose between, and it is the source the
 * header already shows (SPEND-2: the chip changes only where more than one source exists),
 * so naming it is not a silent pick. With two or more, nothing is preselected here and the
 * gate refuses `no_source_chosen` with the options (SPEND-4); preselection from the drive's
 * or person's default (SPEND-3) is the caller's job and arrives as `chosen`.
 */
export function preselectSoleSource(chosen: SpendSourceKind | null, legs: CallSpendLegs): SpendSourceKind | null {
  if (chosen !== null) return chosen;
  const sources = availableSources(legs);
  return sources.length === 1 ? sources[0] : null;
}

// ---------------------------------------------------------------------------
// The stored choice (SPEND-3): conversations.chosenWalletId, wallets.defaultSpendSource
// ---------------------------------------------------------------------------

/**
 * What is stored about the source for a call, as the shell read it:
 *   - `chosenWalletId`: the conversation's explicit choice (conversations.chosenWalletId);
 *     null when nothing was chosen for it.
 *   - `driveDefault`: the drive wallet's defaultSpendSource; null when none is set.
 *   - `personalDefault`: the person's own default, on their personal root wallet.
 */
export interface StoredSpendChoice {
  chosenWalletId: string | null;
  driveDefault: SpendSourceKind | null;
  personalDefault: SpendSourceKind | null;
}

export const NO_STORED_CHOICE: StoredSpendChoice = Object.freeze({ chosenWalletId: null, driveDefault: null, personalDefault: null });

/**
 * The source a stored wallet id is for THIS person in THIS drive: the drive wallet, the
 * seat on the org pool (only a leg when they hold a seat), or their own personal wallet.
 * Anything else — a deleted wallet, someone else's, another drive's, a seat they no longer
 * hold — is null. The legs are what the shell loaded for this person through the
 * permissions module, so an id can only map to a wallet they may spend now.
 */
export function sourceOfWallet(walletId: string, legs: CallSpendLegs): SpendSourceKind | null {
  if (walletId === PERSONAL_ROOT_NOT_YET_CREATED) return null;
  if (legs.driveWallet?.walletId === walletId) return 'drive_wallet';
  if (legs.seatAllowance?.walletId === walletId) return 'seat_allowance';
  if (legs.personal?.walletId === walletId) return 'own_credits';
  return null;
}

export type ChosenSource =
  | { kind: 'source'; source: SpendSourceKind; via: 'turn' | 'conversation' | 'drive_default' | 'personal_default' }
  | { kind: 'none' }
  /** A stored choice that names no wallet this person may spend: refused, never replaced. */
  | { kind: 'invalid'; chosenWalletId: string };

/**
 * The source for a call, in order (SPEND-3): the source this turn already resolved (a
 * follow-on call), the conversation's explicit choice, the drive's default, the person's
 * default. A default names a KIND and is skipped where this person may not spend that kind
 * (a guest and the drive wallet); a stored choice names a WALLET and is never skipped — if
 * it resolves to nothing the answer is `invalid`, so the gate refuses rather than moving the
 * conversation onto another source (SPEND-4).
 */
export function chooseSource(turnSource: SpendSourceKind | null, stored: StoredSpendChoice, legs: CallSpendLegs): ChosenSource {
  if (turnSource !== null) return { kind: 'source', source: turnSource, via: 'turn' };
  if (stored.chosenWalletId !== null) {
    const source = sourceOfWallet(stored.chosenWalletId, legs);
    return source === null ? { kind: 'invalid', chosenWalletId: stored.chosenWalletId } : { kind: 'source', source, via: 'conversation' };
  }
  const available = availableSources(legs);
  if (stored.driveDefault !== null && available.includes(stored.driveDefault)) {
    return { kind: 'source', source: stored.driveDefault, via: 'drive_default' };
  }
  if (stored.personalDefault !== null && available.includes(stored.personalDefault)) {
    return { kind: 'source', source: stored.personalDefault, via: 'personal_default' };
  }
  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// The decision (SPEND-1, SPEND-4, WAL-8)
// ---------------------------------------------------------------------------

/** SEAT-8: there is no free org tier, so an org-rooted wallet carries Business entitlement. */
export const ORG_ENTITLEMENT_TIER: SubscriptionTier = 'business';

export interface CallSpendInput extends CallSpendLegs {
  /** The source this turn already resolved, for a follow-on call; null for a turn's first call. */
  chosen: SpendSourceKind | null;
  /** What is stored for this conversation and person (SPEND-3); none when omitted. */
  stored?: StoredSpendChoice;
  userOverride: UserSpendOverride;
  reservationCents: number;
  /** The tier of the wallet's ROOT owner: the org for org drives, the drive owner for a personal drive (WAL-8, D-OW-14). */
  walletOwnerTier: SubscriptionTier;
  /** The caller's own tier, which governs their own credits (WAL-8). */
  consumerTier: SubscriptionTier;
}

export type CallSpendDecision =
  | {
      kind: 'spend';
      source: SpendSourceKind;
      walletId: string;
      fallbackApplied: boolean;
      fallbackFrom: SpendSourceKind | null;
      /** The tier whose entitlements (the pro-model gate) apply to this call (WAL-8). */
      entitlementTier: SubscriptionTier;
    }
  | { kind: 'refuse'; source: SpendSourceKind | null; reason: RefusalReason; options: SpendOption[]; chargeCents: 0 }
  | { kind: 'skip'; reason: SkipReason; walletId: string | null; chargeCents: 0 };

/**
 * The decision input for a person-less run (SPEND-6). The consumer is the drive, so the
 * input carries no personal leg and no seat at all: the shell never reads a person's
 * wallet for an automation, and the resolver could not reach one if it did. Nothing is
 * chosen, overridden, or fallen back to.
 */
export function automationSpendInput(input: {
  driveId: string;
  driveWallet: SpendLeg | null;
  /** The tier of the drive wallet's ROOT owner: the org for org drives, the drive owner otherwise (WAL-8). */
  walletOwnerTier: SubscriptionTier;
  reservationCents: number;
}): CallSpendInput {
  return {
    actor: { kind: 'automation', driveId: input.driveId },
    driveWallet: input.driveWallet,
    seatAllowance: null,
    personal: null,
    driveRule: { fallback: 'refuse', guestsMaySpendDriveWallet: false },
    chosen: null,
    userOverride: { alwaysOwnCredits: false, alwaysOwnCreditsInDrive: false },
    reservationCents: input.reservationCents,
    walletOwnerTier: input.walletOwnerTier,
    // Never consulted: an automation cannot spend own credits, the only source this tier governs.
    consumerTier: input.walletOwnerTier,
  };
}

/**
 * The walletId a personal leg carries before the person has a wallet row. The gate's own
 * personal path lazily creates the row (with the tier's grant) under its lock, exactly as
 * before wallets, so resolution never creates a bare one.
 */
export const PERSONAL_ROOT_NOT_YET_CREATED = 'personal-root:not-yet-created';

/**
 * Own credits, with no reads: the call named no drive (SPEND-8), or orgs are dark. The
 * gate's personal path finds (or lazily creates) the personal root wallet itself.
 */
export function personalRootDecision(consumerTier: SubscriptionTier): CallSpendDecision {
  return {
    kind: 'spend',
    source: 'own_credits',
    walletId: PERSONAL_ROOT_NOT_YET_CREATED,
    fallbackApplied: false,
    fallbackFrom: null,
    entitlementTier: consumerTier,
  };
}

/**
 * The one wallet this call spends, decided before it runs. Never a wallet the caller did
 * not name, except where the drive's rule allows a fallback, which the answer says
 * (`fallbackApplied`). An empty chosen source refuses and charges zero (SPEND-4).
 */
export function decideCallSpend(input: CallSpendInput): CallSpendDecision {
  // A stored choice is a PERSON's (SPEND-3): an automation has none to honour and spends its
  // drive wallet or skips (SPEND-6), whatever a conversation or a default says.
  const choice: ChosenSource = input.actor.kind === 'automation'
    ? { kind: 'none' }
    : chooseSource(input.chosen, input.stored ?? NO_STORED_CHOICE, input);
  const sourceInput = {
    actor: input.actor,
    driveWallet: input.driveWallet,
    seatAllowance: input.seatAllowance,
    personal: input.personal,
    chosen: null,
    driveRule: input.driveRule,
    userOverride: input.userOverride,
    reservationCents: input.reservationCents,
  };
  const overridden = input.userOverride.alwaysOwnCredits || input.userOverride.alwaysOwnCreditsInDrive;
  if (choice.kind === 'invalid' && !overridden) {
    // A stored choice that no longer resolves is refused by name, charges nothing, and takes
    // no fallback and no preselection: the person re-chooses from the options (SPEND-4).
    return { kind: 'refuse', source: null, reason: 'chosen_wallet_unavailable', options: coveredSpendOptions(sourceInput), chargeCents: 0 };
  }
  const resolution = resolveSpendSource({
    ...sourceInput,
    chosen: choice.kind === 'source' ? choice.source : preselectSoleSource(null, input),
  });
  if (resolution.kind !== 'spend') return resolution;
  return {
    kind: 'spend',
    source: resolution.source,
    walletId: resolution.walletId,
    fallbackApplied: resolution.fallbackApplied,
    fallbackFrom: resolution.fallbackFrom,
    entitlementTier: entitlementTierFor({
      source: resolution.source,
      walletOwnerTier: input.walletOwnerTier,
      consumerTier: input.consumerTier,
    }),
  };
}
