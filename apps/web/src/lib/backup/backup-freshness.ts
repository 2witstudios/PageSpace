/**
 * Pure freshness assessment for the daily encrypted Postgres backup.
 *
 * Why this exists: the daily `pg_dump → Tigris` job (PageSpace-Deploy
 * fly/backup/backup.sh) stopped producing objects on 2026-06-26 and nobody
 * noticed for 44 days. Two independent faults stacked — a fail-closed
 * BACKUP_ENCRYPTION_KEY gate with the secret never set, then a Fly host
 * migration that silently dropped the scheduled machine's timer. Neither
 * surfaced anywhere, because a scheduled machine that never fires looks exactly
 * like one that already finished (`STATE: stopped`).
 *
 * The only signal that cannot be faked by either fault is the bucket itself, so
 * this asserts on the object listing: a recent, non-empty, `.enc` object must
 * exist. All decision logic lives here as a pure function so it is testable
 * without S3; the route (api/cron/verify-db-backup-freshness) does the I/O and
 * the alerting.
 */

/** One object under the `db-backups/` prefix, narrowed to what the check needs. */
export interface BackupObject {
  key: string;
  lastModified: Date;
  size: number;
}

export type BackupFreshnessReason =
  | 'fresh'
  | 'no_objects'
  | 'stale'
  | 'not_encrypted'
  | 'empty_object';

export interface BackupFreshnessResult {
  ok: boolean;
  reason: BackupFreshnessReason;
  /** Newest object by lastModified, or null when the prefix held nothing. */
  newest: BackupObject | null;
  /** Age of `newest` in hours (2dp). Null when nothing was found. */
  ageHours: number | null;
  maxAgeHours: number;
  /**
   * Whether the newest object is encrypted at rest, keyed off the `.enc`
   * suffix the pipeline spec mandates (see packages/lib/src/security/
   * encrypted-backup-command.ts, which refuses any key not ending `.enc`).
   * Surfaced independently of `reason` so a plaintext object can never be
   * reported as a pass, whatever else is also wrong.
   */
  encrypted: boolean;
  /**
   * Operator-facing summary. Safe to log and to send to Sentry: it names object
   * keys, sizes and ages only — never credentials, never dump contents.
   */
  message: string;
}

export interface AssessBackupFreshnessOptions {
  objects: BackupObject[];
  /** Injected for testability. */
  now: Date;
  /** Alert threshold. 36h tolerates one missed daily run before paging. */
  maxAgeHours: number;
}

const HOUR_MS = 3_600_000;

/**
 * Decide whether the newest backup object is acceptable.
 *
 * Failure ordering is deliberate: staleness is checked before encryption
 * because "backups stopped" is the fault this check exists to catch, and a
 * 44-day-old plaintext object should read as "stopped", not as an encryption
 * regression. A *fresh* plaintext object still fails (`not_encrypted`) — that
 * is the case where someone has removed encryption from the pipeline to make a
 * red check go green, which GDPR #956 requires us to treat as a failure rather
 * than a fix. Either way `encrypted` carries the fact and `message` states it.
 */
export function assessBackupFreshness(
  opts: AssessBackupFreshnessOptions
): BackupFreshnessResult {
  const { objects, now, maxAgeHours } = opts;

  if (objects.length === 0) {
    return {
      ok: false,
      reason: 'no_objects',
      newest: null,
      ageHours: null,
      maxAgeHours,
      encrypted: false,
      message:
        'No database backup objects exist under the db-backups/ prefix at all. ' +
        'Either the backup job has never succeeded against this bucket, or the ' +
        'objects were deleted. Production has no recoverable dump.',
    };
  }

  const newest = objects.reduce((a, b) =>
    b.lastModified.getTime() > a.lastModified.getTime() ? b : a
  );

  const ageHours =
    Math.round(((now.getTime() - newest.lastModified.getTime()) / HOUR_MS) * 100) / 100;
  const encrypted = newest.key.endsWith('.enc');
  const iso = newest.lastModified.toISOString();

  if (ageHours > maxAgeHours) {
    return {
      ok: false,
      reason: 'stale',
      newest,
      ageHours,
      maxAgeHours,
      encrypted,
      message:
        `Newest database backup is ${ageHours}h old, over the ${maxAgeHours}h threshold: ` +
        `${newest.key} (${newest.size} bytes, ${iso}). The daily backup job has stopped ` +
        'producing objects. Check the pagespace-db-backup scheduled machine — a Fly host ' +
        'migration silently drops the schedule and leaves STATE reading "stopped", so ' +
        'confirm via the machine event log that a `start` event exists for the last run.' +
        (encrypted ? '' : ' The newest object is ALSO not encrypted at rest (no .enc suffix).'),
    };
  }

  if (!encrypted) {
    return {
      ok: false,
      reason: 'not_encrypted',
      newest,
      ageHours,
      maxAgeHours,
      encrypted: false,
      message:
        `Newest database backup is recent (${ageHours}h) but is NOT encrypted at rest: ` +
        `${newest.key} (${newest.size} bytes, ${iso}). GDPR #956 requires the dump be ` +
        'AES-256 encrypted, and the pipeline spec only emits keys ending in .enc. A ' +
        'plaintext dump in object storage is a reportable exposure, not a working backup.',
    };
  }

  if (newest.size === 0) {
    return {
      ok: false,
      reason: 'empty_object',
      newest,
      ageHours,
      maxAgeHours,
      encrypted: true,
      message:
        `Newest database backup is recent (${ageHours}h) but is ZERO BYTES: ${newest.key} ` +
        `(${iso}). The upload created an object without a body, so there is nothing to ` +
        'restore. Treat this as no backup for that day.',
    };
  }

  return {
    ok: true,
    reason: 'fresh',
    newest,
    ageHours,
    maxAgeHours,
    encrypted: true,
    message:
      `Newest database backup is ${ageHours}h old (threshold ${maxAgeHours}h): ` +
      `${newest.key} (${newest.size} bytes, ${iso}).`,
  };
}

/** Default alert threshold: tolerate exactly one missed daily run. */
export const DEFAULT_BACKUP_MAX_AGE_HOURS = 36;

/**
 * Resolve the threshold from the environment, falling back to the default for
 * unset/blank/non-numeric/non-positive values rather than silently disabling
 * the check with a nonsense window.
 */
export function resolveBackupMaxAgeHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_BACKUP_MAX_AGE_HOURS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BACKUP_MAX_AGE_HOURS;
  return parsed;
}
