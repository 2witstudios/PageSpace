import { resolveUniquePublishSubdomain } from '@pagespace/lib/services/subdomain-allocation';

export type DriveBackfillRow = {
  id: string;
  slug: string;
  /** existing publishSubdomain (null when unset) */
  publishSubdomain: string | null;
};

export type DriveSubdomainBackfillResult = {
  driveId: string;
  subdomain: string;
};

/**
 * Given the drives still missing a publishSubdomain and the set of ALL already-taken
 * subdomains (across the whole DB — not just the missing drives), compute a unique
 * subdomain for each missing drive.
 *
 * Pure + synchronous so it's unit-testable without a database. The caller writes the
 * results and is the final race arbiter (DB unique constraint); this just produces
 * free candidates assuming `takenSubdomains` is current.
 *
 * The `takenSubdomains` set MUST include every subdomain already allocated (so that
 * drives are de-duplicated against the whole DB, not just the missing batch), and is
 * mutated as candidates are assigned (so multiple missing drives with the same slug
 * don't collide with each other within one run).
 */
export function computePublishSubdomainBackfill(
  missing: DriveBackfillRow[],
  takenSubdomains: string[],
): DriveSubdomainBackfillResult[] {
  const taken = new Set(takenSubdomains);
  const results: DriveSubdomainBackfillResult[] = [];
  for (const drive of missing) {
    if (drive.publishSubdomain) continue; // defensive: skip drives that already have one
    const subdomain = resolveUniquePublishSubdomain(drive.slug, [...taken]);
    taken.add(subdomain); // reserve within-run so the next missing drive can't take it
    results.push({ driveId: drive.id, subdomain });
  }
  return results;
}
