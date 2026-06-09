import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { driveBackupSchedules } from '@pagespace/db/schema/versioning';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { MEMORY_PAYING_TIERS } from '@pagespace/lib/billing/automation-preferences';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { validateTimezone } from '@/lib/workflows/cron-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

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

const patchScheduleSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
  timezone: z.string().optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  try {
    const [canManage, userRow, schedule] = await Promise.all([
      isDriveOwnerOrAdmin(auth.userId, driveId),
      db.select({ tier: users.subscriptionTier }).from(users).where(eq(users.id, auth.userId)).limit(1),
      db.select().from(driveBackupSchedules).where(eq(driveBackupSchedules.driveId, driveId)).limit(1),
    ]);

    if (!canManage) {
      return NextResponse.json({ error: 'Only drive owners and admins can access backup settings' }, { status: 403 });
    }

    const tier = (userRow[0]?.tier ?? 'free') as SubscriptionTier;
    const available = MEMORY_PAYING_TIERS.includes(tier);
    const row = schedule[0];

    if (!row) {
      return NextResponse.json({ available, enabled: false, frequency: 'daily', timezone: 'UTC', nextRunAt: null, lastRunAt: null });
    }

    return NextResponse.json({
      available,
      enabled: row.enabled,
      frequency: row.frequency,
      timezone: row.timezone,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
    });
  } catch (error) {
    loggers.api.error('Error fetching backup schedule', error as Error);
    return NextResponse.json({ error: 'Failed to fetch backup schedule' }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const canManage = await isDriveOwnerOrAdmin(auth.userId, driveId);
    if (!canManage) {
      return NextResponse.json({ error: 'Only drive owners and admins can change backup settings' }, { status: 403 });
    }

    const [userRow] = await db
      .select({ tier: users.subscriptionTier })
      .from(users)
      .where(eq(users.id, auth.userId))
      .limit(1);

    const tier = (userRow?.tier ?? 'free') as SubscriptionTier;
    if (!MEMORY_PAYING_TIERS.includes(tier)) {
      return NextResponse.json({ error: 'pro_required', message: 'Automatic backups require a Pro plan or higher' }, { status: 402 });
    }

    const body = await request.json();
    const parsed = patchScheduleSchema.parse(body);

    if (parsed.timezone) {
      const tzCheck = validateTimezone(parsed.timezone);
      if (!tzCheck.valid) {
        return NextResponse.json({ error: tzCheck.error }, { status: 400 });
      }
    }

    const [existing] = await db
      .select({ frequency: driveBackupSchedules.frequency, timezone: driveBackupSchedules.timezone })
      .from(driveBackupSchedules)
      .where(eq(driveBackupSchedules.driveId, driveId))
      .limit(1);

    const frequency = parsed.frequency ?? existing?.frequency ?? 'daily';
    const timezone = parsed.timezone ?? existing?.timezone ?? 'UTC';
    const now = new Date();

    const nextRunAt = parsed.enabled ? computeNextRunAt(frequency as BackupFrequency, now) : null;

    await db
      .insert(driveBackupSchedules)
      .values({
        driveId,
        enabled: parsed.enabled,
        frequency: frequency as BackupFrequency,
        timezone,
        nextRunAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: driveBackupSchedules.driveId,
        set: {
          enabled: parsed.enabled,
          frequency: frequency as BackupFrequency,
          timezone,
          nextRunAt,
          updatedAt: now,
        },
      });

    return NextResponse.json({
      enabled: parsed.enabled,
      frequency,
      timezone,
      nextRunAt: nextRunAt?.toISOString() ?? null,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    loggers.api.error('Error updating backup schedule', error as Error);
    return NextResponse.json({ error: 'Failed to update backup schedule' }, { status: 500 });
  }
}
