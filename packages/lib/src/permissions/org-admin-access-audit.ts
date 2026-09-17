import { db } from '@pagespace/db/db';
import { rateLimitBuckets } from '@pagespace/db/schema/rate-limit-buckets';
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { audit } from '../audit/audit-log';
import { loggers } from '../logging/logger-config';

/**
 * The ORG-4 audit writer: an org Owner or Admin used org power, not a membership row, on a PRIVATE
 * drive (AUD-1, through the existing chain per AUD-2).
 *
 * The unit of "access" is one (user, drive) per 15-minute UTC window, not one resolver call. A page
 * view, a realtime event, a search hit and an AI tool call each re-resolve the drive, so without a
 * window one person opening Finance would write hundreds of rows. Every resolver writes through
 * this one function, so the window holds on every path.
 *
 * Enforcement is a guarded insert on a unique key: a claim row in rate_limit_buckets keyed by
 * (user + drive, truncated window start), inserted ON CONFLICT DO NOTHING. Only the caller whose
 * insert lands writes the audit event, so concurrent requests and separate processes (web,
 * realtime, processor) write one row between them. The audit store itself cannot hold the key: the
 * dedicated Admin PG ingest grant is INSERT-only, so it cannot be read back or conflict-checked.
 * Claim rows expire with their window and are swept with the other buckets.
 *
 * Fails open: if the claim store is unreachable the event is written anyway. Over-auditing a
 * PRIVATE drive is acceptable; losing the record of an access is not.
 */

export const ORG_ADMIN_AUDIT_WINDOW_MS = 15 * 60 * 1000;

export interface OrgAdminAccess {
  userId: string;
  driveId: string;
  orgId: string;
  orgRole: OrgRole;
}

export interface OrgAdminAuditClaim {
  key: string;
  windowStart: Date;
  expiresAt: Date;
}

/** The claim for one access: its (key, windowStart) is the unique key. Epoch ms are UTC. */
export function orgAdminAuditClaim(access: OrgAdminAccess, now: Date): OrgAdminAuditClaim {
  const start = Math.floor(now.getTime() / ORG_ADMIN_AUDIT_WINDOW_MS) * ORG_ADMIN_AUDIT_WINDOW_MS;
  return {
    key: `audit:org-admin-private-drive:${access.userId}:${access.driveId}`,
    windowStart: new Date(start),
    expiresAt: new Date(start + ORG_ADMIN_AUDIT_WINDOW_MS),
  };
}

export interface OrgAdminAccessAuditorDeps {
  /** Inserts the claim; true when this caller's insert landed, false when the key was taken. */
  claim: (claim: OrgAdminAuditClaim) => Promise<boolean>;
  write: (access: OrgAdminAccess) => void;
  now: () => Date;
}

export interface OrgAdminAccessAuditor {
  record(access: OrgAdminAccess): Promise<void>;
}

/** Bound on the in-process memo; it is only a fast path in front of the claim store. */
const MEMO_LIMIT = 10_000;

export function createOrgAdminAccessAuditor({ claim, write, now }: OrgAdminAccessAuditorDeps): OrgAdminAccessAuditor {
  // Claims this process already settled (won or lost) in the current window: a realtime socket
  // re-resolving per event must not reach Postgres on every event.
  const settled = new Set<string>();
  let memoWindow = 0;

  return {
    async record(access) {
      const current = orgAdminAuditClaim(access, now());
      const windowMs = current.windowStart.getTime();
      if (windowMs !== memoWindow || settled.size >= MEMO_LIMIT) {
        settled.clear();
        memoWindow = windowMs;
      }
      if (settled.has(current.key)) return;

      let won: boolean;
      try {
        won = await claim(current);
      } catch (error) {
        loggers.security.warn('[ORG-4] audit window claim failed; writing the access event without dedupe', {
          error: error instanceof Error ? error : new Error(String(error)),
        });
        write(access);
        return;
      }
      if (memoWindow === windowMs) settled.add(current.key);
      if (won) write(access);
    },
  };
}

async function claimInRateLimitBuckets({ key, windowStart, expiresAt }: OrgAdminAuditClaim): Promise<boolean> {
  const inserted = await db
    .insert(rateLimitBuckets)
    .values({ key, windowStart, count: 1, expiresAt })
    .onConflictDoNothing({ target: [rateLimitBuckets.key, rateLimitBuckets.windowStart] })
    .returning({ key: rateLimitBuckets.key });
  return inserted.length > 0;
}

function writeOrgAdminAccessEvent({ userId, driveId, orgId, orgRole }: OrgAdminAccess): void {
  audit({
    eventType: 'authz.access.granted',
    userId,
    resourceType: 'drive',
    resourceId: driveId,
    details: { via: 'org_admin', orgId, orgRole, orgVisibility: 'PRIVATE' },
  });
}

const defaultAuditor = createOrgAdminAccessAuditor({
  claim: claimInRateLimitBuckets,
  write: writeOrgAdminAccessEvent,
  now: () => new Date(),
});

/** ORG-4: record that org power opened a PRIVATE drive, at most once per (user, drive) per window. */
export function auditOrgAdminPrivateDriveAccess(access: OrgAdminAccess): Promise<void> {
  return defaultAuditor.record(access);
}
