import { resolveUniquePublishSubdomain } from '../validators/subdomain';

/** PostgreSQL unique_violation SQLSTATE. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === '23505';
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
  attempt: (candidate: string) => Promise<void>;
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
      await args.attempt(candidate);
      return candidate;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // race: another create claimed our candidate — loop, re-read taken, try the next.
    }
  }
}
