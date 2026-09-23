/**
 * wallet-legs — the only writers of a funding leg's remaining on a spend and on a spend's
 * refund (D-OW-13, WAL-3).
 * Split from wallet-funding-shell so the settle (credit-consume) can draw the legs inside
 * its own transaction without importing the donation path's permission reads.
 *
 * Lock order (one, global — every multi-row money write follows it, so no two writers
 * wait in a cycle): the drive (child) wallet, then its parent/root wallet, then the
 * funding legs. A caller here already holds the wallet row; the legs are locked last.
 * One known exception, predating this order: the backfill cron's settlePendingLedgerRow
 * locks its credit_ledger row before the wallet, while a live settle locks the wallet and
 * then updates that ledger row — a cron retry racing the live settle of the SAME row could
 * invert. The cron only picks rows older than its grace window, which makes it practically
 * unreachable.
 */

import type { db } from '@pagespace/db/db';
import { wallets, walletFundingLegs } from '@pagespace/db/schema/wallets';
import { and, asc, eq, gt, inArray, sql } from '@pagespace/db/operators';
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

/**
 * Give cents back to specific funding legs (a reconcile refund of a call that drew them),
 * inside the caller's transaction, and keep wallets.topupRemainingCents equal to the legs'
 * total. ALL OR NOTHING: when any named leg is gone from this wallet, or cannot take its
 * full credit without passing its originalCents, nothing is written and `null` is returned
 * — the caller then takes its fallback rather than guess where the cents belong. So a
 * donation leg is never lifted beyond what it gave, and a reversal applied twice cannot
 * create money. The legs are locked after the wallet (the global order), oldest first.
 */
export async function creditWalletFundingLegs(
  tx: Tx,
  walletId: string,
  credits: readonly { legId: string; cents: number }[],
): Promise<{ appliedCents: number } | null> {
  if (credits.some((c) => !Number.isInteger(c.cents) || c.cents < 0)) return null;
  const asked = credits.filter((c) => c.cents > 0);
  if (asked.length === 0) return { appliedCents: 0 };
  const ids = [...new Set(asked.map((c) => c.legId))];
  const rows = await tx
    .select({ id: walletFundingLegs.id, originalCents: walletFundingLegs.originalCents, remainingCents: walletFundingLegs.remainingCents })
    .from(walletFundingLegs)
    .where(and(eq(walletFundingLegs.walletId, walletId), inArray(walletFundingLegs.id, ids)))
    .orderBy(asc(walletFundingLegs.createdAt), asc(walletFundingLegs.id))
    .for('update');
  if (rows.length !== ids.length) return null;
  const headroom = new Map(rows.map((r) => [r.id, r.originalCents - r.remainingCents]));
  for (const credit of asked) {
    const room = headroom.get(credit.legId) ?? 0;
    if (credit.cents > room) return null;
    headroom.set(credit.legId, room - credit.cents);
  }
  for (const credit of asked) {
    await tx
      .update(walletFundingLegs)
      .set({ remainingCents: sql`${walletFundingLegs.remainingCents} + ${credit.cents}` })
      .where(eq(walletFundingLegs.id, credit.legId));
  }
  const appliedCents = asked.reduce((sum, c) => sum + c.cents, 0);
  await tx
    .update(wallets)
    .set({ topupRemainingCents: sql`${wallets.topupRemainingCents} + ${appliedCents}` })
    .where(eq(wallets.id, walletId));
  return { appliedCents };
}
