import { HOME_DRIVE_NAME, resolveUniqueSlug } from '@pagespace/lib/services/drive-guards';

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
 * skipped. The caller stamps `id`, `kind`, and timestamps before inserting.
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
