import { db, drives, users, and, eq, sql } from '@pagespace/db';
import { slugify } from '@pagespace/lib/server';
import { populateUserDrive } from '@/lib/onboarding/drive-setup';

export const GETTING_STARTED_DRIVE_NAME = 'Getting Started';

type TransactionType = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ProvisionGettingStartedDriveResult {
  driveId: string;
}

/**
 * Provision a personal "Getting Started" drive for a user that does not yet own any drives.
 *
 * Deterministic and race-free: serializes provisioning per-user using a row lock.
 */
export async function provisionGettingStartedDriveIfNeeded(
  userId: string
): Promise<ProvisionGettingStartedDriveResult | null> {
  const driveSlug = slugify(GETTING_STARTED_DRIVE_NAME);

  return db.transaction(async (tx: TransactionType) => {
    await tx.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} FOR UPDATE`);

    const existingOwnedDrive = await tx.query.drives.findFirst({
      where: and(eq(drives.ownerId, userId), eq(drives.isTrashed, false)),
      columns: {
        id: true,
      },
    });

    if (existingOwnedDrive) {
      return null;
    }

    const [newDrive] = await tx
      .insert(drives)
      .values({
        name: GETTING_STARTED_DRIVE_NAME,
        slug: driveSlug,
        ownerId: userId,
        updatedAt: new Date(),
      })
      .returning();

    await populateUserDrive(userId, newDrive.id, tx);

    return { driveId: newDrive.id };
  });
}
