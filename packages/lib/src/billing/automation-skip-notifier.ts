/**
 * automation-skip-notifier — the imperative shell that tells a drive's lead an automation
 * was skipped for want of drive-wallet funds (SPEND-6), at most once per period.
 *
 * The rule is automation-skip-notice's `shouldNotifyLeadOfSkip`, enforced atomically: one
 * conditional upsert on automation_skip_notices claims the period (a concurrent skip of the
 * same drive loses the claim), and the notification row is written in the same transaction,
 * so a claimed period always carries its notice. The stamp is `(now() at time zone 'utc')`
 * into a timestamp-without-time-zone column, and the period start is bound as a UTC instant,
 * so the boundary never follows the database session's time zone.
 *
 * In-app notification row only: no email, no push, no realtime fan-out (surfaces are Wave F).
 */

import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';
import { notifications } from '@pagespace/db/schema/notifications';
import { automationSkipNotices } from '@pagespace/db/schema/wallets';
import { skipNoticePeriodStart } from './automation-skip-notice';
import type { SkipReason } from './wallet-core';

export interface AutomationSkipNoticeInput {
  driveId: string;
  /** The drive's lead, who is told. */
  leadUserId: string;
  /** The drive wallet that could not cover the run; null when the drive has none. */
  walletId: string | null;
  /** The drive wallet's current period start, which governs the notice period when it has begun. */
  walletPeriodStart: Date | null;
  reason: SkipReason;
  now?: Date;
}

const UTC_NOW = sql`(now() at time zone 'utc')`;

/** Tell the lead, unless they were already told this period. Returns whether a notice was written. */
export async function notifyLeadOfAutomationSkip(input: AutomationSkipNoticeInput): Promise<boolean> {
  const periodStart = skipNoticePeriodStart({ now: input.now ?? new Date(), walletPeriodStart: input.walletPeriodStart });

  return db.transaction(async (tx) => {
    const claimed = await tx
      .insert(automationSkipNotices)
      .values({ driveId: input.driveId, lastNotifiedAt: UTC_NOW })
      .onConflictDoUpdate({
        target: automationSkipNotices.driveId,
        set: { lastNotifiedAt: UTC_NOW },
        // shouldNotifyLeadOfSkip: only when the last notice predates this period.
        setWhere: sql`${automationSkipNotices.lastNotifiedAt} < (${periodStart.toISOString()}::timestamptz at time zone 'utc')`,
      })
      .returning({ driveId: automationSkipNotices.driveId });
    if (claimed.length === 0) return false;

    await tx.insert(notifications).values({
      userId: input.leadUserId,
      type: 'AUTOMATION_SKIPPED',
      title: 'An automation was skipped',
      message: input.walletId === null
        ? 'An automation in this drive was skipped because the drive has no wallet to pay for it. Automations spend only the drive wallet.'
        : 'An automation in this drive was skipped because the drive wallet cannot cover it. Add credits to the drive wallet to resume.',
      driveId: input.driveId,
      metadata: { walletId: input.walletId, reason: input.reason },
    });
    return true;
  });
}
