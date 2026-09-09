import {
  resolveUniquePublishSubdomain,
  normalizeSubdomain,
  DEFAULT_SUBDOMAIN_BASE,
  MAX_SUBDOMAIN_LENGTH,
} from '../validators/subdomain';

/**
 * How much of the normalized base to filter a `fetchTaken` DB read on.
 *
 * `resolveUniquePublishSubdomain` only ever proposes `base`, `base-2`,
 * `base-3`, … with `base` clamped (`clampBaseForSuffix`) to leave room for the
 * `-<suffix>` tail so every candidate stays within `MAX_SUBDOMAIN_LENGTH` (63)
 * characters. That clamp only ever TRUNCATES the base from the right — it
 * never changes the leading characters — so every candidate this allocator
 * could ever produce starts with at least the first `maxBase` characters of
 * the (un-truncated) normalized base, where `maxBase` shrinks only as the
 * suffix grows more digits. Reaching a suffix with more than
 * `MAX_SUBDOMAIN_LENGTH / 2` digits — i.e. more than 10^31 consecutive
 * collisions against the exact same base — never happens, so filtering a
 * `fetchTaken` query to rows sharing this half-length prefix can never hide a
 * real collision (a false "free" candidate): every row that could possibly
 * collide with a candidate is included, and cutting the prefix at half the
 * max length is exactly what keeps the bound provably ahead of any suffix
 * width this system will ever produce.
 */
export const SUBDOMAIN_COLLISION_PREFIX_LENGTH = Math.floor(MAX_SUBDOMAIN_LENGTH / 2);

/**
 * The prefix a `fetchTaken` callback should filter its query on (e.g.
 * `LIKE '<prefix>%'`) for a given allocation `base` — see
 * {@link SUBDOMAIN_COLLISION_PREFIX_LENGTH}. Mirrors
 * `resolveUniquePublishSubdomain`'s own normalization/fallback so the prefix
 * always matches what the allocator will actually try, and is itself capped
 * to `SUBDOMAIN_COLLISION_PREFIX_LENGTH` so the filter can never be longer
 * than what's provably safe.
 */
export function subdomainCollisionPrefix(base: string): string {
  const normalized = normalizeSubdomain(base);
  const fallback = normalized.length > 0 ? normalized : DEFAULT_SUBDOMAIN_BASE;
  return fallback.slice(0, SUBDOMAIN_COLLISION_PREFIX_LENGTH);
}

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
