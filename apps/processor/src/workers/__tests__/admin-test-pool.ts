/**
 * Admin-plane test pools that behave like production on BOTH sides of the wire.
 *
 * `security_audit_log.timestamp` (and its ingest/co-stream siblings) are
 * `timestamp without time zone`, and those values feed hash recomputation —
 * SIEM delivery preflight and the chainer's verify-on-append. So a harness that
 * stores or reads them differently from production does not test production; it
 * tests itself, and only in the timezone it happens to run in.
 *
 * The two divergences this closes:
 *
 *  READ — pg's default OID-1114 parser interprets the stored wall clock in the
 *  PROCESS's local zone. Production avoids this by passing
 *  `types: buildAdminPgTypes()` on the admin pool (`db.ts`'s
 *  `getAdminPoolForWorker`). The suites built raw pools without it.
 *
 *  WRITE — raw `pg` serializes a JS `Date` parameter using the CLIENT's local
 *  offset, so `new Date('2026-02-01T00:00:03Z')` lands as `2026-01-31 18:00:03`
 *  in America/Chicago. Production writes through drizzle, which serializes with
 *  `toISOString()` and therefore stores UTC wall clock. Passing the ISO string
 *  reproduces drizzle exactly: Postgres parses the wall-clock fields of
 *  '2026-02-01T00:00:03.000Z' into a `timestamp without time zone` and drops
 *  the zone designator, storing `2026-02-01 00:00:03`.
 *
 * Together these made the suites pass only under TZ=UTC. Because they were
 * silently skipping for want of ADMIN_DATABASE_URL, nothing ever reported it.
 *
 * Note this is a HARNESS fix, not a production one: production's write side is
 * drizzle and its read side already carries the UTC parser, so the shipped
 * path is timezone-independent today.
 */

import pg from 'pg';
import { buildAdminPgTypes } from '../../admin-pg-types';

const { Pool } = pg as unknown as {
  Pool: new (config: Record<string, unknown>) => Record<string, unknown>;
};

/**
 * A pg Pool for the admin (trust) plane, configured exactly as production's
 * `getAdminPoolForWorker` configures its own: `types: buildAdminPgTypes()`.
 *
 * Deliberately NOT also overriding Date SERIALIZATION. Production writes these
 * columns two ways — drizzle (UTC wall clock) for the audit rows that feed
 * hashes, and raw pg (client-local wall clock) for bookkeeping like cursor
 * watermarks — and a harness that silently UTC-normalized the second would
 * stop reproducing production. The suite runs under a pinned TZ instead (see
 * `vitest.config.ts`), which is the deployment assumption
 * `admin-pg-types.ts` documents as still-to-be-enforced at the entrypoint.
 */
export function createAdminTestPool<T>(config: Record<string, unknown>): T {
  return new Pool({ ...config, types: buildAdminPgTypes() }) as T;
}
