/**
 * drive-wallet-rehome — the shell that re-homes a drive's wallet inside a drive move ([D-OW-60]).
 *
 * moveDriveToOrg / moveDriveOutOfOrg call it in their own transaction, after the drive row is locked
 * and rewritten, so the drive's org and its wallet's owner can never disagree at commit: in, the
 * wallet is the org's under its pool; out, it is the drive lead's under their personal root. The
 * decision is wallet-admin's `planDriveWalletRehome`; this reads the rows it needs and writes it.
 */
import { and, eq, isNull } from '@pagespace/db/operators';
import { creditLedger } from '@pagespace/db/schema/credits';
import { wallets } from '@pagespace/db/schema/wallets';
import type { db } from '@pagespace/db/db';
import { ensurePersonalRootWalletId } from './personal-wallet';
import { planDriveWalletRehome, type RehomeParent } from './wallet-admin';
import { debtClearedRow, DEBT_FORGIVEN_ENTRY } from './wallet-ledger-core';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DriveWalletHome = { kind: 'org'; orgId: string } | { kind: 'personal'; leadUserId: string };

async function parentFor(tx: Tx, to: DriveWalletHome): Promise<RehomeParent | null> {
  const where = to.kind === 'org'
    ? and(eq(wallets.ownerType, 'org'), eq(wallets.orgId, to.orgId), isNull(wallets.subjectType), isNull(wallets.parentWalletId))
    : eq(wallets.id, await ensurePersonalRootWalletId(tx, to.leadUserId));
  const [row] = await tx
    .select({ id: wallets.id, periodStart: wallets.monthlyPeriodStart, periodEnd: wallets.monthlyPeriodEnd })
    .from(wallets)
    .where(where)
    .limit(1);
  return row ?? null;
}

/**
 * Re-home `driveId`'s wallet, if it has one, under its new owner. The row keeps its id, so its funding
 * legs and its ledger move with it; debt the move forgives is a `debt_forgiven` row, recorded under
 * `actorId`, so the wallet still reconciles with its own ledger to the cent (WAL-5).
 */
export async function rehomeDriveWalletInTx(tx: Tx, input: { driveId: string; actorId: string; to: DriveWalletHome }): Promise<void> {
  const [wallet] = await tx
    .select({ id: wallets.id, status: wallets.status, debtCents: wallets.debtCents, overshootChoice: wallets.overshootChoice })
    .from(wallets)
    .where(and(eq(wallets.subjectType, 'drive'), eq(wallets.subjectId, input.driveId)))
    .for('update');
  if (!wallet) return;
  const parent = await parentFor(tx, input.to);
  const plan = planDriveWalletRehome({
    status: wallet.status,
    debtCents: wallet.debtCents,
    overshootChoice: wallet.overshootChoice,
    to: input.to.kind === 'org'
      ? { ownerType: 'org', orgId: input.to.orgId, parent }
      : { ownerType: 'user', userId: input.to.leadUserId, parent },
  });
  await tx.update(wallets).set(plan.set).where(eq(wallets.id, wallet.id));
  const forgiven = debtClearedRow({ entryType: DEBT_FORGIVEN_ENTRY, userId: input.actorId, walletId: wallet.id, clearedCents: plan.forgivenDebtCents });
  if (forgiven) await tx.insert(creditLedger).values(forgiven);
}
