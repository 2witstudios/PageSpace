/**
 * Pure decision functions for the Home drive backfill.
 *
 * Intentionally self-contained (no @pagespace/* imports) so that the
 * scripts/ vitest context — which runs in a forked Node process without
 * bun's workspace resolver — can load this file without aliases or stubs.
 * The canonical definitions of HOME_DRIVE_NAME and resolveUniqueSlug live in
 * packages/lib/src/services/drive-guards.ts; any changes there must be
 * mirrored here.
 */

// Mirrors HOME_DRIVE_NAME from @pagespace/lib/services/drive-guards
const HOME_DRIVE_NAME = 'Home';

// Mirrors resolveUniqueSlug from @pagespace/lib/services/drive-guards
function resolveUniqueSlug(existingSlugs: string[], base: string): string {
  const taken = new Set(existingSlugs);
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

export type UserBackfillData = {
  userId: string;
  /** true when the LEFT JOIN produced a Home drive row for this user */
  hasHome: boolean;
  /** all drive slugs already owned by this user (for collision avoidance) */
  existingSlugs: string[];
};

export type DriveInsertData = {
  ownerId: string;
  slug: string;
  name: string;
};

/**
 * Given a batch of users (with their Home-drive status and existing slugs),
 * returns the drive rows to insert. Users who already have a Home drive are
 * skipped. The caller stamps `id` and timestamps before inserting.
 */
export function computeHomeBackfillInserts(users: UserBackfillData[]): DriveInsertData[] {
  const result: DriveInsertData[] = [];
  for (const user of users) {
    if (user.hasHome) continue;
    result.push({
      ownerId: user.userId,
      slug: resolveUniqueSlug(user.existingSlugs, 'home'),
      name: HOME_DRIVE_NAME,
    });
  }
  return result;
}
