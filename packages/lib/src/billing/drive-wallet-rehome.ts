/**
 * drive-wallet-rehome — the shell that re-homes a drive's wallet inside a drive move ([D-OW-60]).
 *
 * moveDriveToOrg / moveDriveOutOfOrg call it in their own transaction, after the drive row is locked
 * and rewritten, so the drive's org and its wallet's owner can never disagree at commit: in, the
 * wallet is the org's under its pool; out, it is the drive lead's under their personal root. The
 * decision is wallet-admin's `planDriveWalletRehome`; this reads the rows it needs and writes it.
 */
import { and, eq, gt, isNull, or, sql } from '@pagespace/db/operators';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { wallets } from '@pagespace/db/schema/wallets';
import type { db } from '@pagespace/db/db';
import { ensurePersonalRootWalletId } from './personal-wallet';
import { planDriveWalletRehome, type RehomeParent } from './wallet-admin';
import { debtClearedRow, DEBT_FORGIVEN_ENTRY } from './wallet-ledger-core';
import { credentialRefusalFor, type CredentialRefusal, type WalletCredential } from '../permissions/wallet-access';

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

/** Live holds on `walletId` and on any wallet whose holds draw through it (its children). */
async function liveHoldsThrough(tx: Tx, walletId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(creditHolds)
    .where(and(
      gt(creditHolds.expiresAt, new Date()),
      or(eq(creditHolds.walletId, walletId), sql`${creditHolds.walletId} IN (SELECT ${wallets.id} FROM ${wallets} WHERE ${wallets.parentWalletId} = ${walletId})`),
    ));
  return Number(row?.count ?? 0);
}

export type DriveWalletRehomeOutcome = { ok: true } | { ok: false; reason: 'calls_in_flight' } | { ok: false; reason: 'credential_refused'; refusal: CredentialRefusal };

/**
 * Re-home `driveId`'s wallet, if it has one, under its new owner. The row keeps its id, so its funding
 * legs and its ledger move with it; debt the move forgives is a `debt_forgiven` row, recorded under
 * `actorId`, so the wallet still reconciles with its own ledger to the cent (WAL-5).
 *
 * Refused (nothing written) while calls are in flight on it: they settle on the wallet's parent AT
 * SETTLE, so re-homing under them would charge their cost to the new funder ([D-OW-60] re-review). The
 * holds are counted under the wallet's row lock, which every new hold on it takes, so none can slip in
 * between the check and the move. The caller runs this BEFORE it rewrites the drive.
 */
export async function rehomeDriveWalletInTx(tx: Tx, input: { driveId: string; actorId: string; credential: WalletCredential; to: DriveWalletHome }): Promise<DriveWalletRehomeOutcome> {
  const [wallet] = await tx
    .select({ id: wallets.id, status: wallets.status, debtCents: wallets.debtCents, overshootChoice: wallets.overshootChoice })
    .from(wallets)
    .where(and(eq(wallets.subjectType, 'drive'), eq(wallets.subjectId, input.driveId)))
    .for('update');
  if (!wallet) return { ok: true };
  // Even an empty wallet transfers control and clears the old funder's allocation.
  // The caller holds the drive lock, which also fences wallet creation, so a key
  // can make a walletless metadata move without racing a new economic transition.
  const refusal = credentialRefusalFor(input.credential, 'transfer');
  if (refusal) return { ok: false, reason: 'credential_refused', refusal };
  const parent = await parentFor(tx, input.to);
  const plan = planDriveWalletRehome({
    status: wallet.status,
    debtCents: wallet.debtCents,
    overshootChoice: wallet.overshootChoice,
    liveHoldCount: await liveHoldsThrough(tx, wallet.id),
    to: input.to.kind === 'org'
      ? { ownerType: 'org', orgId: input.to.orgId, parent }
      : { ownerType: 'user', userId: input.to.leadUserId, parent },
  });
  if (plan.kind === 'refuse') return { ok: false, reason: plan.reason };
  await tx.update(wallets).set(plan.set).where(eq(wallets.id, wallet.id));
  const forgiven = debtClearedRow({ entryType: DEBT_FORGIVEN_ENTRY, userId: input.actorId, walletId: wallet.id, clearedCents: plan.forgivenDebtCents });
  if (forgiven) await tx.insert(creditLedger).values(forgiven);
  return { ok: true };
}
