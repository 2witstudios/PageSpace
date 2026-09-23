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
import type { FallbackRule, SpendSourceKind, WalletStatus } from './wallet-core';

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
  spentCents: number;
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
  spendByConsumer: ConsumerSpend[];
}

export interface OrgAdminWalletView extends Omit<LeadWalletView, 'viewer'> {
  viewer: 'org_admin';
  pool: { walletId: string; availableCents: number; unallocatedCents: number } | null;
}

export type DriveWalletView = ConsumerWalletView | LeadWalletView | OrgAdminWalletView;

function consumerFields(facts: DriveWalletFacts): Omit<ConsumerWalletView, 'viewer'> {
  const w = facts.wallet;
  return {
    walletId: w.id,
    driveId: w.driveId,
    status: w.status,
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
    spendByConsumer: facts.spendByConsumer.map((s) => ({ consumerKey: s.consumerKey, userId: s.userId, spentCents: whole(s.spentCents) })),
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
          ? { walletId: facts.pool.walletId, availableCents: whole(facts.pool.availableCents), unallocatedCents: poolUnallocatedCents(facts.pool) }
          : null,
      };
    case 'none':
      throw new Error('projectDriveWallet: a viewer with no access to the drive has no wallet view');
  }
}
