import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { audit } from '@pagespace/lib/audit/audit-log';
import { isCloud } from '@pagespace/lib/deployment-mode';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { getS3Client, getS3Bucket } from '@/lib/presigned-url';
import {
  assessBackupFreshness,
  resolveBackupMaxAgeHours,
  type BackupObject,
  type BackupFreshnessResult,
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

interface BackupListing {
  objects: BackupObject[];
  /**
   * True when the listing could not be completed, from either cause:
   *   - MAX_LIST_PAGES was exhausted while S3 still reported more keys, or
   *   - S3 reported `IsTruncated` but returned no `NextContinuationToken`, so
   *     there is no cursor to continue with.
   *
   * Must never be swallowed. Keys come back in lexicographic order and the
   * date-stamped naming means the NEWEST object sorts LAST, so an incomplete
   * listing systematically hides the newest backup and would report a false
   * `stale` — or, if it stopped without being flagged, a false pass. A bounded
   * scan that silently drops coverage reads as "all clear", which is the exact
   * failure mode this endpoint exists to prevent.
   */
  truncated: boolean;
}

async function listBackupObjects(): Promise<BackupListing> {
  const client = getS3Client();
  const bucket = getS3Bucket();
  const objects: BackupObject[] = [];
  let continuationToken: string | undefined;
  let truncated = false;

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

      // Only the DAILY ROTATION counts. The job writes direct children
      // (db-backups/pagespace-<date>.dump.enc); anything nested under a
      // sub-prefix was put there by a human, and counting those lets a manual
      // copy suppress a real outage. Concretely: db-backups/preserved/ holds the
      // pre-0253 dump, and re-preserving anything would give that object a fresh
      // lastModified and a `.enc` suffix — satisfying this check for 36h while
      // the daily job was dead. Also drops the `db-backups/` directory marker
      // some clients create, which has no date and no body.
      const relativeKey = item.Key.slice(BACKUP_PREFIX.length);
      if (!relativeKey || relativeKey.includes('/')) continue;

      objects.push({
        key: item.Key,
        lastModified: item.LastModified,
        size: item.Size ?? 0,
      });
    }

    if (!response.IsTruncated) break;

    continuationToken = response.NextContinuationToken;
    if (!continuationToken) {
      // S3 said there is more but gave us no cursor to fetch it. We cannot
      // complete the listing, so this is truncated coverage — not a clean end.
      // Breaking without flagging it here would let the route answer 200 from an
      // incomplete listing, which is the whole failure mode being guarded.
      truncated = true;
      break;
    }

    // Ran out of page budget with more keys still outstanding.
    if (page === MAX_LIST_PAGES - 1) truncated = true;
  }

  return { objects, truncated };
}

/**
 * The single description of a run, shared by the audit event, both response
 * bodies and the Sentry payloads. One source so they cannot drift — an earlier
 * revision of this route omitted `objectsSeen` from the failure body only,
 * which is precisely the kind of gap hand-copied literals produce.
 */
function summarize(
  result: BackupFreshnessResult,
  objectsSeen: number,
  truncated: boolean,
  ok: boolean
) {
  return {
    ok,
    reason: result.reason,
    ageHours: result.ageHours,
    maxAgeHours: result.maxAgeHours,
    encrypted: result.encrypted,
    newestKey: result.newest?.key ?? null,
    objectsSeen,
    listingTruncated: truncated,
  };
}

/**
 * Send one alert to Sentry. Centralised so every alert from this endpoint is
 * fingerprinted the same way — grouped by `reason`, never by message, since
 * messages embed changing ages and ids and would otherwise open a fresh issue
 * per occurrence and bury a recurring fault in noise.
 */
function captureAlert(
  error: Error | unknown,
  reason: string,
  level: 'fatal' | 'error',
  extra?: Record<string, unknown>,
  extraTags?: Record<string, string>
): void {
  Sentry.captureException(error, {
    level,
    fingerprint: ['db-backup-freshness', reason],
    tags: { check: 'db_backup_freshness', reason, ...extraTags },
    ...(extra ? { extra } : {}),
  });
}

export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  // The daily pg_dump job this asserts on is cloud-only infrastructure (a Fly
  // scheduled machine against the SaaS database — PageSpace-Deploy fly/backup/).
  // The tenant compose stack ships this same cron image but has no equivalent
  // job, so running the check there would emit a `fatal` Sentry event every night
  // with no remedy available — and an alert that always fires teaches people to
  // ignore backup alerts, destroying the value of this endpoint everywhere else.
  //
  // `isCloud()` rather than a config-presence check on purpose: absence-based
  // gating would let a misconfigured CLOUD deployment silently disable its own
  // backup monitoring, which is precisely the failure this endpoint exists to
  // catch. `isCloud()` is true unless DEPLOYMENT_MODE explicitly says tenant or
  // onprem, so an unset or malformed value still runs the check. (This is not the
  // `!isCloud()` integration-gating antipattern CLAUDE.md warns about — nothing is
  // being feature-restricted; the asserted infrastructure simply does not exist in
  // those topologies. That tenants have no DB backup at all is a real gap, tracked
  // separately, not something this check should paper over by alerting nightly.)
  if (!isCloud()) {
    const skipped = {
      ok: true,
      skipped: true,
      reason: 'not_cloud_deployment' as const,
      deploymentMode: process.env.DEPLOYMENT_MODE ?? null,
    };
    loggers.api.info(
      '[Cron] DB backup freshness skipped: no cloud backup job in this deployment mode',
      skipped
    );
    audit({
      eventType: 'data.read',
      resourceType: 'cron_job',
      resourceId: 'verify_db_backup_freshness',
      details: skipped,
    });
    return NextResponse.json({ success: true, ...skipped, timestamp: new Date().toISOString() });
  }

  const maxAgeHours = resolveBackupMaxAgeHours(process.env.BACKUP_MAX_AGE_HOURS);

  try {
    const { objects, truncated } = await listBackupObjects();
    const result = assessBackupFreshness({ objects, now: new Date(), maxAgeHours });

    // A truncated listing cannot support a pass, so it fails the endpoint
    // outright rather than only logging beside a 200: the newest object sorts
    // last, so what got dropped is exactly what the check depends on, and a
    // check that cannot see its own subject must not report success. Kept out of
    // assessBackupFreshness deliberately — truncation is a property of the
    // listing I/O, not of the backups, so the pure verdict stays about the data
    // and the route owns the HTTP contract ("200 only if we can affirm a good
    // backup").
    const ok = result.ok && !truncated;
    const summary = summarize(result, objects.length, truncated, ok);

    if (truncated) {
      loggers.security.error(
        `[BACKUP ALERT] Backup listing hit the ${MAX_LIST_PAGES}-page cap with more keys outstanding — ` +
          'the newest object sorts last under date-stamped naming, so this verdict may be wrong. ' +
          'Raise MAX_LIST_PAGES or prune the prefix.',
        { objectsSeen: objects.length, maxListPages: MAX_LIST_PAGES, reason: result.reason }
      );
      captureAlert(
        new Error(
          `[BACKUP ALERT] db-backups/ listing truncated at ${MAX_LIST_PAGES} pages ` +
            `(${objects.length} keys seen); freshness verdict is unreliable`
        ),
        'listing_truncated',
        'error',
        { objectsSeen: objects.length, maxListPages: MAX_LIST_PAGES }
      );
    }

    audit({
      eventType: 'data.read',
      resourceType: 'cron_job',
      resourceId: 'verify_db_backup_freshness',
      details: summary,
    });

    if (!ok) {
      // Gated on the FRESHNESS verdict, not on `ok`. A truncated listing alone
      // must not fire this: `result.message` would read "Newest database backup
      // is 0.12h old" and it would be captured at `fatal` under a `fresh`
      // fingerprint — alerting that the backup is fine, as an emergency. The
      // truncation alert above is the correct signal for that case.
      if (!result.ok) {
        loggers.security.error(`[BACKUP ALERT] ${result.message}`, {
          reason: result.reason,
          ageHours: result.ageHours,
          maxAgeHours: result.maxAgeHours,
          encrypted: result.encrypted,
          newestKey: result.newest?.key ?? null,
          objectsSeen: objects.length,
        });

        captureAlert(
          new Error(`[BACKUP ALERT] ${result.message}`),
          result.reason,
          'fatal',
          { ...summary, newestSize: result.newest?.size ?? null },
          { encrypted: String(result.encrypted) }
        );
      }

      // This alert is the entire point of the endpoint, and the fault it
      // reports has already gone unnoticed for 44 days once. Flush before
      // responding so a container recycled right after the cron call cannot
      // drop the event in its transport buffer. Truncation now lands on this
      // path too, so its capture is covered by the same flush.
      await Sentry.flush(2000);

      return NextResponse.json(
        {
          success: false,
          ...summary,
          // `reason` is the freshness verdict; `failureReason` is why the
          // endpoint failed. With a truncated listing as the only fault these
          // differ — reason stays 'fresh' while failureReason explains the 503.
          failureReason: truncated ? 'listing_truncated' : result.reason,
          message: result.message,
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      );
    }

    loggers.api.info(`[Cron] DB backup freshness OK: ${result.message}`);

    return NextResponse.json({
      success: true,
      ...summary,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // A listing failure is itself a loss of backup visibility — it must alert,
    // not just log, or the check silently stops checking (the exact class of
    // bug this endpoint exists to prevent).
    loggers.api.error('[Cron] Error verifying db backup freshness:', { error });
    captureAlert(error, 'check_failed', 'error');
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
