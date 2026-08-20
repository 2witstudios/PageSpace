/**
 * Whether a drive's seed scope still needs starter content.
 *
 * Four near-identical seeders used to exist (two in `apps/web`, two in
 * `apps/admin`) and they could run concurrently for the same user — the
 * `drives_home_unique` partial index exists because two of them already did in
 * production. That index stops a duplicate *drive*; nothing stopped a duplicate
 * *set of pages*, which is what an unguarded re-run produces.
 *
 * The decision is pure so it can be tested without a database; the caller
 * supplies the count from inside the transaction that holds the drive row lock.
 */

export interface SeedScopeState {
  /**
   * How many pages already live in the scope the seeder would write into —
   * under `rootParentId` when one is given, otherwise at the drive root.
   * Callers may cap the query at 1; only zero/non-zero matters.
   */
  existingPageCount: number;
}

export type SeedDecision =
  | { action: 'seed' }
  | { action: 'skip'; reason: 'already-seeded' };

export function decideDriveSeeding(state: SeedScopeState): SeedDecision {
  if (state.existingPageCount > 0) {
    return { action: 'skip', reason: 'already-seeded' };
  }
  return { action: 'seed' };
}
