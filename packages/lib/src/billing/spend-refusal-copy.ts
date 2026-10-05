/**
 * spend-refusal-copy — the ONE mapping from the gate's refusal and skip reasons to what a person
 * reads (Spec SPEND-4, SPEND-6, WAL-7, UI-8; D-OW-39). API error codes have their own table
 * (apps/web org-error-copy); this one covers only where the gate's reason itself is delivered:
 * the chat refusal card, the composer and chip, and an automation run's skip record.
 *
 * The tables are exhaustive Records over RefusalReason and SkipReason, so a new reason fails to
 * compile until it has copy. A reason that reaches a client the tables do not know (an older
 * client, a newer server) reads as a generic refusal, never as nothing.
 *
 * D-OW-39: no "Ask for budget" and no "the lead has been told". The card says what happened,
 * that nothing was charged, and who controls the budget; funders already get the 80%/100% alerts.
 * Credit amounts go through the money model's formatter only (UI-12: never a "$").
 *
 * PURE: no IO, no clock (the caller passes `now`, read in UTC like every wallet period).
 */
import { formatCreditCount } from './money-model';
import type { CapWindow, RefusalReason, SkipReason, SpendSourceKind } from './wallet-core';

/** Keyed by the union, so a reason added to wallet-core fails to compile here until it is listed. */
const REFUSAL_REASON_KEYS: Record<RefusalReason, true> = {
  no_source_chosen: true,
  source_empty: true,
  source_paused: true,
  source_unavailable: true,
  guest_drive_wallet_off: true,
  source_cap_reached: true,
  chosen_wallet_unavailable: true,
};
const SKIP_REASON_KEYS: Record<SkipReason, true> = {
  drive_wallet_empty: true,
  drive_wallet_paused: true,
  no_drive_wallet: true,
  creator_departed: true,
};

export const REFUSAL_REASONS = Object.keys(REFUSAL_REASON_KEYS) as RefusalReason[];
export const SKIP_REASONS = Object.keys(SKIP_REASON_KEYS) as SkipReason[];

/** The source a refusal names, as the person's own options list labels it. */
export interface RefusedSource {
  source: SpendSourceKind;
  /** spendChoiceLabel: "Product wallet", "Northwind Labs seat", "Your credits". */
  label: string;
  /** The drive's org, or null for a personal drive (whose owner controls its wallet). */
  orgName: string | null;
}

export interface RefusalCopyInput {
  /** The gate's reason as it crossed the wire. */
  reason: string;
  /** The refused source; null when none was chosen or the chosen one is gone. */
  source: RefusedSource | null;
  /** For source_cap_reached: which window ran out and, when the viewer may know it, the cap. */
  cap?: { window: CapWindow | null; capCents: number | null };
  /** Whether the card offers other sources to send from. */
  hasOptions: boolean;
  now: Date;
}

export interface RefusalCopy {
  title: string;
  body: string;
}

const NOTHING_CHARGED = 'Nothing was charged.';
const ANOTHER_SOURCE = 'You can send this message from another source.';

const monthName = (date: Date): string => date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
const nextMonthFirst = (now: Date): string => `${monthName(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)))} 1`;

const whoControls = (source: RefusedSource | null): string =>
  source?.orgName ? `The ${source.orgName} Owner and Admins control this budget.` : "The drive's owner controls this budget.";

const whoSetsCaps = (source: RefusedSource | null): string => {
  if (source?.source === 'seat_allowance') return `The ${source.orgName ?? 'organization'} Owner and Admins set seat allowances.`;
  return source?.orgName ? `The ${source.orgName} Owner and Admins set caps on this wallet.` : "The drive's owner sets caps on this wallet.";
};

const nameOf = (source: RefusedSource | null): string => source?.label ?? 'This source';

function capCopy(input: RefusalCopyInput): RefusalCopy {
  const { source, now } = input;
  if (source?.source === 'seat_allowance') {
    return {
      title: `You've used your ${source.orgName ?? 'organization'} seat allowance for ${monthName(now)}`,
      body: [`It refills on ${nextMonthFirst(now)}.`, NOTHING_CHARGED, whoSetsCaps(source)].join(' '),
    };
  }
  const window = input.cap?.window ?? null;
  const resets = window === 'daily' ? 'tomorrow' : window === 'monthly' ? `on ${nextMonthFirst(now)}` : 'soon';
  const amount = window && input.cap?.capCents != null
    ? `is ${formatCreditCount(input.cap.capCents)} credits a ${window === 'daily' ? 'day' : 'month'} and resets`
    : 'resets';
  return {
    title: window ? `You've reached your ${window} cap on ${nameOf(source)}` : `You've reached your cap on ${nameOf(source)}`,
    body: [`Your cap here ${amount} ${resets}.`, NOTHING_CHARGED, whoSetsCaps(source)].join(' '),
  };
}

const REFUSAL_COPY: Record<RefusalReason, (input: RefusalCopyInput) => RefusalCopy> = {
  no_source_chosen: () => ({
    title: 'Choose what to spend from',
    body: `This drive has more than one source and none is chosen for this conversation. ${NOTHING_CHARGED}`,
  }),
  source_empty: ({ source, now }) => ({
    title: `${nameOf(source)} is empty for ${monthName(now)}`,
    body: `This month's credits on ${nameOf(source)} have been spent. ${NOTHING_CHARGED} ${whoControls(source)}`,
  }),
  source_paused: ({ source }) => ({
    title: `${nameOf(source)} is paused`,
    body: `Whoever funds it has stopped spending from it, even with credits left. ${NOTHING_CHARGED} ${whoControls(source)}`,
  }),
  source_unavailable: ({ source }) => ({
    title: `${nameOf(source)} can't be used right now`,
    body: `${NOTHING_CHARGED} ${whoControls(source)}`,
  }),
  guest_drive_wallet_off: ({ source }) => ({
    title: `Guests can't spend from ${nameOf(source)}`,
    body: `This drive's wallet is for ${source?.orgName ? `${source.orgName} members` : 'its members'}. ${NOTHING_CHARGED}`,
  }),
  source_cap_reached: capCopy,
  chosen_wallet_unavailable: () => ({
    title: 'The source chosen for this conversation is no longer available',
    body: `It may have been removed, or you may no longer be able to spend from it here. ${NOTHING_CHARGED}`,
  }),
};

const isRefusalReason = (reason: string): reason is RefusalReason => Object.prototype.hasOwnProperty.call(REFUSAL_COPY, reason);

/** The refusal card's title and body for the gate's `reason` (SPEND-4: names the source, charges nothing). */
export function spendRefusalCopy(input: RefusalCopyInput): RefusalCopy {
  const copy = isRefusalReason(input.reason)
    ? REFUSAL_COPY[input.reason](input)
    : { title: `${nameOf(input.source)} can't cover this message`, body: NOTHING_CHARGED };
  return input.hasOptions ? { title: copy.title, body: `${copy.body} ${ANOTHER_SOURCE}` } : copy;
}

/** Which cap window ran out, from the viewer's own remaining cap (wallet-views CapRemaining); daily first. */
export function refusedCapWindow(cap: { dailyRemainingCents: number | null; monthlyRemainingCents: number | null } | null): CapWindow | null {
  if (!cap) return null;
  if (cap.dailyRemainingCents !== null && cap.dailyRemainingCents <= 0) return 'daily';
  if (cap.monthlyRemainingCents !== null && cap.monthlyRemainingCents <= 0) return 'monthly';
  return null;
}

// ---------------------------------------------------------------------------
// Automation runs (SPEND-6, D-OW-34)
// ---------------------------------------------------------------------------

export interface SkipCopyInput {
  /** The skip (or refusal) reason a run recorded. */
  reason: string;
  walletLabel: string | null;
  /** The person the automation runs as: its creator (D-OW-34). */
  creatorName: string | null;
  orgName: string | null;
}

const wallet = (input: SkipCopyInput): string => input.walletLabel ?? 'the drive wallet';
const creator = (input: SkipCopyInput): string => input.creatorName ?? 'its creator';

const SKIP_COPY: Record<SkipReason, (input: SkipCopyInput) => string> = {
  drive_wallet_empty: (i) => `${wallet(i)} was empty.`,
  drive_wallet_paused: (i) => `${wallet(i)} is paused.`,
  no_drive_wallet: () => 'this drive has no wallet to run automations from.',
  creator_departed: (i) => `${creator(i)} is no longer in ${i.orgName ?? 'this drive'}, so nothing runs as them.`,
};

/** A run refused at its creator's leg reads as the creator's (D-OW-34: it spends as them). */
const RUN_REFUSAL_COPY: Record<RefusalReason, (input: SkipCopyInput) => string> = {
  no_source_chosen: () => 'no source could pay for this run.',
  source_empty: (i) => `${wallet(i)} was empty.`,
  source_paused: (i) => `${wallet(i)} is paused.`,
  source_unavailable: (i) => `${wallet(i)} couldn't be used.`,
  guest_drive_wallet_off: (i) => `${creator(i)} is a guest and can't spend from ${wallet(i)}.`,
  source_cap_reached: (i) => `${creator(i)} reached their cap on ${wallet(i)}.`,
  chosen_wallet_unavailable: () => 'no source could pay for this run.',
};

const isSkipReason = (reason: string): reason is SkipReason => Object.prototype.hasOwnProperty.call(SKIP_COPY, reason);

/** One line for a skipped run: "Skipped: <why>." */
export function automationSkipCopy(input: SkipCopyInput): string {
  const why = isSkipReason(input.reason)
    ? SKIP_COPY[input.reason](input)
    : isRefusalReason(input.reason)
      ? RUN_REFUSAL_COPY[input.reason](input)
      : 'no source could pay for this run.';
  return `Skipped: ${why}`;
}
