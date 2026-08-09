/**
 * THE PER-WORKSPACE WRITE LOCK, and the executor type every store in this
 * folder is parameterised by.
 *
 * Both lived in `workspace-layout-store.ts` and neither was ever about layout.
 * `DbExecutor` names "the pooled client, or a transaction taken from it";
 * `withWorkspaceLock` serializes writes for ONE workspace against every other
 * writer of that workspace, whatever it is writing. The layout store happened to
 * be the first caller, which is the only reason they were declared there — and
 * it is why the node model, the shells store and the membership reads all had to
 * import from the module they replaced.
 *
 * It was called `withWorkspaceLayoutLock`, and the node store's doc explained at
 * length that the OLD lock was imported deliberately so a node write and a legacy
 * verb write for the same workspace would serialize against each other "for the
 * whole of the migration window". There is no second model and no window: there
 * is one lock because there is one writer, and the name now says so.
 */

import type { db as DbType } from '@pagespace/db/db';

type DbTransactionCallback = Parameters<typeof DbType.transaction>[0];

/**
 * The real pooled `db`, OR a transaction obtained from it. Type-only, so
 * injecting a fake store in tests never loads the DB module graph.
 */
export type DbExecutor = typeof DbType | Parameters<DbTransactionCallback>[0];

/**
 * Serializes every call for the same `workspaceId` against every OTHER call
 * (from any caller, on any connection) for that same workspace: opens a
 * transaction, acquires a Postgres advisory lock scoped to it (auto-released
 * on commit/rollback), and only then invokes `fn` — so `fn`'s first read is
 * guaranteed not to race a concurrent mutator's write, and vice versa.
 *
 * This is what closes the lost-update class a write's own transaction cannot
 * prevent alone: the caller's OWN read has to be inside the same lock scope as
 * the write, or two callers each compute a full replacement from the same stale
 * base and the later commit silently drops the earlier one's change.
 *
 * `fn` receives the transaction so it can route its whole critical section
 * through the SAME executor.
 *
 * `hashtext()` collapses the workspace id (a cuid2 string) to the bigint key
 * `pg_advisory_xact_lock` needs — a 32-bit hash, so a collision with an
 * unrelated workspace merely over-serializes the two, never a correctness
 * issue. Same pattern the machine panes store shipped.
 */
export async function withWorkspaceLock<T>(
  workspaceId: string,
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  const [{ db }, { sql }] = await Promise.all([import('@pagespace/db/db'), import('@pagespace/db/operators')]);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
    return fn(tx);
  });
}
