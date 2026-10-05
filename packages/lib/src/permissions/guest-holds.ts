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
import { and, asc, eq, inArray, isNotNull, sql, type SQL } from '@pagespace/db/operators';
import { mcpTokens, users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { decryptField } from '../encryption/field-crypto';
import { driveMembers, driveRoles, mcpTokenDrives, pagePermissions } from '@pagespace/db/schema/members';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { getOrgPolicies } from '../organizations/policy-reader';
import {
  orgGuestHolds,
  type GuestHoldOrigin,
  type GuestHoldParked,
  type GuestHoldRequest,
  type OrgGuestHold,
} from '@pagespace/db/schema/org-guest-holds';
import { kickForDriveMembershipRevocation } from './revocation-kick';
import { decideOrgDriveAdmission } from './guest-admission';

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

/**
 * Where to look for outsiders: the org's drives, narrowed to one drive (a drive moved in, pages moved in) and/or one
 * person (a member who left).
 */
export interface GuestScope {
  orgId: string;
  driveId?: string;
  userId?: string;
  /**
   * Only page grants on these pages, and only for outsiders with NO member row on the drive (pages moved into an
   * org drive: an admitted guest of that drive keeps what the move brought; nobody else is let in by it).
   */
  pageIds?: string[];
}

const scopeDriveIds = (executor: Executor, scope: GuestScope) =>
  executor.select({ id: drives.id }).from(drives).where(and(eq(drives.orgId, scope.orgId), scope.driveId ? eq(drives.id, scope.driveId) : undefined));

/** `userCol` (on a row of drive `driveCol`) is outside the org and does not lead that drive. */
const outsiderOf = (orgId: string, userCol: SQL | typeof driveMembers.userId, driveCol: SQL | typeof driveMembers.driveId) => and(
  sql`not exists (select 1 from ${orgMembers} where ${orgMembers.orgId} = ${orgId} and ${orgMembers.userId} = ${userCol})`,
  sql`not exists (select 1 from ${drives} d where d.id = ${driveCol} and d."ownerId" = ${userCol})`,
);

type Pair = { driveId: string; userId: string };

/** Member rows of the scope's drives held by an outsider (DRV-8), including page-link GUEST rows. */
const memberOutsiders = (executor: Executor, scope: GuestScope): Promise<Pair[]> =>
  executor
    .selectDistinct({ driveId: driveMembers.driveId, userId: driveMembers.userId })
    .from(driveMembers)
    .where(and(
      inArray(driveMembers.driveId, scopeDriveIds(executor, scope)),
      scope.userId ? eq(driveMembers.userId, scope.userId) : undefined,
      outsiderOf(scope.orgId, driveMembers.userId, driveMembers.driveId),
    ))
    .orderBy(asc(driveMembers.driveId), asc(driveMembers.userId))
    .limit(GUEST_HOLD_BATCH);

/** Outsiders holding page grants in the scope's drives (with or without a member row there). */
const grantOutsiders = (executor: Executor, scope: GuestScope): Promise<Pair[]> =>
  executor
    .selectDistinct({ driveId: pages.driveId, userId: pagePermissions.userId })
    .from(pagePermissions)
    .innerJoin(pages, eq(pages.id, pagePermissions.pageId))
    .where(and(
      inArray(pages.driveId, scopeDriveIds(executor, scope)),
      scope.userId ? eq(pagePermissions.userId, scope.userId) : undefined,
      scope.pageIds ? inArray(pagePermissions.pageId, scope.pageIds) : undefined,
      scope.pageIds ? sql`not exists (select 1 from ${driveMembers} m where m."driveId" = ${pages.driveId} and m."userId" = ${pagePermissions.userId})` : undefined,
      outsiderOf(scope.orgId, sql`${pagePermissions.userId}`, sql`${pages.driveId}`),
    ))
    .orderBy(asc(pages.driveId), asc(pagePermissions.userId))
    .limit(GUEST_HOLD_BATCH);

/**
 * Outsiders whose MCP tokens hold an EXPLICIT-role scope on the scope's drives (Review #2762 P2-7). An explicit role
 * grants without re-checking membership (app-permissions.ts); an inherit scope (role null) follows its owner's
 * access, which parking already removes.
 */
const tokenOutsiders = (executor: Executor, scope: GuestScope): Promise<Pair[]> =>
  executor
    .selectDistinct({ driveId: mcpTokenDrives.driveId, userId: mcpTokens.userId })
    .from(mcpTokenDrives)
    .innerJoin(mcpTokens, eq(mcpTokens.id, mcpTokenDrives.tokenId))
    .where(and(
      inArray(mcpTokenDrives.driveId, scopeDriveIds(executor, scope)),
      isNotNull(mcpTokenDrives.role),
      scope.userId ? eq(mcpTokens.userId, scope.userId) : undefined,
      outsiderOf(scope.orgId, sql`${mcpTokens.userId}`, sql`${mcpTokenDrives.driveId}`),
    ))
    .orderBy(asc(mcpTokenDrives.driveId), asc(mcpTokens.userId))
    .limit(GUEST_HOLD_BATCH);

const asJson = <T>(rows: T): T => JSON.parse(JSON.stringify(rows)) as T;

/** Union two page-grant lists by page; flags OR together, so merging never narrows what was held or asked. */
function mergeGrants<G extends { pageId?: unknown; canView?: unknown; canEdit?: unknown; canShare?: unknown; canDelete?: unknown }>(a: G[], b: G[]): G[] {
  const byPage = new Map<string, G>();
  for (const g of [...a, ...b]) {
    const key = String(g.pageId);
    const prev = byPage.get(key);
    byPage.set(key, prev
      ? { ...prev, canView: Boolean(prev.canView || g.canView), canEdit: Boolean(prev.canEdit || g.canEdit), canShare: Boolean(prev.canShare || g.canShare), canDelete: Boolean(prev.canDelete || g.canDelete) }
      : g);
  }
  return [...byPage.values()];
}

/** How an outsider's live access is taken out: parked until guests come back (off), or queued for approval (approve). */
export type GuestTakeMode = 'suspend' | 'queue';

/**
 * Take ONE outsider's live access to ONE org drive out of the live tables: their member row, their page grants on
 * the drive's pages and their tokens' explicit-role scopes. `suspend` snapshots it into the person's `suspended`
 * hold (merged into one that exists, never written over it); `queue` turns it into a pending approval request
 * (origin `page_grant`) that approving replays (completeApprovedPageGrant). Everything is stored before anything is
 * removed, in the caller's transaction.
 */
async function takeOutsider(executor: Executor, orgId: string, { driveId, userId }: Pair, mode: GuestTakeMode, pageIds?: string[]): Promise<GuestHoldItem | null> {
  // Page-scoped (pages moved in): only those pages' grants; the person has no member row or scopes there to take.
  const [member] = pageIds ? [] : await executor.select().from(driveMembers).where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId))).limit(1);
  const grants = await executor
    .select()
    .from(pagePermissions)
    .where(and(
      eq(pagePermissions.userId, userId),
      pageIds ? inArray(pagePermissions.pageId, pageIds) : inArray(pagePermissions.pageId, executor.select({ id: pages.id }).from(pages).where(eq(pages.driveId, driveId))),
    ));
  const tokenScopes = pageIds ? [] : (await executor
    .select({ scope: mcpTokenDrives })
    .from(mcpTokenDrives)
    .innerJoin(mcpTokens, eq(mcpTokens.id, mcpTokenDrives.tokenId))
    .where(and(eq(mcpTokenDrives.driveId, driveId), eq(mcpTokens.userId, userId), isNotNull(mcpTokenDrives.role)))).map((r) => r.scope);
  if (!member && grants.length === 0 && tokenScopes.length === 0) return null;

  let hold: OrgGuestHold;
  if (mode === 'suspend') {
    const [existing] = await executor
      .select()
      .from(orgGuestHolds)
      .where(and(eq(orgGuestHolds.driveId, driveId), eq(orgGuestHolds.userId, userId), eq(orgGuestHolds.state, 'suspended')))
      .limit(1);
    const parked: GuestHoldParked = {
      member: member ? asJson(member) as Record<string, unknown> : (existing?.parked?.member ?? null),
      grants: [...(existing?.parked?.grants ?? []), ...asJson(grants) as Array<Record<string, unknown>>],
      tokenScopes: [...(existing?.parked?.tokenScopes ?? []), ...asJson(tokenScopes) as Array<Record<string, unknown>>],
    };
    [hold] = existing
      ? await executor.update(orgGuestHolds).set({ parked }).where(eq(orgGuestHolds.id, existing.id)).returning()
      : await executor.insert(orgGuestHolds).values({ orgId, driveId, userId, state: 'suspended', origin: member ? 'invite' : 'page_grant', request: {}, parked }).returning();
  } else {
    hold = await queueHeldAccess(executor, { orgId, driveId, userId, member: member ?? null, grants, tokenScopes, requestedBy: null });
  }

  if (grants.length > 0) await executor.delete(pagePermissions).where(inArray(pagePermissions.id, grants.map((g) => g.id)));
  if (tokenScopes.length > 0) await executor.delete(mcpTokenDrives).where(inArray(mcpTokenDrives.id, tokenScopes.map((t) => t.id)));
  if (member) await executor.delete(driveMembers).where(eq(driveMembers.id, member.id));
  return toItem(hold);
}

/**
 * Take every outsider of the scope out of the live tables (see takeOutsider). Idempotent (a second run finds no
 * outsiders) and bounded (batches of GUEST_HOLD_BATCH). Call inside the transaction that made the change.
 */
export async function takeOrgGuests(executor: Executor, scope: GuestScope, mode: GuestTakeMode): Promise<GuestHoldItem[]> {
  const taken: GuestHoldItem[] = [];
  // Each pair is handled once: if a removal ever did not take, the loop must end rather than re-read it forever.
  const handled = new Set<string>();
  for (;;) {
    const pairs = new Map<string, Pair>();
    const found = scope.pageIds
      ? await grantOutsiders(executor, scope)
      : [...await memberOutsiders(executor, scope), ...await grantOutsiders(executor, scope), ...await tokenOutsiders(executor, scope)];
    for (const p of found) {
      const key = `${p.driveId}:${p.userId}`;
      if (!handled.has(key)) pairs.set(key, p);
    }
    if (pairs.size === 0) return taken;
    for (const [key, pair] of pairs) {
      handled.add(key);
      const item = await takeOutsider(executor, scope.orgId, pair, mode, scope.pageIds);
      if (item) taken.push(item);
    }
  }
}

/**
 * Park every guest of the org's drives: snapshot their member row, page grants and explicit-role token scopes into
 * a `suspended` hold, then remove them from the live tables. A guest whose only access is a page grant is parked the
 * same way, with `member: null`. Returns what it parked. Call inside the transaction that stored the policy.
 */
export const suspendOrgGuests = (executor: Executor, orgId: string): Promise<GuestHoldItem[]> => takeOrgGuests(executor, { orgId }, 'suspend');

/**
 * The org's guests policy as it stands, read under the org row's share lock (the writer holds it FOR UPDATE), for a
 * change that brings EXISTING access into the org's drives: a drive moved in, pages moved in, a member who left.
 * `on` leaves the access as it is; `off` parks it; `approve` queues it for an Owner or Admin.
 */
export async function holdOrgGuestsUnderPolicy(executor: Executor, scope: GuestScope): Promise<GuestHoldItem[]> {
  const { guests } = await getOrgPolicies(scope.orgId, executor, { forShare: true });
  if (guests === 'on') return [];
  return takeOrgGuests(executor, scope, guests === 'off' ? 'suspend' : 'queue');
}

/**
 * Queue access an outsider would get (or had) as ONE pending approval request per person and drive, origin
 * `page_grant`: their member row as it was, their page grants (merged with any already asked for, flags OR-ed, so
 * asking again never narrows the request) and their tokens' explicit-role scopes. Nothing is granted until an Owner
 * or Admin approves (completeApprovedPageGrant replays it).
 */
export async function queueHeldAccess(
  executor: Executor,
  input: {
    orgId: string;
    driveId: string;
    userId: string;
    member: Record<string, unknown> | null;
    grants: Array<{ pageId: string; canView: boolean; canEdit: boolean; canShare: boolean; canDelete: boolean; grantedBy?: string | null }>;
    tokenScopes?: Array<Record<string, unknown>>;
    requestedBy: string | null;
  },
): Promise<OrgGuestHold> {
  const { orgId, driveId, userId } = input;
  const [existing] = await executor
    .select()
    .from(orgGuestHolds)
    .where(and(eq(orgGuestHolds.driveId, driveId), eq(orgGuestHolds.userId, userId), eq(orgGuestHolds.state, 'pending_approval')))
    .limit(1);
  const before = existing?.request ?? {};
  const asked = input.grants.map((g) => ({ pageId: g.pageId, canView: g.canView, canEdit: g.canEdit, canShare: g.canShare, canDelete: g.canDelete }));
  const invitedBy = before.invitedBy ?? (input.member?.invitedBy as string | null | undefined) ?? input.grants[0]?.grantedBy ?? input.requestedBy ?? null;
  const request: GuestHoldRequest = {
    ...before,
    permissions: mergeGrants(before.permissions ?? [], asked),
    tokenScopes: [...(before.tokenScopes ?? []), ...asJson(input.tokenScopes ?? [])],
    member: input.member ? asJson(input.member) : (before.member ?? null),
    ...(invitedBy ? { invitedBy } : {}),
  };
  const [hold] = existing
    ? await executor.update(orgGuestHolds).set({ request, origin: 'page_grant' }).where(eq(orgGuestHolds.id, existing.id)).returning()
    : await executor.insert(orgGuestHolds).values({ orgId, driveId, userId, state: 'pending_approval', origin: 'page_grant', request, requestedBy: input.requestedBy }).returning();
  return hold;
}

export type ReentryDecision = { outcome: 'admit' } | { outcome: 'refused' } | { outcome: 'held'; holdId: string; orgId: string };

/**
 * POL-2 for a write that puts an outsider's access BACK (a backup restore, a rollback or redo of a grant or a member):
 * asked inside the write's transaction like every admission (decideOrgDriveAdmission). `admit` means write it;
 * `refused` (guests off) means skip it and report it; `held` (approve) means it was queued for an Owner or Admin
 * and must not be written. A grant for someone who already holds an accepted member row on the drive is an admitted
 * guest's, so it is written.
 */
export async function admitReentry(
  executor: Executor,
  input: {
    driveId: string;
    userId: string;
    member?: Record<string, unknown> | null;
    grants?: Array<{ pageId: string; canView: boolean; canEdit: boolean; canShare: boolean; canDelete: boolean; grantedBy?: string | null }>;
    requestedBy: string | null;
  },
): Promise<ReentryDecision> {
  const admission = await decideOrgDriveAdmission({ driveId: input.driveId, userId: input.userId }, executor);
  if (admission.decision === 'allow' || !admission.orgId) return { outcome: 'admit' };
  if (!input.member) {
    const [row] = await executor
      .select({ id: driveMembers.id })
      .from(driveMembers)
      .where(and(eq(driveMembers.driveId, input.driveId), eq(driveMembers.userId, input.userId), isNotNull(driveMembers.acceptedAt)))
      .limit(1);
    if (row) return { outcome: 'admit' };
  }
  if (admission.decision === 'refuse') return { outcome: 'refused' };
  const hold = await queueHeldAccess(executor, {
    orgId: admission.orgId,
    driveId: input.driveId,
    userId: input.userId,
    member: input.member ?? null,
    grants: input.grants ?? [],
    requestedBy: input.requestedBy,
  });
  return { outcome: 'held', holdId: hold.id, orgId: admission.orgId };
}

// ---------------------------------------------------------------------------
// Approved emailed invitations (Review #2762 P2-6)
// ---------------------------------------------------------------------------

/**
 * An Owner or Admin approved an outsider's emailed invitation and it was sent: remember it, so its acceptance under
 * `approve` admits the person instead of asking again. An invitation that was NOT approved (sent while guests were
 * on, or before the drive joined the org) has no such row and is queued at acceptance.
 */
export async function markApprovedInvitation(executor: Executor, input: { orgId: string; driveId: string; email: string; approvedBy: string }): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const [existing] = await executor
    .select({ id: orgGuestHolds.id })
    .from(orgGuestHolds)
    .where(and(eq(orgGuestHolds.driveId, input.driveId), sql`lower(${orgGuestHolds.email}) = ${email}`, eq(orgGuestHolds.state, 'approved')))
    .limit(1);
  if (existing) return;
  await executor.insert(orgGuestHolds).values({ orgId: input.orgId, driveId: input.driveId, email, state: 'approved', origin: 'invite', request: {}, requestedBy: input.approvedBy });
}

/** Consume the approval of an emailed invitation to `driveId` for `email`; true when there was one. */
export async function consumeApprovedInvitation(executor: Executor, input: { driveId: string; email: string }): Promise<boolean> {
  const email = input.email.trim().toLowerCase();
  const rows = await executor
    .delete(orgGuestHolds)
    .where(and(eq(orgGuestHolds.driveId, input.driveId), sql`lower(${orgGuestHolds.email}) = ${email}`, eq(orgGuestHolds.state, 'approved')))
    .returning({ id: orgGuestHolds.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Restore (policy back on)
// ---------------------------------------------------------------------------

/** Ids among `ids` that still exist in `table`. */
async function existing(executor: Executor, table: typeof users | typeof driveRoles | typeof mcpTokens, ids: Array<string | null | undefined>): Promise<Set<string>> {
  const want = [...new Set(ids.filter((v): v is string => typeof v === 'string'))];
  if (want.length === 0) return new Set();
  const rows = await executor.select({ id: table.id }).from(table).where(inArray(table.id, want));
  return new Set(rows.map((r) => r.id));
}

/**
 * A parked row's references may have gone while it was out of the live tables, where ON DELETE never reached it
 * (Review #2762 P2-1: a deleted sharer made every restore fail on grantedBy's foreign key and wedged the org). The
 * live rows would have had them set to NULL, so the snapshot gets the same.
 */
const nullIfGone = <T extends Record<string, unknown>>(row: T, column: keyof T, alive: Set<string>): T =>
  typeof row[column] === 'string' && !alive.has(row[column] as string) ? { ...row, [column]: null } : row;

/**
 * Re-insert a held person's snapshot onto `driveId` in the live tables: the member row, the grants whose page is
 * still in THAT drive (a page moved elsewhere while held does not take the grant with it), and the token scopes
 * whose token still exists. A row that exists again (the person came back some other way) is left as it is.
 */
export async function reinsertHeldAccess(
  executor: Executor,
  driveId: string,
  snapshot: { member?: Record<string, unknown> | null; grants?: Array<Record<string, unknown>>; tokenScopes?: Array<Record<string, unknown>> },
): Promise<{ grants: number }> {
  const member = snapshot.member ? revive(snapshot.member as typeof driveMembers.$inferInsert, MEMBER_DATE_COLUMNS) : null;
  const grants = (snapshot.grants ?? []).map((g) => revive(g as typeof pagePermissions.$inferInsert, GRANT_DATE_COLUMNS));
  const scopes = (snapshot.tokenScopes ?? []).map((t) => revive(t as typeof mcpTokenDrives.$inferInsert, ['createdAt']));
  const liveUsers = await existing(executor, users, [member?.invitedBy, ...grants.map((g) => g.grantedBy), ...scopes.map((t) => t.addedBy)]);
  const liveRoles = await existing(executor, driveRoles, [member?.customRoleId, ...scopes.map((t) => t.customRoleId)]);
  if (member) {
    const row = nullIfGone(nullIfGone(member, 'invitedBy', liveUsers), 'customRoleId', liveRoles);
    await executor.insert(driveMembers).values({ ...row, driveId }).onConflictDoNothing({ target: [driveMembers.driveId, driveMembers.userId] });
  }
  let restored = 0;
  for (let i = 0; i < grants.length; i += GUEST_HOLD_BATCH) {
    const chunk = grants.slice(i, i + GUEST_HOLD_BATCH);
    const inDrive = new Set((await executor.select({ id: pages.id }).from(pages).where(and(inArray(pages.id, chunk.map((g) => g.pageId)), eq(pages.driveId, driveId)))).map((p) => p.id));
    const insertable = chunk.filter((g) => inDrive.has(g.pageId)).map((g) => nullIfGone(g, 'grantedBy', liveUsers));
    if (insertable.length > 0) await executor.insert(pagePermissions).values(insertable).onConflictDoNothing({ target: [pagePermissions.pageId, pagePermissions.userId] });
    restored += insertable.length;
  }
  if (scopes.length > 0) {
    const liveTokens = await existing(executor, mcpTokens, scopes.map((t) => t.tokenId));
    const insertable = scopes.filter((t) => liveTokens.has(t.tokenId)).map((t) => nullIfGone(nullIfGone({ ...t, driveId }, 'addedBy', liveUsers), 'customRoleId', liveRoles));
    if (insertable.length > 0) await executor.insert(mcpTokenDrives).values(insertable).onConflictDoNothing({ target: [mcpTokenDrives.tokenId, mcpTokenDrives.driveId] });
  }
  return { grants: restored };
}

/**
 * Restore every suspended guest whose drive still belongs to the org: re-insert what was parked (reinsertHeldAccess),
 * then drop the hold. A hold whose drive LEFT the org stays parked: the policy was about org content, so the person
 * does not regain access on a drive the org no longer owns (fail closed; the org Owner still lists it).
 */
export async function restoreOrgGuests(executor: Executor, orgId: string): Promise<GuestHoldItem[]> {
  const restored: GuestHoldItem[] = [];
  const handled = new Set<string>();
  for (;;) {
    const holds = (await executor
      .select()
      .from(orgGuestHolds)
      .where(and(
        eq(orgGuestHolds.orgId, orgId),
        eq(orgGuestHolds.state, 'suspended'),
        inArray(orgGuestHolds.driveId, scopeDriveIds(executor, { orgId })),
      ))
      .orderBy(asc(orgGuestHolds.id))
      .limit(GUEST_HOLD_BATCH)).filter((h) => !handled.has(h.id));
    if (holds.length === 0) return restored;
    for (const hold of holds) {
      handled.add(hold.id);
      await reinsertHeldAccess(executor, hold.driveId, hold.parked ?? {});
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
      request: { role: req.role ?? null, pageGrants: req.permissions?.length ?? (req.pageId ? 1 : 0), viaLink: r.hold.origin === 'drive_link' || r.hold.origin === 'page_link' },
    });
  }
  return { total: counted?.total ?? 0, items };
}
