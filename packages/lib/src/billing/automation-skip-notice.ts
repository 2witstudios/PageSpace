/**
 * automation-skip-notice — when the drive lead is told that an automation was skipped
 * because its drive wallet could not cover it (SPEND-6): once per period, so a lead learns
 * their automations stopped without being told again on every fire.
 *
 * INVARIANT: zero I/O. The clock is passed in, read from the database in UTC by the shell
 * (automation-skip-notifier.ts), which enforces the same rule atomically in its upsert.
 */

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
