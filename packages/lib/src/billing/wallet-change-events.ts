/**
 * Announce a drive wallet's change to the drive's room (Spec X-4): `wallet:changed`
 * (realtime/org-wallet-events). A root wallet (a person's own, an org pool) has no drive room:
 * its owner hears credits:updated, and an org pool's admin-level changes are announced as
 * `org:changed` by their writers. Never throws.
 */
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { wallets } from '@pagespace/db/schema/wallets';
import { loggers } from '../logging/logger-config';
import { emitSpendPreferencesChanged, emitWalletChanged, type WalletChange } from '../realtime/org-wallet-events';

export async function announceWalletChange(walletId: string, change: WalletChange): Promise<void> {
  try {
    const [row] = await db.select({ subjectType: wallets.subjectType, subjectId: wallets.subjectId }).from(wallets).where(eq(wallets.id, walletId));
    if (row?.subjectType !== 'drive' || !row.subjectId) return;
    await emitWalletChanged({ driveId: row.subjectId, walletId, change });
  } catch (error) {
    loggers.realtime.warn('wallet change announcement failed', { walletId, change, error: error instanceof Error ? error.message : String(error) });
  }
}

/** The same, for a drive whose wallet id the caller does not hold (a wallet write by drive). */
export async function announceDriveWalletChange(driveId: string, change: WalletChange): Promise<void> {
  try {
    const [row] = await db.select({ id: wallets.id }).from(wallets).where(and(eq(wallets.subjectType, 'drive'), eq(wallets.subjectId, driveId)));
    if (!row) return;
    await emitWalletChanged({ driveId, walletId: row.id, change });
  } catch (error) {
    loggers.realtime.warn('wallet change announcement failed', { driveId, change, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * JOURNEYS-3: one of the person's SPEND preferences changed (a conversation's source, their
 * default, an always-own-credits switch). Every other window of the same person hears this on
 * their notifications room and refetches the previews it shows, so what a window displays
 * never disagrees with what the next send will spend. Never throws: the emit already contains
 * its own failure handling.
 */
export async function announceSpendPreferenceChange(userId: string): Promise<void> {
  await emitSpendPreferencesChanged({ userId });
}
