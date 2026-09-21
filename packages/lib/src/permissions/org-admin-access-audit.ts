import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { rateLimitBuckets } from '@pagespace/db/schema/rate-limit-buckets';
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { securityAudit, type AuditEvent } from '../audit/security-audit';
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
 * PRIVATE drive is acceptable; losing the record of an access is not. For the same reason the
 * write is awaited, and a failed write releases the claim, so the next access in the window
 * writes the record instead of finding the window already taken.
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
  /** Releases a claim whose audit write failed, so a later access in the window writes the record. */
  release: (claim: OrgAdminAuditClaim) => Promise<void>;
  /** Writes the audit event; rejects when the audit store did not accept it. */
  write: (access: OrgAdminAccess) => Promise<void>;
  now: () => Date;
}

export interface OrgAdminAccessAuditor {
  record(access: OrgAdminAccess): Promise<void>;
}

/** Bound on the in-process memo; it is only a fast path in front of the claim store. */
const MEMO_LIMIT = 10_000;

/**
 * How long a LOST claim is trusted. A loss can be stale: the winner's audit write may still be in
 * flight and then fail, releasing the window. Memoizing the loss for the whole window would let
 * this process write nothing for up to 15 minutes of access, so a loss only short-circuits the claim
 * store briefly and a later access asks it again. A won claim is memoized for the whole window.
 */
export const ORG_ADMIN_AUDIT_LOSS_TTL_MS = 30 * 1000;

export function createOrgAdminAccessAuditor({ claim, release, write, now }: OrgAdminAccessAuditorDeps): OrgAdminAccessAuditor {
  // Claims this process already settled in the current window, each with the epoch ms it is trusted
  // until (a win: the window's end; a loss: ORG_ADMIN_AUDIT_LOSS_TTL_MS). A realtime socket
  // re-resolving per event must not reach Postgres on every event.
  const settled = new Map<string, number>();
  let memoWindow = 0;

  const writeOrWarn = async (access: OrgAdminAccess): Promise<boolean> => {
    try {
      await write(access);
      return true;
    } catch (error) {
      loggers.security.warn('[ORG-4] audit write failed', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return false;
    }
  };

  return {
    // Never rejects: resolvers call it without awaiting.
    async record(access) {
      const at = now();
      const current = orgAdminAuditClaim(access, at);
      const windowMs = current.windowStart.getTime();
      if (windowMs !== memoWindow || settled.size >= MEMO_LIMIT) {
        settled.clear();
        memoWindow = windowMs;
      }
      const trustedUntil = settled.get(current.key);
      if (trustedUntil !== undefined && at.getTime() < trustedUntil) return;

      let won: boolean;
      try {
        won = await claim(current);
      } catch (error) {
        loggers.security.warn('[ORG-4] audit window claim failed; writing the access event without dedupe', {
          error: error instanceof Error ? error : new Error(String(error)),
        });
        await writeOrWarn(access);
        return;
      }
      if (memoWindow === windowMs) {
        settled.set(current.key, won ? current.expiresAt.getTime() : at.getTime() + ORG_ADMIN_AUDIT_LOSS_TTL_MS);
      }
      if (!won || await writeOrWarn(access)) return;

      settled.delete(current.key);
      try {
        await release(current);
      } catch (error) {
        loggers.security.warn('[ORG-4] audit window claim release failed; this window has no record of the access', {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
  };
}

/** The guarded insert: true only for the caller whose claim row landed first in its window. */
export async function claimOrgAdminAuditWindow({ key, windowStart, expiresAt }: OrgAdminAuditClaim): Promise<boolean> {
  const inserted = await db
    .insert(rateLimitBuckets)
    .values({ key, windowStart, count: 1, expiresAt })
    .onConflictDoNothing({ target: [rateLimitBuckets.key, rateLimitBuckets.windowStart] })
    .returning({ key: rateLimitBuckets.key });
  return inserted.length > 0;
}

export async function releaseOrgAdminAuditWindow({ key, windowStart }: OrgAdminAuditClaim): Promise<void> {
  await db
    .delete(rateLimitBuckets)
    .where(and(eq(rateLimitBuckets.key, key), eq(rateLimitBuckets.windowStart, windowStart)));
}

/**
 * The same dual write as audit() (structured log, then the audit chain), but awaited so a failed
 * append is seen. The details carry ids only, so audit()'s PII sanitizing has nothing to strip.
 */
async function writeOrgAdminAccessEvent({ userId, driveId, orgId, orgRole }: OrgAdminAccess): Promise<void> {
  const event: AuditEvent = {
    eventType: 'authz.access.granted',
    userId,
    resourceType: 'drive',
    resourceId: driveId,
    details: { via: 'org_admin', orgId, orgRole, orgVisibility: 'PRIVATE' },
  };
  loggers.security.info(`[Audit] ${event.eventType}`, { ...event });
  await securityAudit.logEvent(event);
}

const defaultAuditor = createOrgAdminAccessAuditor({
  claim: claimOrgAdminAuditWindow,
  release: releaseOrgAdminAuditWindow,
  write: writeOrgAdminAccessEvent,
  now: () => new Date(),
});

/** ORG-4: record that org power opened a PRIVATE drive, at most once per (user, drive) per window. */
export function auditOrgAdminPrivateDriveAccess(access: OrgAdminAccess): Promise<void> {
  return defaultAuditor.record(access);
}
