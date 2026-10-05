/**
 * wallet-surface — what Drive Settings › Wallet and Settings › Usage › Wallets show (Spec UI-9,
 * UI-10, SPEND-9, SPEND-10, WAL-4, WAL-7; canvas v9 DriveWallet, UsageWallets, WalletStates).
 *
 * The routes already answer each viewer's projection (wallet-views) and the actions they may
 * take (wallet-access); this module only decides which panels render from those two answers.
 * A panel that shows someone else's spend, the pool or the allocation opens only when the
 * PROJECTION carries that data, so a member's page cannot render it whatever the action list
 * says (SPEND-9).
 *
 * PURE and client-safe.
 */
import { centsFromCredits } from './money-model';
import type { WalletAction, WalletViewer } from '../permissions/wallet-access';
import type { WalletStatus } from './wallet-core';
import type { DriveWalletView } from './wallet-views';

export interface DriveWalletPanels {
  /** No wallet yet, and the viewer may create one. */
  create: boolean;
  /** The remaining amount and status (every viewer of an existing wallet). */
  balance: boolean;
  /** The viewer's own remaining cap. */
  myCap: boolean;
  /** Allocation, spend and period (the lead and org admins). */
  allocation: boolean;
  editAllocation: boolean;
  topUp: boolean;
  /** The kill switch. */
  pause: boolean;
  /** Default source, fallback rule, donations on/off. */
  rules: boolean;
  editRules: boolean;
  /** Per-member caps (WAL-7). */
  caps: boolean;
  editCaps: boolean;
  /** Spend this month by member (SPEND-10). */
  spendByMember: boolean;
  /** The org pool and its unallocated balance (org admins). */
  pool: boolean;
  /** WAL-4: anyone who can see the drive, while it accepts donations. */
  donate: boolean;
}

export function driveWalletPanels(read: { viewer: Exclude<WalletViewer, 'none'>; actions: readonly WalletAction[]; wallet: DriveWalletView | null }): DriveWalletPanels {
  const may = (action: WalletAction) => read.actions.includes(action);
  const w = read.wallet;
  const funderView = w !== null && 'allocationCents' in w;
  const spendView = w !== null && 'spendByConsumer' in w;
  return {
    create: w === null && may('create'),
    balance: w !== null,
    myCap: w !== null,
    allocation: funderView,
    editAllocation: funderView && may('allocate'),
    topUp: funderView && may('top_up'),
    pause: funderView && may('pause'),
    rules: funderView,
    editRules: funderView && may('set_rules'),
    caps: spendView && (may('set_caps') || may('view_spend_by_member')),
    editCaps: spendView && may('set_caps'),
    spendByMember: spendView,
    pool: w !== null && w.viewer === 'org_admin' && w.pool !== null,
    donate: w !== null && w.donationsEnabled && may('donate'),
  };
}

const STATUS_COPY: Record<WalletStatus, { label: string; hint: string }> = {
  active: { label: 'Active', hint: 'Has credits left this month. Calls spend from it.' },
  over: { label: 'Over', hint: "This month's allocation is spent. Calls follow the fallback rule." },
  paused: { label: 'Paused', hint: 'Stopped by whoever funds it. Nothing spends from it until it is resumed, even with credits left.' },
};

/** A wallet status's badge label and its meaning (WalletStates). */
export function walletStatusCopy(status: WalletStatus): { label: string; hint: string } {
  return STATUS_COPY[status];
}

/**
 * A credit count typed by a person, as whole cents through the money model (UI-12: credits are
 * counts, never "$"). Thousands separators are allowed; a fraction, a sign or a currency is not.
 */
export function parseCreditInput(text: string, options: { min?: number } = {}): { ok: true; cents: number } | { ok: false } {
  const cleaned = text.trim().replace(/,/g, '');
  if (!/^\d+$/.test(cleaned)) return { ok: false };
  const credits = Number(cleaned);
  if (!Number.isSafeInteger(credits) || credits < (options.min ?? 0)) return { ok: false };
  return { ok: true, cents: centsFromCredits(credits) };
}

const day = (date: Date): string => date.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The allocation period as the wallet resets it (UTC): "Sep 1 – Sep 30" and "resets Oct 1". */
export function walletPeriodCopy(start: string | null, end: string | null): { range: string | null; resets: string | null } {
  if (!start || !end) return { range: null, resets: null };
  const endDate = new Date(end);
  const lastDay = new Date(endDate.getTime() - 1);
  return { range: `${day(new Date(start))} – ${day(lastDay)}`, resets: `resets ${day(endDate)}` };
}

/** Who funds a drive wallet: its org, or the drive's owner's own credits. */
export function fundedByCopy(input: { orgName: string | null; viewerIsFunder: boolean }): string {
  if (input.orgName) return `Funded by ${input.orgName}`;
  return input.viewerIsFunder ? 'Funded from your credits' : "Funded by the drive's owner";
}

/** The share of the month's allocation spent, 0–100. */
export function spendMeterPercent(spentCents: number, allocationCents: number): number {
  if (allocationCents <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((spentCents / allocationCents) * 100)));
}

/** A spend-by-member row's name: the person, or the drive's own automations (spend recorded before D-OW-34). */
export function spendRowLabel(row: { consumerKey: string; displayName: string | null }): string {
  if (row.consumerKey.startsWith('drive:')) return 'Automations';
  return row.displayName ?? 'Former member';
}

/** A drive wallet's line in "You spend from" (UI-10): whose it is, and what an over or paused wallet does to your calls. */
export function spendFromRowCopy(input: { status: WalletStatus; orgName: string | null }): string {
  const owner = input.orgName ?? 'Shared drive';
  if (input.status === 'over') return `${owner} · over budget, your calls follow the drive's fallback rule`;
  if (input.status === 'paused') return `${owner} · paused by whoever funds it, your calls move to the next source`;
  return owner;
}
