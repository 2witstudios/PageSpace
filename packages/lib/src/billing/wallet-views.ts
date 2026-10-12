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
import type { AIUsageSource } from '../monitoring/usage-source';
import { walletStatusFor, type FallbackRule, type OvershootFunderChoice, type SpendSourceKind, type WalletStatus } from './wallet-core';

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
}

/**
 * WAL-6e: the status a wallet SHOWS — the kill switch wins, and any debt it carries reads "over"
 * — derived from the row on every read, so it can never lag the debt (an overshoot raises debt
 * in the settle, a refill or top-up clears it; neither has to remember to restamp a status).
 */
export function displayedWalletStatus(w: { status: WalletStatus; debtCents: number }): WalletStatus {
  return walletStatusFor({ paused: w.status === 'paused', debtCents: w.debtCents });
}

/** The viewer's own cap on this wallet (WAL-7) and their spend in the current UTC windows. */
export interface ConsumerCapFacts {
  dailyCapCents: number | null;
  monthlyCapCents: number | null;
  spentTodayCents: number;
  spentThisMonthCents: number;
}

export interface ConsumerSpend {
  /** `user:<id>` for a person, `drive:<id>` for the drive's automations (SPEND-6). */
  consumerKey: string;
  userId: string | null;
  /** The person's name, so the UI never resolves an id (null when unknown). */
  displayName: string | null;
  /** Spent this period. */
  spentCents: number;
  /** Of that, spent since the start of today (UTC, the cap window, WAL-7). */
  spentTodayCents: number;
  /** Of that, spent by automations run on this person's behalf ([D-OW-34]: workflows and triggers). */
  viaAutomationsCents: number;
}

/** A spend-by-member row as the lead and admins see it: the amounts also as credit counts. */
export interface ConsumerSpendView extends ConsumerSpend {
  spentCredits: string;
  spentTodayCredits: string;
  viaAutomationsCredits: string;
}

/**
 * The usage source automations record (monitoring/usage-source): the workflow executor stamps every
 * scheduled, triggered and manually run workflow call `workflow`. "Via automations" is spend whose
 * usage log carries it; compute and other spend with no usage log is never counted as automation.
 */
export const AUTOMATION_USAGE_SOURCE: AIUsageSource = 'workflow';

/**
 * One aggregate of a wallet's usage rows this period: a person's spend in one bucket of (since the
 * start of today?, by an automation?). The service groups the ledger this way; this folds it.
 */
export interface ConsumerSpendBucket {
  userId: string;
  cents: number;
  today: boolean;
  viaAutomation: boolean;
}

/**
 * Who spends from a wallet (UI-9, SPEND-10): one row per person with this period's spend, the part
 * spent today and the part spent via automations, by spend then person. Never negative (a refund
 * bucket nets out, it does not show as income). Names come from `names`; unknown is null, never an id.
 */
export function consumerSpendFromBuckets(buckets: readonly ConsumerSpendBucket[], names: ReadonlyMap<string, string>): ConsumerSpend[] {
  const byUser = new Map<string, { spent: number; today: number; automation: number }>();
  for (const b of buckets) {
    const acc = byUser.get(b.userId) ?? { spent: 0, today: 0, automation: 0 };
    const cents = whole(b.cents);
    acc.spent += cents;
    if (b.today) acc.today += cents;
    if (b.viaAutomation) acc.automation += cents;
    byUser.set(b.userId, acc);
  }
  return [...byUser.entries()]
    .map(([userId, acc]) => ({
      consumerKey: `user:${userId}`,
      userId,
      displayName: names.get(userId) ?? null,
      spentCents: Math.max(0, acc.spent),
      spentTodayCents: Math.max(0, acc.today),
      viaAutomationsCents: Math.max(0, acc.automation),
    }))
    .sort((a, b) => b.spentCents - a.spentCents || a.consumerKey.localeCompare(b.consumerKey));
}

/** A drive wallet I spend from, as Settings › Usage › Wallets lists it (UI-10). */
export interface DriveWalletListEntry {
  driveId: string;
  driveName: string | null;
  walletId: string;
  status: WalletStatus;
  remainingCents: number;
  remainingCredits: string;
  /** What I spent from it this period: my own spend only (SPEND-9). */
  mySpentCents: number;
  mySpentCredits: string;
}

/**
 * One drive wallet in my list (UI-10): what is left (the consumer amount, SPEND-9) and what I spent
 * from it this period. Picks fields explicitly, so the wallet's allocation, its total spend and
 * other people's spend never reach the list.
 */
export function driveWalletListEntry(
  row: { id: string; subjectId: string; status: WalletStatus; monthlyAllowanceCents: number; spentCents: number; topupRemainingCents: number; debtCents: number },
  driveName: string | null,
  mySpentCents: number,
): DriveWalletListEntry {
  const remaining = walletRemainingCents(row);
  const mine = Math.max(0, whole(mySpentCents));
  return {
    driveId: row.subjectId,
    driveName,
    walletId: row.id,
    status: displayedWalletStatus(row),
    remainingCents: remaining,
    remainingCredits: formatCreditCount(remaining),
    mySpentCents: mine,
    mySpentCredits: formatCreditCount(mine),
  };
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
  const allocationLeft = Math.max(0, whole(wallet.monthlyAllowanceCents) - whole(wallet.spentCents));
  return Math.max(0, allocationLeft + Math.max(0, whole(wallet.topupRemainingCents)) - Math.max(0, whole(wallet.debtCents)));
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
    allocationCredits: formatCreditCount(whole(w.monthlyAllowanceCents)),
    spentCredits: formatCreditCount(whole(w.spentCents)),
    topupRemainingCredits: formatCreditCount(whole(w.topupRemainingCents)),
    debtCredits: formatCreditCount(whole(w.debtCents)),
    spendByConsumer: facts.spendByConsumer.map((s) => ({
      consumerKey: s.consumerKey,
      userId: s.userId,
      displayName: s.displayName,
      spentCents: whole(s.spentCents),
      spentTodayCents: whole(s.spentTodayCents),
      viaAutomationsCents: whole(s.viaAutomationsCents),
      spentCredits: formatCreditCount(whole(s.spentCents)),
      spentTodayCredits: formatCreditCount(whole(s.spentTodayCents)),
      viaAutomationsCredits: formatCreditCount(whole(s.viaAutomationsCents)),
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
