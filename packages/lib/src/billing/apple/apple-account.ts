/**
 * apple-account — the per-user App Store account token (StoreKit `appAccountToken`).
 *
 * The device passes this UUID on every purchase; Apple signs it into every transaction
 * and server notification. It is how a notification finds its buyer, and how a posted
 * transaction proves it was bought by the account posting it. One per user, created on
 * first use, never rotated (rotating would orphan every existing subscription's
 * notifications).
 */

import { randomUUID } from 'crypto';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { appStoreAccounts } from '@pagespace/db/schema/app-store';

/** A db or an open transaction. */
type Executor = Pick<typeof db, 'select' | 'insert'>;

/** The user's token, or null when they have never started a purchase. */
export async function accountTokenForUser(executor: Executor, userId: string): Promise<string | null> {
  const rows = await executor
    .select({ accountToken: appStoreAccounts.accountToken })
    .from(appStoreAccounts)
    .where(eq(appStoreAccounts.userId, userId))
    .limit(1);
  return rows[0]?.accountToken.toLowerCase() ?? null;
}

/** The user's token, created if missing. Concurrent first calls converge on one token. */
export async function getOrCreateAccountToken(userId: string, executor: Executor = db): Promise<string> {
  const existing = await accountTokenForUser(executor, userId);
  if (existing) return existing;
  await executor
    .insert(appStoreAccounts)
    .values({ userId, accountToken: randomUUID() })
    .onConflictDoNothing({ target: appStoreAccounts.userId });
  const created = await accountTokenForUser(executor, userId);
  if (!created) throw new Error('App Store account token could not be created');
  return created;
}

/** The user an App Store account token belongs to, or null. */
export async function userIdForAccountToken(executor: Executor, accountToken: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(accountToken)) return null;
  const rows = await executor
    .select({ userId: appStoreAccounts.userId })
    .from(appStoreAccounts)
    .where(eq(appStoreAccounts.accountToken, accountToken.toLowerCase()))
    .limit(1);
  return rows[0]?.userId ?? null;
}
