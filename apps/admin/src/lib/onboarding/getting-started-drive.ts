import { db } from '@pagespace/db/db'
import { and, eq, sql, asc } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { drives } from '@pagespace/db/schema/core';
import { slugify } from '@pagespace/lib/utils/utils';
import { populateUserDrive } from '@/lib/onboarding/drive-setup';

export const GETTING_STARTED_DRIVE_NAME = 'Getting Started';

type TransactionType = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ProvisionGettingStartedDriveResult {
  driveId: string;
  created: boolean;
}

/**
 * Provision a personal "Getting Started" drive for a user that does not yet own any drives.
 *
 * Deterministic and race-free: serializes provisioning per-user using a row lock.
 */
export async function provisionGettingStartedDriveIfNeeded(
  userId: string
): Promise<ProvisionGettingStartedDriveResult> {
  const driveSlug = slugify(GETTING_STARTED_DRIVE_NAME);

  return db.transaction(async (tx: TransactionType) => {
    await tx.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} FOR UPDATE`);

    const existingOwnedDrive = await tx.query.drives.findFirst({
      where: and(eq(drives.ownerId, userId), eq(drives.isTrashed, false)),
      columns: {
        id: true,
      },
      orderBy: asc(drives.createdAt),
    });

    if (existingOwnedDrive) {
      return { driveId: existingOwnedDrive.id, created: false };
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

    return { driveId: newDrive.id, created: true };
  });
}
