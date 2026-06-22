import { resolveUniquePublishSubdomain } from '../validators/subdomain';

/**
 * Detect a PostgreSQL unique_violation (SQLSTATE 23505), including when the
 * driver error is wrapped in a `.cause` chain (Drizzle's DrizzleQueryError wraps
 * the underlying PostgresError this way). Mirrors the pattern in
 * apps/web/src/app/api/commands/command-route-helpers.ts.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown; cause?: unknown };
  if (candidate.code === '23505') return true;
  return isUniqueViolation(candidate.cause);
}

/**
 * PURE retry core for publish-subdomain allocation — testable without a database.
 *
 * Given a way to fetch the currently-taken subdomains and a way to attempt an
 * allocation, resolve a unique candidate and retry on a unique-constraint race
 * (two concurrent creates can both read `acme` as free, but only one insert wins).
 * The DB unique constraint on `publishSubdomain` is the authoritative arbiter;
 * this function just recovers from the race by re-reading `taken` and advancing
 * the suffix until the insert succeeds or the attempt limit is hit.
 */
export async function allocateUniqueSubdomainWithRetry(args: {
  base: string;
  fetchTaken: () => Promise<string[]>;
  /** Attempt the allocation. May return the value actually persisted (e.g. the
   * race-winner's value after a conditional-update no-op) — that return wins over
   * the locally-computed candidate, so a race never reports an unwritten subdomain. */
  attempt: (candidate: string) => Promise<string | void>;
  maxAttempts?: number;
}): Promise<string> {
  const maxAttempts = args.maxAttempts ?? 5;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    if (attempt > maxAttempts) {
      throw new Error(
        `Failed to allocate a unique publish subdomain for "${args.base}" after ${maxAttempts} attempts (repeated unique-constraint conflicts)`,
      );
    }
    const taken = await args.fetchTaken();
    const candidate = resolveUniquePublishSubdomain(args.base, taken);
    try {
      const persisted = await args.attempt(candidate);
      // Honor the actual persisted value when attempt returns one (race recovery);
      // otherwise the candidate we just wrote is what's on disk.
      return persisted ?? candidate;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // race: another create claimed our candidate — loop, re-read taken, try the next.
    }
  }
}
