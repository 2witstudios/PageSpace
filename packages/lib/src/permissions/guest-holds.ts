/**
 * Guests held by the org's guests policy (Spec POL-1, POL-2): PARKED when the policy goes off, QUEUED for approval
 * when it says approve. Lives in permissions/ because it reads and writes drive_members and page_permissions and
 * decides who counts as a guest; the drive-access-gates seam allows that only here.
 *
 * A guest of an org drive is a drive_members row whose user is not an org member (DRV-8) and does not lead the
 * drive; it includes the GUEST rows a page share link creates (D-OW-24).
 *
 * WHY PARKING AND NOT A MARKER. A marker on the member row cannot make a guest lose access: a guest's page access
 * comes from page_permissions, which the resolver reads without looking at the member row, in dozens of queries.
 * So the guest's member row AND their page grants are moved out of the live tables into org_guest_holds (a full
 * snapshot) and every reader sees "no access" with no extra condition to forget. Restoring re-inserts the
 * snapshot. Nothing is destroyed: the hold holds every column of both.
 */
import { db } from '@pagespace/db/db';
import { and, asc, eq, inArray, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { decryptField } from '../encryption/field-crypto';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { orgMembers } from '@pagespace/db/schema/organizations';
import {
  orgGuestHolds,
  type GuestHoldOrigin,
  type GuestHoldParked,
  type GuestHoldRequest,
  type OrgGuestHold,
} from '@pagespace/db/schema/org-guest-holds';
import { kickForDriveMembershipRevocation } from './revocation-kick';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

/** Rows handled per query: bounds every statement and every bind list (Postgres caps binds at 65535). */
export const GUEST_HOLD_BATCH = 200;

export interface GuestHoldItem {
  holdId: string;
  driveId: string;
  userId: string | null;
  email: string | null;
  origin: GuestHoldOrigin;
  createdAt: Date;
}

const toItem = (h: Pick<OrgGuestHold, 'id' | 'driveId' | 'userId' | 'email' | 'origin' | 'createdAt'>): GuestHoldItem => ({
  holdId: h.id,
  driveId: h.driveId,
  userId: h.userId,
  email: h.email,
  origin: h.origin,
  createdAt: h.createdAt,
});

// ---------------------------------------------------------------------------
// Snapshots: rows go to jsonb as ISO strings and come back as Dates
// ---------------------------------------------------------------------------

const MEMBER_DATE_COLUMNS = ['invitedAt', 'acceptedAt', 'lastAccessedAt'] as const;
const GRANT_DATE_COLUMNS = ['grantedAt', 'expiresAt'] as const;

function revive<T extends Record<string, unknown>>(row: T, dateColumns: readonly string[]): T {
  const out: Record<string, unknown> = { ...row };
  for (const c of dateColumns) if (typeof out[c] === 'string') out[c] = new Date(out[c] as string);
  return out as T;
}

// ---------------------------------------------------------------------------
// Who is a guest
// ---------------------------------------------------------------------------

const orgDriveIds = (executor: Executor, orgId: string) =>
  executor.select({ id: drives.id }).from(drives).where(eq(drives.orgId, orgId));

/** Rows of `orgId`'s drives held by someone outside the org who does not lead the drive. */
const guestRowsOf = (executor: Executor, orgId: string) =>
  and(
    inArray(driveMembers.driveId, orgDriveIds(executor, orgId)),
    sql`not exists (select 1 from ${orgMembers} where ${orgMembers.orgId} = ${orgId} and ${orgMembers.userId} = ${driveMembers.userId})`,
    sql`not exists (select 1 from ${drives} d where d.id = ${driveMembers.driveId} and d."ownerId" = ${driveMembers.userId})`,
  );

// ---------------------------------------------------------------------------
// Suspend (policy off) and restore
// ---------------------------------------------------------------------------

/**
 * Park every guest of the org's drives: snapshot their member row and page grants into a `suspended` hold, then
 * remove both from the live tables. Idempotent (a second run finds no guests) and bounded (batches of
 * GUEST_HOLD_BATCH). Returns what it parked. Call inside the transaction that stored the policy.
 */
export async function suspendOrgGuests(executor: Executor, orgId: string): Promise<GuestHoldItem[]> {
  const parked: GuestHoldItem[] = [];
  for (;;) {
    const rows = await executor.select().from(driveMembers).where(guestRowsOf(executor, orgId)).orderBy(asc(driveMembers.id)).limit(GUEST_HOLD_BATCH);
    if (rows.length === 0) return parked;
    for (const row of rows) {
      const grants = await executor
        .select()
        .from(pagePermissions)
        .where(and(
          eq(pagePermissions.userId, row.userId),
          inArray(pagePermissions.pageId, executor.select({ id: pages.id }).from(pages).where(eq(pages.driveId, row.driveId))),
        ));
      const snapshot: GuestHoldParked = {
        member: JSON.parse(JSON.stringify(row)) as Record<string, unknown>,
        grants: JSON.parse(JSON.stringify(grants)) as Array<Record<string, unknown>>,
      };
      const [hold] = await executor
        .insert(orgGuestHolds)
        .values({ orgId, driveId: row.driveId, userId: row.userId, state: 'suspended', origin: 'invite', request: {}, parked: snapshot })
        .onConflictDoUpdate({
          target: [orgGuestHolds.driveId, orgGuestHolds.userId, orgGuestHolds.state],
          targetWhere: sql`${orgGuestHolds.userId} IS NOT NULL`,
          set: { parked: snapshot },
        })
        .returning();
      // The snapshot is stored before anything is removed, in the same transaction: no state loses a row.
      if (grants.length > 0) await executor.delete(pagePermissions).where(inArray(pagePermissions.id, grants.map((g) => g.id)));
      await executor.delete(driveMembers).where(eq(driveMembers.id, row.id));
      parked.push(toItem(hold));
    }
  }
}

/**
 * Restore every suspended guest whose drive still belongs to the org: re-insert the member row and the page grants
 * whose page still exists, then drop the hold. A row or grant that exists again (the person rejoined some other
 * way) is left as it is. A hold whose drive LEFT the org stays parked: the policy was about org content, so the
 * person does not regain access on a drive the org no longer owns (fail closed; the org Owner still lists it).
 */
export async function restoreOrgGuests(executor: Executor, orgId: string): Promise<GuestHoldItem[]> {
  const restored: GuestHoldItem[] = [];
  for (;;) {
    const holds = await executor
      .select()
      .from(orgGuestHolds)
      .where(and(
        eq(orgGuestHolds.orgId, orgId),
        eq(orgGuestHolds.state, 'suspended'),
        inArray(orgGuestHolds.driveId, orgDriveIds(executor, orgId)),
      ))
      .orderBy(asc(orgGuestHolds.id))
      .limit(GUEST_HOLD_BATCH);
    if (holds.length === 0) return restored;
    for (const hold of holds) {
      const snapshot = hold.parked;
      if (snapshot?.member) {
        await executor.insert(driveMembers).values(revive(snapshot.member as typeof driveMembers.$inferInsert, MEMBER_DATE_COLUMNS)).onConflictDoNothing({ target: [driveMembers.driveId, driveMembers.userId] });
      }
      const grants = (snapshot?.grants ?? []).map((g) => revive(g as typeof pagePermissions.$inferInsert, GRANT_DATE_COLUMNS));
      for (let i = 0; i < grants.length; i += GUEST_HOLD_BATCH) {
        const chunk = grants.slice(i, i + GUEST_HOLD_BATCH);
        const live = new Set((await executor.select({ id: pages.id }).from(pages).where(inArray(pages.id, chunk.map((g) => g.pageId)))).map((p) => p.id));
        const insertable = chunk.filter((g) => live.has(g.pageId));
        if (insertable.length > 0) await executor.insert(pagePermissions).values(insertable).onConflictDoNothing({ target: [pagePermissions.pageId, pagePermissions.userId] });
      }
      await executor.delete(orgGuestHolds).where(eq(orgGuestHolds.id, hold.id));
      restored.push(toItem(hold));
    }
  }
}

/** Realtime: evict each parked guest from the drive's rooms. Best effort and never throws (revocation-kick.ts). */
export async function kickSuspendedGuests(items: readonly GuestHoldItem[]): Promise<void> {
  await Promise.all(
    items.filter((i): i is GuestHoldItem & { userId: string } => i.userId !== null)
      .map((i) => kickForDriveMembershipRevocation({ userId: i.userId, driveId: i.driveId, reason: 'member_removed' })),
  );
}

// ---------------------------------------------------------------------------
// Lists (bounded) and the approval queue
// ---------------------------------------------------------------------------

export interface GuestHoldPage {
  total: number;
  items: GuestHoldItem[];
}

async function listHolds(executor: Executor, orgId: string, state: 'suspended' | 'pending_approval', limit: number): Promise<GuestHoldPage> {
  const where = and(eq(orgGuestHolds.orgId, orgId), eq(orgGuestHolds.state, state));
  const [rows, [counted]] = await Promise.all([
    executor.select().from(orgGuestHolds).where(where).orderBy(asc(orgGuestHolds.createdAt), asc(orgGuestHolds.id)).limit(limit),
    executor.select({ total: sql<number>`count(*)::int` }).from(orgGuestHolds).where(where),
  ]);
  return { total: counted?.total ?? 0, items: rows.map(toItem) };
}

/** The org's suspended guests: `total` is the full count, `items` at most `limit`. */
export const listSuspendedOrgGuests = (orgId: string, limit: number, executor: Executor = db) => listHolds(executor, orgId, 'suspended', limit);

/** The approval queue: outsiders waiting for an Owner or Admin. */
export const listPendingGuestApprovals = (orgId: string, limit: number, executor: Executor = db) => listHolds(executor, orgId, 'pending_approval', limit);

export interface GuestApprovalRequest {
  orgId: string;
  driveId: string;
  /** Exactly one of userId (an account) or email (an invitee with none). */
  userId?: string;
  email?: string;
  origin: GuestHoldOrigin;
  request: GuestHoldRequest;
  requestedBy: string | null;
}

/** Queue an outsider for approval. A repeat request for the same person and drive refreshes the one row, never queues twice. */
export async function requestGuestApproval(input: GuestApprovalRequest, executor: Executor = db): Promise<GuestHoldItem> {
  const email = input.email?.trim().toLowerCase();
  if ((input.userId === undefined) === (email === undefined)) throw new Error('A guest approval names exactly one of userId or email');
  const values = {
    orgId: input.orgId,
    driveId: input.driveId,
    userId: input.userId ?? null,
    email: email ?? null,
    state: 'pending_approval' as const,
    origin: input.origin,
    request: input.request,
    requestedBy: input.requestedBy,
  };
  if (input.userId !== undefined) {
    const [row] = await executor
      .insert(orgGuestHolds)
      .values(values)
      .onConflictDoUpdate({
        target: [orgGuestHolds.driveId, orgGuestHolds.userId, orgGuestHolds.state],
        targetWhere: sql`${orgGuestHolds.userId} IS NOT NULL`,
        set: { request: input.request, origin: input.origin, requestedBy: input.requestedBy },
      })
      .returning();
    return toItem(row);
  }
  const [existing] = await executor
    .select()
    .from(orgGuestHolds)
    .where(and(eq(orgGuestHolds.driveId, input.driveId), sql`lower(${orgGuestHolds.email}) = ${email}`, eq(orgGuestHolds.state, 'pending_approval')))
    .limit(1);
  if (existing) {
    const [row] = await executor.update(orgGuestHolds).set({ request: input.request, origin: input.origin, requestedBy: input.requestedBy }).where(eq(orgGuestHolds.id, existing.id)).returning();
    return toItem(row);
  }
  const [row] = await executor.insert(orgGuestHolds).values(values).returning();
  return toItem(row);
}

export interface ClaimedGuestApproval extends GuestHoldItem {
  orgId: string;
  request: GuestHoldRequest;
  requestedBy: string | null;
}

/**
 * Take a pending request off the queue (approve or decline) and hand it back. Scoped to the org: a request of
 * another org, an already-decided one, or one that does not exist all answer null, so a caller learns nothing.
 * The row is removed in the same statement that reads it, so two approvers cannot both act on one request.
 */
export async function claimPendingGuestApproval(input: { orgId: string; holdId: string }, executor: Executor = db): Promise<ClaimedGuestApproval | null> {
  const [row] = await executor
    .delete(orgGuestHolds)
    .where(and(eq(orgGuestHolds.id, input.holdId), eq(orgGuestHolds.orgId, input.orgId), eq(orgGuestHolds.state, 'pending_approval')))
    .returning();
  return row ? { ...toItem(row), orgId: row.orgId, request: row.request, requestedBy: row.requestedBy } : null;
}

export interface PendingGuestApprovalView extends GuestHoldItem {
  driveName: string;
  /** The person asking to be admitted, by name; null for an invitee who has no account yet (then `email` is set). */
  requesterName: string | null;
  /** What was asked for, without internals: the role and whether page grants were requested. */
  request: { role: 'MEMBER' | 'ADMIN' | null; pageGrants: number; viaLink: boolean };
}

/**
 * The approval queue as an Owner or Admin reviews it: which drive, who is asking, what for. Bounded; `total` is the
 * whole queue. Names are decrypted at the edge. Drive names are visible to org Owners and Admins, who resolve to
 * every org drive anyway (ORG-4, D-OW-25); the caller must already have established that role.
 */
export async function listPendingGuestApprovalViews(orgId: string, limit: number, executor: Executor = db): Promise<{ total: number; items: PendingGuestApprovalView[] }> {
  const where = and(eq(orgGuestHolds.orgId, orgId), eq(orgGuestHolds.state, 'pending_approval'));
  const [rows, [counted]] = await Promise.all([
    executor
      .select({ hold: orgGuestHolds, driveName: drives.name, userName: users.name })
      .from(orgGuestHolds)
      .innerJoin(drives, eq(drives.id, orgGuestHolds.driveId))
      .leftJoin(users, eq(users.id, orgGuestHolds.userId))
      .where(where)
      .orderBy(asc(orgGuestHolds.createdAt), asc(orgGuestHolds.id))
      .limit(limit),
    executor.select({ total: sql<number>`count(*)::int` }).from(orgGuestHolds).where(where),
  ]);
  const items: PendingGuestApprovalView[] = [];
  for (const r of rows) {
    const req = r.hold.request;
    items.push({
      ...toItem(r.hold),
      driveName: r.driveName,
      requesterName: r.hold.userId ? ((await decryptField(r.userName)) ?? null) : null,
      request: { role: req.role ?? null, pageGrants: req.permissions?.length ?? (req.pageId ? 1 : 0), viaLink: r.hold.origin !== 'invite' },
    });
  }
  return { total: counted?.total ?? 0, items };
}
