/**
 * wallet-legs — the only writer of a funding leg's remaining on spend (D-OW-13, WAL-3).
 * Split from wallet-funding-shell so the settle (credit-consume) can draw the legs inside
 * its own transaction without importing the donation path's permission reads.
 *
 * Lock order (one, global — every multi-row money write follows it, so no two writers
 * wait in a cycle): the drive (child) wallet, then its parent/root wallet, then the
 * funding legs. A caller here already holds the wallet row; the legs are locked last.
 */

import type { db } from '@pagespace/db/db';
import { wallets, walletFundingLegs } from '@pagespace/db/schema/wallets';
import { and, asc, eq, gt, sql } from '@pagespace/db/operators';
import { drawFundingLegs, type StoredFundingLeg } from './wallet-funding';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockedLegs(tx: Tx, walletId: string): Promise<StoredFundingLeg[]> {
  const rows = await tx
    .select({
      id: walletFundingLegs.id,
      funderKind: walletFundingLegs.funderKind,
      funderUserId: walletFundingLegs.funderUserId,
      remainingCents: walletFundingLegs.remainingCents,
      nonRefundable: walletFundingLegs.nonRefundable,
      createdAt: walletFundingLegs.createdAt,
    })
    .from(walletFundingLegs)
    .where(and(eq(walletFundingLegs.walletId, walletId), gt(walletFundingLegs.remainingCents, 0)))
    .orderBy(asc(walletFundingLegs.createdAt), asc(walletFundingLegs.id))
    .for('update');
  return rows.map((r) => ({ ...r, createdAtMs: r.createdAt.getTime() }));
}

/**
 * Spend `amountCents` from a wallet's funding legs in the defined order (FIFO), inside
 * the caller's transaction, and keep wallets.topupRemainingCents equal to the legs'
 * total. Returns what was drawn from which leg and the uncovered remainder; the caller
 * (the gate's settle) decides where a shortfall lands (WAL-6).
 */
export async function drawWalletFundingLegs(
  tx: Tx,
  walletId: string,
  amountCents: number,
): Promise<{ draws: { legId: string; cents: number }[]; appliedCents: number; shortfallCents: number }> {
  const [wallet] = await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.id, walletId)).for('update');
  if (!wallet) throw new Error(`wallet ${walletId} not found`);
  const drawn = drawFundingLegs(await lockedLegs(tx, walletId), amountCents);
  for (const d of drawn.draws) {
    await tx
      .update(walletFundingLegs)
      .set({ remainingCents: sql`${walletFundingLegs.remainingCents} - ${d.cents}` })
      .where(eq(walletFundingLegs.id, d.legId));
  }
  if (drawn.appliedCents > 0) {
    await tx
      .update(wallets)
      .set({ topupRemainingCents: sql`${wallets.topupRemainingCents} - ${drawn.appliedCents}` })
      .where(eq(wallets.id, walletId));
  }
  return { draws: drawn.draws, appliedCents: drawn.appliedCents, shortfallCents: drawn.shortfallCents };
}
