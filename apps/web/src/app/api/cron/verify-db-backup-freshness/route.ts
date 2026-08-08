import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { audit } from '@pagespace/lib/audit/audit-log';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { getS3Client, getS3Bucket } from '@/lib/presigned-url';
import {
  assessBackupFreshness,
  resolveBackupMaxAgeHours,
  type BackupObject,
} from '@/lib/backup/backup-freshness';

/**
 * Cron endpoint asserting that a recent, encrypted database backup exists.
 *
 * The daily pg_dump job runs as a Fly *scheduled machine* outside this app
 * (PageSpace-Deploy fly/backup/). It failed silently for 44 days: first because
 * a fail-closed BACKUP_ENCRYPTION_KEY gate was added without setting the
 * secret, then because a Fly host migration dropped the machine's schedule
 * timer. Neither fault is visible from the machine's STATE (a schedule that
 * never fires and a job that already finished both read "stopped"), and nothing
 * in the codebase could page a human about it.
 *
 * So this checks the one artifact both faults destroy — the object in the
 * bucket — and routes failure to Sentry, which is the only alerting channel in
 * this deployment that actually reaches a person. It deliberately does NOT
 * inspect the machine: a green machine with no object is still a broken backup.
 *
 * A 503 on failure is intentional, so any uptime/HTTP monitor pointed at this
 * route also catches it without needing Sentry.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce,
 * X-Cron-Signature headers.
 */

const BACKUP_PREFIX = 'db-backups/';

/**
 * Hard cap on list pages. The prefix grows by one object per day, so a single
 * 1000-key page covers ~2.7 years; 20 pages is ~55 years of headroom while
 * still bounding a pathological listing.
 */
const MAX_LIST_PAGES = 20;

async function listBackupObjects(): Promise<BackupObject[]> {
  const client = getS3Client();
  const bucket = getS3Bucket();
  const objects: BackupObject[] = [];
  let continuationToken: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: BACKUP_PREFIX,
        ContinuationToken: continuationToken,
      })
    );

    for (const item of response.Contents ?? []) {
      // A key with no LastModified cannot be aged, so it cannot satisfy a
      // freshness assertion — skip it rather than treat undefined as "now".
      if (!item.Key || !item.LastModified) continue;
      objects.push({
        key: item.Key,
        lastModified: item.LastModified,
        size: item.Size ?? 0,
      });
    }

    if (!response.IsTruncated) break;
    continuationToken = response.NextContinuationToken;
    if (!continuationToken) break;
  }

  return objects;
}

export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  const maxAgeHours = resolveBackupMaxAgeHours(process.env.BACKUP_MAX_AGE_HOURS);

  try {
    const objects = await listBackupObjects();
    const result = assessBackupFreshness({ objects, now: new Date(), maxAgeHours });

    audit({
      eventType: 'data.read',
      resourceType: 'cron_job',
      resourceId: 'verify_db_backup_freshness',
      details: {
        ok: result.ok,
        reason: result.reason,
        ageHours: result.ageHours,
        maxAgeHours: result.maxAgeHours,
        encrypted: result.encrypted,
        objectsSeen: objects.length,
      },
    });

    if (!result.ok) {
      loggers.security.error(`[BACKUP ALERT] ${result.message}`, {
        reason: result.reason,
        ageHours: result.ageHours,
        maxAgeHours: result.maxAgeHours,
        encrypted: result.encrypted,
        newestKey: result.newest?.key ?? null,
        objectsSeen: objects.length,
      });

      // Fingerprint by reason, not by message: the message embeds a changing
      // age, which would otherwise open a brand-new Sentry issue every single
      // day and bury the alert in noise instead of escalating one issue.
      Sentry.captureException(new Error(`[BACKUP ALERT] ${result.message}`), {
        level: 'fatal',
        fingerprint: ['db-backup-freshness', result.reason],
        tags: {
          check: 'db_backup_freshness',
          reason: result.reason,
          encrypted: String(result.encrypted),
        },
        extra: {
          ageHours: result.ageHours,
          maxAgeHours: result.maxAgeHours,
          newestKey: result.newest?.key ?? null,
          newestSize: result.newest?.size ?? null,
          objectsSeen: objects.length,
        },
      });

      // This alert is the entire point of the endpoint, and the fault it
      // reports has already gone unnoticed for 44 days once. Flush before
      // responding so a container recycled right after the cron call cannot
      // drop the event in its transport buffer.
      await Sentry.flush(2000);

      return NextResponse.json(
        {
          success: false,
          ok: false,
          reason: result.reason,
          ageHours: result.ageHours,
          maxAgeHours: result.maxAgeHours,
          encrypted: result.encrypted,
          // Included on the failure path too: an operator triaging a stale
          // alert needs to know whether the prefix holds 23 old objects or
          // none at all before deciding between "job stopped" and "bucket
          // wiped".
          newestKey: result.newest?.key ?? null,
          objectsSeen: objects.length,
          message: result.message,
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      );
    }

    loggers.api.info(`[Cron] DB backup freshness OK: ${result.message}`);

    return NextResponse.json({
      success: true,
      ok: true,
      reason: result.reason,
      ageHours: result.ageHours,
      maxAgeHours: result.maxAgeHours,
      encrypted: result.encrypted,
      newestKey: result.newest?.key ?? null,
      objectsSeen: objects.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // A listing failure is itself a loss of backup visibility — it must alert,
    // not just log, or the check silently stops checking (the exact class of
    // bug this endpoint exists to prevent).
    loggers.api.error('[Cron] Error verifying db backup freshness:', { error });
    Sentry.captureException(error, {
      level: 'error',
      fingerprint: ['db-backup-freshness', 'check_failed'],
      tags: { check: 'db_backup_freshness', reason: 'check_failed' },
    });
    await Sentry.flush(2000);

    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
