/**
 * The anti-silent-pass guard for DB-backed integration tests.
 *
 * WHY THIS EXISTS. The idiom this replaces looked harmless:
 *
 *   let dbAvailable = false;
 *   beforeAll(async () => {
 *     try { await db.execute(sql`SELECT 1`); dbAvailable = true; }
 *     catch { dbAvailable = false; }
 *   });
 *   it('...', async () => { if (!dbAvailable) return; ...assertions... });
 *
 * When Postgres is absent, every `it` returns before asserting anything and
 * vitest reports the whole file as PASSING. That is not a skip — a skip is
 * visible in the summary and in CI logs. This is a green tick over zero
 * assertions, and it is exactly how migration 0252's data-loss guard stayed
 * "proven" for months by a suite that never opened a database.
 *
 * THE RULE. A DB integration test may not decide for itself that the database
 * was optional. Missing Postgres is a environment failure and must be reported
 * as one. The only escape is an EXPLICIT operator opt-out —
 * `ALLOW_SKIP_DB_TESTS=1` — which exists for local work without Docker and
 * which CI never sets (every CI job that runs these suites provisions a
 * Postgres service), so CI can never take the skip path by accident.
 *
 * USAGE — connection probe:
 *
 *   } catch (error) {
 *     requireDb('my-suite.integration.test.ts', error);
 *     dbAvailable = false;   // only reached under ALLOW_SKIP_DB_TESTS=1
 *   }
 *
 * USAGE — required connection-string env var (for `describe.skipIf(!url)`):
 *
 *   const url = process.env.ADMIN_DATABASE_URL;
 *   requireDbUrl(url, 'ADMIN_DATABASE_URL', 'my-suite.integration.test.ts');
 *   describe.skipIf(!url)(...)
 */

/** The one explicit opt-out. Anything other than '1' is not an opt-out. */
export const ALLOW_SKIP_DB_TESTS_ENV = 'ALLOW_SKIP_DB_TESTS';

/** True only when an operator has explicitly asked to skip DB-backed suites. */
export function dbSkipExplicitlyAllowed(): boolean {
  return process.env[ALLOW_SKIP_DB_TESTS_ENV] === '1';
}

function explain(suite: string, detail: string): string {
  return (
    `${suite} could not reach Postgres: ${detail}\n` +
    'This suite is NOT skippable. Silently skipping it would report a green, ' +
    'zero-assertion pass that proves nothing — the failure mode this guard exists to stop.\n' +
    'Point DATABASE_URL at a migrated Postgres (CI always provides one), or, for local ' +
    `work without Docker, opt out explicitly with ${ALLOW_SKIP_DB_TESTS_ENV}=1.`
  );
}

/**
 * Call from the `catch` of a DB connection probe. Throws unless the operator
 * opted out, in which case it returns and the caller may fall back to skipping.
 */
export function requireDb(suite: string, cause?: unknown): void {
  if (dbSkipExplicitlyAllowed()) return;
  const detail = cause instanceof Error ? cause.message : String(cause ?? 'no connection');
  throw new Error(explain(suite, detail));
}

/**
 * Call at module scope for suites gated on a connection-string env var
 * (`describe.skipIf(!url)`). Throws when the variable is missing unless the
 * operator opted out.
 */
export function requireDbUrl(
  url: string | undefined,
  envVar: string,
  suite: string,
): void {
  if (url) return;
  if (dbSkipExplicitlyAllowed()) return;
  throw new Error(explain(suite, `${envVar} is not set`));
}
