import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq, and, lte } from '@pagespace/db/operators';
import { driveBackupSchedules } from '@pagespace/db/schema/versioning';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { createDriveBackup } from '@/services/api/drive-backup-service';
import { MEMORY_PAYING_TIERS } from '@pagespace/lib/billing/automation-preferences';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';

type BackupFrequency = 'daily' | 'weekly' | 'monthly';

function computeNextRunAt(frequency: BackupFrequency, after: Date = new Date()): Date {
  const next = new Date(after);
  if (frequency === 'daily') {
    next.setDate(next.getDate() + 1);
  } else if (frequency === 'weekly') {
    next.setDate(next.getDate() + 7);
  } else {
    next.setMonth(next.getMonth() + 1);
  }
  return next;
}

const BATCH_SIZE = 5;

export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) return authError;

  try {
    const now = new Date();

    const dueSchedules = await db
      .select({
        id: driveBackupSchedules.id,
        driveId: driveBackupSchedules.driveId,
        frequency: driveBackupSchedules.frequency,
        ownerId: drives.ownerId,
        ownerTier: users.subscriptionTier,
      })
      .from(driveBackupSchedules)
      .innerJoin(drives, eq(driveBackupSchedules.driveId, drives.id))
      .innerJoin(users, eq(drives.ownerId, users.id))
      .where(and(
        eq(driveBackupSchedules.enabled, true),
        lte(driveBackupSchedules.nextRunAt, now)
      ));

    if (dueSchedules.length === 0) {
      return NextResponse.json({ success: true, fired: 0, skipped: 0 });
    }

    let fired = 0;
    let skipped = 0;

    for (let i = 0; i < dueSchedules.length; i += BATCH_SIZE) {
      const batch = dueSchedules.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (schedule) => {
        const nextRunAt = computeNextRunAt(schedule.frequency as BackupFrequency, now);
        const runAt = new Date();

        const isProPlus = MEMORY_PAYING_TIERS.includes(schedule.ownerTier as SubscriptionTier);

        if (!isProPlus) {
          await db.update(driveBackupSchedules)
            .set({ nextRunAt, updatedAt: runAt })
            .where(eq(driveBackupSchedules.id, schedule.id));
          skipped++;
          return;
        }

        let backupSucceeded = false;
        try {
          const result = await createDriveBackup(schedule.driveId, schedule.ownerId, { source: 'scheduled' });
          backupSucceeded = result.success;
        } catch (err) {
          loggers.system.error('scheduled-backups: backup failed for drive', err as Error);
        }

        if (backupSucceeded) {
          await db.update(driveBackupSchedules)
            .set({ lastRunAt: runAt, nextRunAt, updatedAt: runAt })
            .where(eq(driveBackupSchedules.id, schedule.id));
          fired++;
        } else {
          await db.update(driveBackupSchedules)
            .set({ nextRunAt, updatedAt: runAt })
            .where(eq(driveBackupSchedules.id, schedule.id));
          skipped++;
        }
      }));
    }

    return NextResponse.json({ success: true, fired, skipped });
  } catch (error) {
    loggers.system.error('scheduled-backups cron failed', error as Error);
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
