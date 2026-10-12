/**
 * wallet-views — what each viewer of a drive wallet is shown (Spec SPEND-9, SPEND-10, D-OW-5).
 *
 * PURE. The drive-wallet service loads every fact once; this module PICKS the fields each
 * viewer may see from them by an explicit allowlist per role, so a new fact added to the
 * input never reaches a consumer unless someone adds it here:
 *
 *   - member / guest (consumers, SPEND-9): the drive wallet's REMAINING amount and their own
 *     remaining cap. Never the org pool, never the funder's balance, never another consumer's
 *     spend. The remaining amount is the wallet's own budget and is not capped by the parent,
 *     so it cannot reveal how much the pool (or the lead's personal wallet) holds.
 *   - lead (SPEND-10): the wallet and spend by member and automation for their drive.
 *   - org_admin (SPEND-10): all of that plus the pool and its unallocated balance.
 *
 * Each amount a consumer sees also carries its credit count (`…Credits`), rendered by the
 * money model's one formatter (MON-5, UI-12: "1,200", no currency symbol). A client that
 * displays credits — the CLI, which never imports this library — prints that string and never
 * converts cents itself, so there is still exactly one credit conversion.
 */

import type { WalletViewer } from '../permissions/wallet-access';
import { formatCreditCount } from './money-model';
import { encodeAutomationRef, parseAutomationRef, ZOOM_TRANSCRIPTS_AUTOMATION_NAME, type AutomationRef } from './automation-attribution';
import { userConsumerKey, walletChainStatus, walletOwnRemainingCents, walletStatusFor, type FallbackRule, type OvershootFunderChoice, type SpendSourceKind, type WalletStatus } from './wallet-core';

export interface DriveWalletRowFacts {
  id: string;
  driveId: string;
  status: WalletStatus;
  monthlyAllowanceCents: number;
  spentCents: number;
  topupRemainingCents: number;
  debtCents: number;
  monthlyPeriodStart: Date | null;
  monthlyPeriodEnd: Date | null;
  fallbackRule: FallbackRule | null;
  donationsEnabled: boolean;
  defaultSpendSource: SpendSourceKind | null;
  /** WAL-6c: the funder's overshoot choice; null is the default (absorb into the parent). */
  overshootChoice: OvershootFunderChoice | null;
  /** D-OW-4: the drive opened its wallet to guests. */
  guestSpendEnabled: boolean;
  /** WAL-7: the parent's status (the org pool or the owner's wallet); a paused parent pauses this wallet. */
  parentStatus: WalletStatus | null;
}

/**
 * WAL-6e: the status a wallet SHOWS — the kill switch wins, and any debt it carries reads "over"
 * — derived from the row on every read, so it can never lag the debt (an overshoot raises debt
 * in the settle, a refill or top-up clears it; neither has to remember to restamp a status).
 */
export function displayedWalletStatus(w: { status: WalletStatus; debtCents: number; parentStatus?: WalletStatus | null }): WalletStatus {
  // WAL-7: a paused parent (the org pool's kill switch) pauses every wallet it funds, so it shows paused.
  const paused = walletChainStatus(w.status, w.parentStatus ?? null) === 'paused';
  return walletStatusFor({ paused, debtCents: w.debtCents });
}

/** The viewer's own cap on this wallet (WAL-7) and their spend in the current UTC windows. */
export interface ConsumerCapFacts {
  dailyCapCents: number | null;
  monthlyCapCents: number | null;
  spentTodayCents: number;
  spentThisMonthCents: number;
}

/**
 * One row of this period's spend on a wallet (SPEND-10):
 *   - member: a person's own spend, including what they triggered themselves (a manual Run, a
 *     channel mention — a person's action, SPEND-6); keyed `user:<id>`.
 *   - automation: what an automation spent with no person present (a workflow's cron or trigger, a
 *     Zoom connection's transcript enrichment), keyed `automation:<stored ref>`. It runs on behalf of
 *     its creator ([D-OW-34]) and counts toward their cap, but is listed as the automation so the lead
 *     sees it apart from the person.
 */
export type ConsumerSpend =
  | {
      kind: 'member';
      consumerKey: string;
      userId: string;
      /** The person's name, so the UI never resolves an id (null when unknown). */
      displayName: string | null;
      spentCents: number;
    }
  | {
      kind: 'automation';
      consumerKey: string;
      /** Which automation (automation-attribution's typed reference). */
      automation: AutomationRef;
      /** Its name: the workflow's (null once the workflow is deleted; its spend stays listed), or "Zoom transcripts". */
      displayName: string | null;
      /** Who it runs as now (the workflow's creator); null when unknown or deleted. */
      creatorUserId: string | null;
      creatorName: string | null;
      spentCents: number;
    };

/** A spend row as the lead and admins see it: the amount also as a credit count. */
export type ConsumerSpendView = ConsumerSpend & { spentCredits: string };

/** One ledger group of this period's usage on a wallet: who it is recorded as, and the stored automation reference (null: none). */
export interface ConsumerSpendGroup {
  userId: string;
  automationRef: string | null;
  spentCents: number;
}

/**
 * The workflows whose names the spend list needs, from the ledger's groups: the ONE place the list
 * reads stored automation references (automation-attribution's codec), with consumerSpendRows.
 */
export function workflowIdsToName(groups: readonly ConsumerSpendGroup[]): string[] {
  const ids = groups.flatMap((g) => {
    const ref = parseAutomationRef(g.automationRef);
    return ref?.kind === 'workflow' ? [ref.workflowId] : [];
  });
  return [...new Set(ids)];
}

/** The names the spend rows carry, loaded by the shell: people by id, workflows by id. */
export interface ConsumerSpendNames {
  people: ReadonlyMap<string, string>;
  automations: ReadonlyMap<string, { name: string; createdBy: string | null }>;
}

/** The key an automation's spend row is listed under (a person's is wallet-core `userConsumerKey`). */
export function automationConsumerKey(ref: AutomationRef): string {
  return `automation:${encodeAutomationRef(ref)}`;
}

/**
 * The lead's spend list (SPEND-10) from the ledger's groups: a person's own spend is one member row;
 * each automation is ONE row whoever it was recorded as this period (a workflow reassigned
 * mid-period, [D-OW-36], stays one automation), never folded into its creator's member row. Largest
 * first; a net refund below zero shows nothing spent.
 */
export function consumerSpendRows(groups: readonly ConsumerSpendGroup[], names: ConsumerSpendNames): ConsumerSpend[] {
  const rows = new Map<string, ConsumerSpend>();
  for (const g of groups) {
    const cents = whole(g.spentCents);
    // A reference this codec did not write is no automation: it stays the recorded person's spend.
    const automation = parseAutomationRef(g.automationRef);
    const key = automation === null ? userConsumerKey(g.userId) : automationConsumerKey(automation);
    const existing = rows.get(key);
    if (existing) {
      rows.set(key, { ...existing, spentCents: existing.spentCents + cents });
    } else if (automation === null) {
      rows.set(key, { kind: 'member', consumerKey: key, userId: g.userId, displayName: names.people.get(g.userId) ?? null, spentCents: cents });
    } else if (automation.kind === 'zoom') {
      // A Zoom connection's enrichment runs as the connection's owner: the person it is recorded under.
      rows.set(key, {
        kind: 'automation',
        consumerKey: key,
        automation,
        displayName: ZOOM_TRANSCRIPTS_AUTOMATION_NAME,
        creatorUserId: g.userId,
        creatorName: names.people.get(g.userId) ?? null,
        spentCents: cents,
      });
    } else {
      const workflow = names.automations.get(automation.workflowId);
      const creatorUserId = workflow?.createdBy ?? null;
      rows.set(key, {
        kind: 'automation',
        consumerKey: key,
        automation,
        displayName: workflow?.name ?? null,
        creatorUserId,
        creatorName: creatorUserId ? names.people.get(creatorUserId) ?? null : null,
        spentCents: cents,
      });
    }
  }
  return [...rows.values()]
    .map((r) => ({ ...r, spentCents: Math.max(0, r.spentCents) }))
    .sort((a, b) => b.spentCents - a.spentCents || a.consumerKey.localeCompare(b.consumerKey));
}

export interface PoolFacts {
  walletId: string;
  /** The pool's own available cents (monthly + top-up − debt − holds). */
  availableCents: number;
  /** What the pool's child wallets may still draw this period: Σ max(0, allocation − spent). */
  outstandingChildAllocationsCents: number;
}

export interface DriveWalletFacts {
  wallet: DriveWalletRowFacts;
  /** Null when no cap row exists for the viewer (unlimited within the wallet). */
  myCap: ConsumerCapFacts | null;
  spendByConsumer: ConsumerSpend[];
  /** The org pool behind an org drive's wallet; null on a personal drive. */
  pool: PoolFacts | null;
}

const whole = (cents: number): number => (Number.isFinite(cents) ? Math.round(cents) : 0);

/** The wallet's own remaining budget: allocation left + top-ups − debt, never below zero. */
export function walletRemainingCents(wallet: Pick<DriveWalletRowFacts, 'monthlyAllowanceCents' | 'spentCents' | 'topupRemainingCents' | 'debtCents'>): number {
  return walletOwnRemainingCents({
    allocationCents: whole(wallet.monthlyAllowanceCents),
    allocationSpentCents: whole(wallet.spentCents),
    topupLegs: [{ legId: 'topup', funder: 'owner', donorUserId: null, remainingCents: whole(wallet.topupRemainingCents) }],
    debtCents: whole(wallet.debtCents),
  });
}

export interface CapRemaining {
  /** Null = no daily cap (unlimited within the wallet). */
  dailyRemainingCents: number | null;
  monthlyRemainingCents: number | null;
  /** The same amounts as credit counts (money-model `formatCreditCount`); null = no cap. */
  dailyRemainingCredits: string | null;
  monthlyRemainingCredits: string | null;
}

/** An amount as the money model renders it, or null for no amount. */
export function creditsOf(cents: number | null): string | null {
  return cents === null ? null : formatCreditCount(cents);
}

export function capRemainingCents(cap: ConsumerCapFacts | null): CapRemaining {
  if (cap === null) return { dailyRemainingCents: null, monthlyRemainingCents: null, dailyRemainingCredits: null, monthlyRemainingCredits: null };
  const left = (capCents: number | null, spent: number): number | null =>
    capCents === null ? null : Math.max(0, whole(capCents) - Math.max(0, whole(spent)));
  const daily = left(cap.dailyCapCents, cap.spentTodayCents);
  const monthly = left(cap.monthlyCapCents, cap.spentThisMonthCents);
  return { dailyRemainingCents: daily, monthlyRemainingCents: monthly, dailyRemainingCredits: creditsOf(daily), monthlyRemainingCredits: creditsOf(monthly) };
}

/** The pool's balance not yet promised to a child wallet this period. May be negative (over-allocated). */
export function poolUnallocatedCents(pool: PoolFacts): number {
  return whole(pool.availableCents) - Math.max(0, whole(pool.outstandingChildAllocationsCents));
}

/** The consumer allowlist (SPEND-9). A test pins that a consumer view has exactly these keys. */
export const CONSUMER_WALLET_FIELDS = [
  'viewer',
  'walletId',
  'driveId',
  'status',
  'remainingCents',
  'remainingCredits',
  'myCap',
  'donationsEnabled',
  'defaultSpendSource',
] as const;

export interface ConsumerWalletView {
  viewer: 'member' | 'guest';
  walletId: string;
  driveId: string;
  status: WalletStatus;
  remainingCents: number;
  /** `remainingCents` as a credit count ("1,200"), from the money model. */
  remainingCredits: string;
  myCap: CapRemaining;
  donationsEnabled: boolean;
  /** The drive's default source (SPEND-3): what a new conversation here preselects. */
  defaultSpendSource: SpendSourceKind | null;
}

export interface LeadWalletView extends Omit<ConsumerWalletView, 'viewer'> {
  viewer: 'lead';
  allocationCents: number;
  spentCents: number;
  topupRemainingCents: number;
  debtCents: number;
  periodStart: string | null;
  periodEnd: string | null;
  fallbackRule: FallbackRule | null;
  /** WAL-6c: where this wallet's overshoot lands; null is the default (absorb into the parent). */
  overshootChoice: OvershootFunderChoice | null;
  /** D-OW-4: whether the drive's guests may spend this wallet (always within their caps). */
  guestSpendEnabled: boolean;
  /** The amounts above as credit counts, so the client never converts (money model). */
  allocationCredits: string;
  spentCredits: string;
  topupRemainingCredits: string;
  debtCredits: string;
  spendByConsumer: ConsumerSpendView[];
}

export interface OrgAdminWalletView extends Omit<LeadWalletView, 'viewer'> {
  viewer: 'org_admin';
  pool: { walletId: string; availableCents: number; unallocatedCents: number; availableCredits: string; unallocatedCredits: string } | null;
}

export type DriveWalletView = ConsumerWalletView | LeadWalletView | OrgAdminWalletView;

function consumerFields(facts: DriveWalletFacts): Omit<ConsumerWalletView, 'viewer'> {
  const w = facts.wallet;
  return {
    walletId: w.id,
    driveId: w.driveId,
    status: displayedWalletStatus(w),
    remainingCents: walletRemainingCents(w),
    remainingCredits: formatCreditCount(walletRemainingCents(w)),
    myCap: capRemainingCents(facts.myCap),
    donationsEnabled: w.donationsEnabled,
    defaultSpendSource: w.defaultSpendSource,
  };
}

function leadFields(facts: DriveWalletFacts): Omit<LeadWalletView, 'viewer'> {
  const w = facts.wallet;
  return {
    ...consumerFields(facts),
    allocationCents: whole(w.monthlyAllowanceCents),
    spentCents: whole(w.spentCents),
    topupRemainingCents: whole(w.topupRemainingCents),
    debtCents: whole(w.debtCents),
    periodStart: w.monthlyPeriodStart?.toISOString() ?? null,
    periodEnd: w.monthlyPeriodEnd?.toISOString() ?? null,
    fallbackRule: w.fallbackRule,
    overshootChoice: w.overshootChoice,
    guestSpendEnabled: w.guestSpendEnabled,
    allocationCredits: formatCreditCount(whole(w.monthlyAllowanceCents)),
    spentCredits: formatCreditCount(whole(w.spentCents)),
    topupRemainingCredits: formatCreditCount(whole(w.topupRemainingCents)),
    debtCredits: formatCreditCount(whole(w.debtCents)),
    spendByConsumer: facts.spendByConsumer.map((s): ConsumerSpendView => ({
      ...s,
      spentCents: whole(s.spentCents),
      spentCredits: formatCreditCount(whole(s.spentCents)),
    })),
  };
}

/** The projection `viewer` may see. A non-member has none: the caller answers 404 before asking. */
export function projectDriveWallet(viewer: WalletViewer, facts: DriveWalletFacts): DriveWalletView {
  switch (viewer) {
    case 'member':
    case 'guest':
      return { viewer, ...consumerFields(facts) };
    case 'lead':
      return { viewer, ...leadFields(facts) };
    case 'org_admin':
      return {
        viewer,
        ...leadFields(facts),
        pool: facts.pool
          ? {
              walletId: facts.pool.walletId,
              availableCents: whole(facts.pool.availableCents),
              unallocatedCents: poolUnallocatedCents(facts.pool),
              availableCredits: formatCreditCount(whole(facts.pool.availableCents)),
              unallocatedCredits: formatCreditCount(poolUnallocatedCents(facts.pool)),
            }
          : null,
      };
    case 'none':
      throw new Error('projectDriveWallet: a viewer with no access to the drive has no wallet view');
  }
}
