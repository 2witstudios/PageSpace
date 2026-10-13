/**
 * automation-skip-notice — when the drive lead is told that an automation was skipped
 * because its drive wallet could not cover it (SPEND-6): once per period, so a lead learns
 * their automations stopped without being told again on every fire.
 *
 * INVARIANT: zero I/O. The clock is passed in, read from the database in UTC by the shell
 * (automation-skip-notifier.ts), which enforces the same rule atomically in its upsert.
 */

import type { SkipReason } from './wallet-core';

/**
 * What the lead is told for a skip (SPEND-6 "logs why"): an empty or missing wallet, a paused one,
 * a person's spent cap, or a guest the drive keeps off its wallet — each named, so a lead whose
 * automations stopped knows what to change.
 */
export function automationSkipNoticeMessage(reason: SkipReason): string {
  switch (reason) {
    case 'no_drive_wallet':
      return 'An automation in this drive was skipped because the drive has no wallet to pay for it. Automations spend only the drive wallet.';
    case 'drive_wallet_paused':
      return 'An automation in this drive was skipped because the drive wallet is paused.';
    case 'source_cap_reached':
      return 'An automation in this drive was skipped because the person it runs as reached their spending cap on the drive wallet.';
    case 'guest_drive_wallet_off':
      return 'An automation in this drive was skipped because it was started by a guest, and this drive does not let guests spend its wallet.';
    case 'creator_departed':
      return 'An automation in this drive was skipped because the person it runs as is no longer a member.';
    case 'drive_wallet_empty':
      return 'An automation in this drive was skipped because the drive wallet cannot cover it. Add credits to the drive wallet to resume.';
  }
}

/**
 * The start of the period a skip falls in: the drive wallet's current period when it has
 * one that has begun, otherwise the UTC calendar month of `now`. Always UTC — never the
 * server's or the database session's time zone.
 */
export function skipNoticePeriodStart(input: { now: Date; walletPeriodStart: Date | null }): Date {
  const { now, walletPeriodStart } = input;
  if (walletPeriodStart !== null && walletPeriodStart.getTime() <= now.getTime()) return walletPeriodStart;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Notify when the lead has not been told since this period began. */
export function shouldNotifyLeadOfSkip(input: { lastNotifiedAt: Date | null; periodStart: Date }): boolean {
  return input.lastNotifiedAt === null || input.lastNotifiedAt.getTime() < input.periodStart.getTime();
}
