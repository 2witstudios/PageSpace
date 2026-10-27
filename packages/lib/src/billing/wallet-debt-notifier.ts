/**
 * wallet-debt-notifier — the imperative shell that tells a wallet's FUNDER it is in debt
 * (Spec WAL-6e), at most once per period of the debt-carrying wallet.
 *
 * Who is told is wallet-core's `debtNoticeFunder` (the consumer never is); who that funder is
 * comes from the permissions module (`walletFunderUserIds`). Enforced atomically like the
 * automation-skip notice: one conditional upsert on wallet_debt_notices claims the period (a
 * concurrent settle that also left the wallet in debt loses the claim), and the notification
 * rows are written in the same transaction, so a claimed period always carries its notice. The
 * stamp is `(now() at time zone 'utc')` into a timestamp-without-time-zone column, and the
 * period start is bound as a UTC instant, so the boundary never follows the session time zone.
 *
 * Runs AFTER the settle committed, never inside it: a notice that fails must not undo a charge.
 * Never throws — a failure is logged with its cause chain and the settle stands.
 *
 * In-app notification rows only: no email, no push, no realtime fan-out (surfaces are Wave F).
 */

import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { notifications } from '@pagespace/db/schema/notifications';
import { walletDebtNotices, wallets } from '@pagespace/db/schema/wallets';
import { loggers } from '../logging/logger-config';
import { walletFunderUserIds } from '../permissions/wallet-funders';
import { debtNoticeFunder, debtNoticePeriodStartMs } from './wallet-core';

const UTC_NOW = sql`(now() at time zone 'utc')`;

const NOTICE_WALLET = {
  id: wallets.id,
  ownerType: wallets.ownerType,
  userId: wallets.userId,
  orgId: wallets.orgId,
  subjectType: wallets.subjectType,
  subjectId: wallets.subjectId,
  parentWalletId: wallets.parentWalletId,
  debtCents: wallets.debtCents,
  monthlyPeriodStart: wallets.monthlyPeriodStart,
} as const;

export interface WalletDebtNoticeInput {
  /** The wallet the settle left in debt (WalletSettlement.debt.walletId). */
  debtWalletId: string;
  /** The wallet the call charged. */
  chargedWalletId: string;
  now?: Date;
}

/** Tell the funder of `debtWalletId`, unless already told this period. Returns whether a notice was written. */
export async function notifyFunderOfWalletDebt(input: WalletDebtNoticeInput): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const [debtWallet] = await tx.select(NOTICE_WALLET).from(wallets).where(eq(wallets.id, input.debtWalletId));
      if (!debtWallet) return false;
      const [charged] = input.chargedWalletId === debtWallet.id
        ? [{ parentWalletId: debtWallet.parentWalletId }]
        : await tx.select({ parentWalletId: wallets.parentWalletId }).from(wallets).where(eq(wallets.id, input.chargedWalletId));
      const funder = debtNoticeFunder({ debtWallet, chargedWalletIsChild: (charged?.parentWalletId ?? null) !== null });
      if (funder === null) return false;
      const [funderWallet] = funder === 'self'
        ? [debtWallet]
        : await tx.select(NOTICE_WALLET).from(wallets).where(eq(wallets.id, debtWallet.parentWalletId as string));
      if (!funderWallet) return false;
      const recipients = await walletFunderUserIds(tx, funderWallet);
      if (recipients.length === 0) return false;

      const periodStart = new Date(debtNoticePeriodStartMs({
        walletPeriodStartMs: debtWallet.monthlyPeriodStart?.getTime() ?? null,
        nowMs: (input.now ?? new Date()).getTime(),
      }));
      const claimed = await tx
        .insert(walletDebtNotices)
        .values({ walletId: debtWallet.id, lastNotifiedAt: UTC_NOW })
        .onConflictDoUpdate({
          target: walletDebtNotices.walletId,
          set: { lastNotifiedAt: UTC_NOW },
          // shouldNotifyFunderOfDebt: only when the last notice predates this period.
          setWhere: sql`${walletDebtNotices.lastNotifiedAt} < (${periodStart.toISOString()}::timestamptz at time zone 'utc')`,
        })
        .returning({ walletId: walletDebtNotices.walletId });
      if (claimed.length === 0) return false;

      const isPool = debtWallet.ownerType === 'org' && debtWallet.parentWalletId === null && debtWallet.subjectType === null;
      await tx.insert(notifications).values(recipients.map((userId) => ({
        userId,
        type: 'WALLET_DEBT' as const,
        title: isPool ? "Your organization's wallet is over" : 'A wallet you fund is over',
        message: isPool
          ? "Spending in your organization ran past what its wallet held, so the wallet now carries debt. It is netted at the next refill; add credits to clear it sooner."
          : 'Spending in a drive you fund ran past what its wallet held, so the wallet now carries debt. It is netted from the next allocation; top it up to clear it sooner.',
        driveId: debtWallet.subjectType === 'drive' ? debtWallet.subjectId : null,
        metadata: { walletId: debtWallet.id },
      })));
      return true;
    });
  } catch (error) {
    loggers.ai.error('wallet debt notice failed', error instanceof Error ? error : undefined, { debtWalletId: input.debtWalletId });
    return false;
  }
}
