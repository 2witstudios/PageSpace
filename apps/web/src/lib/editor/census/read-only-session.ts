/**
 * `SET`, not a promise from the caller. The census is run by a human holding
 * the production credential, so "it only reads" is enforced by the server:
 * every connection this pool opens starts its transactions read-only, and any
 * write — a bug, a future edit, a library doing something unexpected — fails
 * with `cannot execute ... in a read-only transaction` instead of succeeding.
 */
export const READ_ONLY_SESSION_SQL = 'SET default_transaction_read_only = on';

interface ReadOnlyCapableClient {
  query(sql: string): unknown;
}

interface ReadOnlyCapablePool {
  on(event: 'connect', listener: (client: ReadOnlyCapableClient) => void): unknown;
}

/**
 * Registers the guard on a `pg.Pool` BEFORE it opens its first connection.
 * node-postgres queues queries per client, so the `SET` issued from `connect`
 * always runs ahead of whatever the census asks that connection for.
 */
export function enforceReadOnlySession(pool: ReadOnlyCapablePool): void {
  pool.on('connect', (client) => {
    void client.query(READ_ONLY_SESSION_SQL);
  });
}

/**
 * Proves the guard actually took, rather than trusting that registering it was
 * enough. node-postgres queues the `SET` ahead of the first real query today;
 * if a driver change ever reorders that, the census stops instead of quietly
 * running with a writable session against production.
 */
export function assertReadOnlySession(rows: ReadonlyArray<Record<string, unknown>>): void {
  const setting = rows[0]?.default_transaction_read_only;
  if (setting !== 'on') {
    throw new Error(
      `refusing to run: the connection is not read-only (default_transaction_read_only=${String(setting)})`,
    );
  }
}
