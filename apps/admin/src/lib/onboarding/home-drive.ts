import { db } from '@pagespace/db/db'
import { eq, sql } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { drives, pages } from '@pagespace/db/schema/core'
import { createId } from '@paralleldrive/cuid2'
import { HOME_DRIVE_NAME, resolveUniqueSlug } from '@pagespace/lib/services/drive-guards'
import { allocatePublishSubdomain } from '@pagespace/lib/services/drive-service'
import { populateUserDrive } from '@/lib/onboarding/drive-setup'

type TransactionType = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ProvisionHomeDriveResult {
  driveId: string;
  created: boolean;
}

/**
 * Provision a Home drive for the user if one does not already exist.
 *
 * Semantics of `created`:
 * - `true`  = first-time signup: Home was just seeded with a "Getting Started" folder +
 *             tutorial content. The caller should redirect to `welcome=true`.
 * - `false` = either the drive already existed, OR the user owns other drives and was
 *             reached lazily (OAuth / magic-link on every login). In the lazy case the
 *             Home is created as an EMPTY drive so the user's normal post-login
 *             `returnUrl` is never hijacked into an empty drive.
 *
 * Race safety: a `SELECT … FOR UPDATE` on the user row serialises concurrent calls
 * (e.g. two rapid OAuth callbacks for the same user). The partial unique index on
 * (ownerId) WHERE kind='HOME' provides a DB-level backstop.
 */
export async function provisionHomeDriveIfNeeded(
  userId: string
): Promise<ProvisionHomeDriveResult> {
  return db.transaction(async (tx: TransactionType) => {
    await tx.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} FOR UPDATE`);

    const ownedDrives = await tx.query.drives.findMany({
      where: eq(drives.ownerId, userId),
      columns: { id: true, kind: true, slug: true },
    });

    const homeDrive = ownedDrives.find((d) => d.kind === 'HOME');
    if (homeDrive) {
      return { driveId: homeDrive.id, created: false };
    }

    const isExistingUser = ownedDrives.length > 0;
    const existingSlugs = ownedDrives.map((d) => d.slug);
    const slug = resolveUniqueSlug(existingSlugs, 'home');

    const [newDrive] = await tx
      .insert(drives)
      .values({
        name: HOME_DRIVE_NAME,
        slug,
        kind: 'HOME',
        ownerId: userId,
        updatedAt: new Date(),
      })
      .returning();

    // Auto-allocate a globally-unique publish subdomain for the Home drive so it is
    // addressable at <sub>.pagespace.site from creation (participates in this tx).
    await allocatePublishSubdomain(newDrive.id, slug, tx);

    if (isExistingUser) {
      return { driveId: newDrive.id, created: false };
    }

    const [folder] = await tx
      .insert(pages)
      .values({
        id: createId(),
        title: 'Getting Started',
        type: 'FOLDER',
        driveId: newDrive.id,
        content: '',
        isTrashed: false,
        position: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    await populateUserDrive(userId, newDrive.id, tx, { rootParentId: folder.id });

    return { driveId: newDrive.id, created: true };
  });
}
