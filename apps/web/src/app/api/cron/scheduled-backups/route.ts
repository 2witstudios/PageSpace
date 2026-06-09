import { NextResponse } from 'next/server';
import { and, eq, isNotNull, lte } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { driveBackupSchedules } from '@pagespace/db/schema/versioning';
import { createDriveBackup } from '@/services/api/drive-backup-service';
import { MEMORY_PAYING_TIERS } from '@pagespace/lib/billing/automation-preferences';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { loggers } from '@pagespace/lib/logging/logger-config';

const MAX_CONCURRENT = 5;

type BackupFrequency = 'daily' | 'weekly' | 'monthly';

function computeNextRunAt(frequency: BackupFrequency, after: Date): Date {
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

export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) return authError;

  return runScheduledBackups();
}

export async function POST(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) return authError;

  return runScheduledBackups();
}

async function runScheduledBackups() {
  const now = new Date();

  try {
    const dueSchedules = await db
      .select({
        scheduleId: driveBackupSchedules.id,
        driveId: driveBackupSchedules.driveId,
        frequency: driveBackupSchedules.frequency,
        ownerId: drives.ownerId,
        ownerTier: users.subscriptionTier,
      })
      .from(driveBackupSchedules)
      .innerJoin(drives, and(eq(driveBackupSchedules.driveId, drives.id), eq(drives.isTrashed, false)))
      .innerJoin(users, eq(drives.ownerId, users.id))
      .where(
        and(
          eq(driveBackupSchedules.enabled, true),
          isNotNull(driveBackupSchedules.nextRunAt),
          lte(driveBackupSchedules.nextRunAt, now)
        )
      );

    if (dueSchedules.length === 0) {
      return NextResponse.json({ success: true, fired: 0, skipped: 0 });
    }

    let fired = 0;
    let skipped = 0;

    // Process in batches of MAX_CONCURRENT
    for (let i = 0; i < dueSchedules.length; i += MAX_CONCURRENT) {
      const batch = dueSchedules.slice(i, i + MAX_CONCURRENT);
      await Promise.all(batch.map(async (schedule) => {
        const tier = (schedule.ownerTier ?? 'free') as SubscriptionTier;

        if (!MEMORY_PAYING_TIERS.includes(tier)) {
          // Owner downgraded — defer next run but don't disable (let UI inform them)
          const nextRunAt = computeNextRunAt(schedule.frequency as BackupFrequency, now);
          await db
            .update(driveBackupSchedules)
            .set({ nextRunAt, updatedAt: now })
            .where(eq(driveBackupSchedules.id, schedule.scheduleId));
          skipped++;
          return;
        }

        try {
          const result = await createDriveBackup(schedule.driveId, schedule.ownerId, {
            source: 'scheduled',
          });

          const nextRunAt = computeNextRunAt(schedule.frequency as BackupFrequency, now);
          await db
            .update(driveBackupSchedules)
            .set({ lastRunAt: now, nextRunAt, updatedAt: now })
            .where(eq(driveBackupSchedules.id, schedule.scheduleId));

          if (result.success) {
            fired++;
          } else {
            loggers.api.error(`Scheduled backup failed for drive ${schedule.driveId}: ${result.error}`);
            skipped++;
          }
        } catch (err) {
          loggers.api.error(`Scheduled backup error for drive ${schedule.driveId}`, err as Error);
          // Still advance nextRunAt so we don't retry immediately on every tick
          const nextRunAt = computeNextRunAt(schedule.frequency as BackupFrequency, now);
          await db
            .update(driveBackupSchedules)
            .set({ nextRunAt, updatedAt: now })
            .where(eq(driveBackupSchedules.id, schedule.scheduleId));
          skipped++;
        }
      }));
    }

    console.log(`[Cron] Scheduled backups: ${fired} fired, ${skipped} skipped`);
    return NextResponse.json({ success: true, fired, skipped });
  } catch (error) {
    loggers.api.error('Error running scheduled backups cron', error as Error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}
