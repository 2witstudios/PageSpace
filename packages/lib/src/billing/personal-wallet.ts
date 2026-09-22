/**
 * personal-wallet — the one way billing code finds a person's PERSONAL ROOT WALLET id
 * (Spec WAL-1, WAL-5, X-5).
 *
 * The personal root wallet is the row that was the user's credit_balances row. Every
 * credit_ledger and credit_holds row now names the wallet it moved money in or out of,
 * so a writer that only knows the user needs this id before it can write. If the user
 * has no wallet yet, one is created BARE (zero in every bucket, no period stamped) — the
 * same shape a top-up has always created before a user's first AI call, which the gate
 * already knows how to grant into (credit-gate: the starter grant and reset paths). It
 * adds no money.
 *
 * Concurrency: the insert is ON CONFLICT DO NOTHING against the one-root-per-user index,
 * so two callers racing for a first wallet both end with the same id.
 */

import { db } from '@pagespace/db/db';
import { wallets, personalRootWalletOf, PERSONAL_ROOT_WALLET_ARBITER } from '@pagespace/db/schema/wallets';

/** A db or an open transaction. */
export type WalletExecutor = Pick<typeof db, 'select' | 'insert'>;

async function findPersonalRootWalletId(executor: WalletExecutor, userId: string): Promise<string | null> {
  const rows = await executor
    .select({ id: wallets.id })
    .from(wallets)
    .where(personalRootWalletOf(userId))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function ensurePersonalRootWalletId(executor: WalletExecutor, userId: string): Promise<string> {
  const existing = await findPersonalRootWalletId(executor, userId);
  if (existing) return existing;

  const inserted = await executor
    .insert(wallets)
    .values({ ownerType: 'user', userId })
    .onConflictDoNothing(PERSONAL_ROOT_WALLET_ARBITER)
    .returning({ id: wallets.id });
  if (inserted[0]) return inserted[0].id;

  // A concurrent caller created it between our read and our insert.
  const raced = await findPersonalRootWalletId(executor, userId);
  if (raced) return raced;
  throw new Error(`personal root wallet for user ${userId} could not be found or created`);
}
