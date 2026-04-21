/**
 * App-shell server fetcher.
 *
 * Loads the full payload a Server Component needs on initial page render in ONE
 * Postgres transaction:
 *   - The current user
 *   - The user's connection list (cross-workspace)
 *   - All accessible (non-trashed) drives with the caller's role per drive
 *   - Drive-member rows for those drives
 *   - The active workspace's full page tree (when activeDriveId is provided)
 *   - The current page's PagePayload (when currentPageId is provided)
 *
 * Future Server Components will call `loadAppShell(userId, context)` once and
 * hand the result to the client store via `<EcsProvider initialPayload={...}>`.
 * Today, this fetcher is purely additive — no existing route consumes it.
 *
 * Composition notes:
 *   - "Shell" drive visibility is owner ∪ accepted-member ONLY. A user with a
 *     single explicit page-permission grant in a drive they don't belong to
 *     does NOT see that drive in the shell — surfacing drive metadata or the
 *     drive's member list to a non-member would leak data, and member-list
 *     endpoints elsewhere enforce the same owner/member gate. Page-level reads
 *     (loadPagePayload, activeDrive.tree) still go through
 *     accessible_page_ids_for_user, which accepts explicit grants, so pages a
 *     user has been explicitly granted remain reachable — just not via the
 *     shell's drive summaries / member list.
 *   - Page tree fetching mirrors the AI module's `queryDriveTree` shape so the
 *     hydration target matches what the existing tree-utils helpers expect.
 *   - Per-page-type context loading delegates to `loadPagePayload` for shape
 *     reuse; the payload services compose, they don't duplicate.
 */
import {
  db,
  drives,
  driveMembers,
  pages,
  users,
  connections,
  and,
  eq,
  or,
  inArray,
  isNotNull,
  asc,
} from '@pagespace/db';
import type {
  AppShell,
  AppShellContext,
  AppShellUser,
  ConnectionSummary,
  DriveMemberSummary,
  DriveSummary,
  PageTreeNode,
} from '../types';
import { PageType } from '../utils/enums';
import { loadPagePayload } from './page-payload-service';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function toIsoRequired(value: Date): string {
  return value.toISOString();
}

async function fetchUser(tx: Tx, userId: string): Promise<AppShellUser> {
  const rows = await tx
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      role: users.role,
      subscriptionTier: users.subscriptionTier,
      timezone: users.timezone,
      currentAiProvider: users.currentAiProvider,
      currentAiModel: users.currentAiModel,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`loadAppShell: user not found (id=${userId})`);
  }

  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
    role: row.role,
    subscriptionTier: row.subscriptionTier,
    timezone: row.timezone,
    currentAiProvider: row.currentAiProvider,
    currentAiModel: row.currentAiModel,
  };
}

async function fetchConnections(tx: Tx, userId: string): Promise<ConnectionSummary[]> {
  const rows = await tx
    .select({
      id: connections.id,
      user1Id: connections.user1Id,
      user2Id: connections.user2Id,
      status: connections.status,
      requestedBy: connections.requestedBy,
      requestedAt: connections.requestedAt,
      acceptedAt: connections.acceptedAt,
    })
    .from(connections)
    .where(or(eq(connections.user1Id, userId), eq(connections.user2Id, userId)));

  return rows.map((row) => {
    const peerUserId = row.user1Id === userId ? row.user2Id : row.user1Id;
    return {
      id: row.id,
      peerUserId,
      status: row.status,
      initiatedByCaller: row.requestedBy === userId,
      requestedAt: toIsoRequired(row.requestedAt),
      acceptedAt: toIso(row.acceptedAt),
    };
  });
}

async function fetchShellDriveIds(tx: Tx, userId: string): Promise<Set<string>> {
  // Drives surfaced by the app shell = drives the user belongs to (owner or
  // accepted member of any role). Drives reached only via an explicit page
  // grant are NOT promoted here: their metadata and member list would leak to
  // non-members, and existing member-list endpoints require the same
  // owner/member gate.
  const ids = new Set<string>();

  const owned = await tx
    .select({ id: drives.id })
    .from(drives)
    .where(and(eq(drives.ownerId, userId), eq(drives.isTrashed, false)));
  for (const row of owned) ids.add(row.id);

  const memberOf = await tx
    .selectDistinct({ driveId: driveMembers.driveId })
    .from(driveMembers)
    .innerJoin(drives, eq(drives.id, driveMembers.driveId))
    .where(
      and(
        eq(driveMembers.userId, userId),
        isNotNull(driveMembers.acceptedAt),
        eq(drives.isTrashed, false),
      ),
    );
  for (const row of memberOf) ids.add(row.driveId);

  return ids;
}

async function fetchDriveSummaries(
  tx: Tx,
  userId: string,
  driveIds: string[],
): Promise<DriveSummary[]> {
  if (driveIds.length === 0) return [];

  const driveRows = await tx
    .select({
      id: drives.id,
      name: drives.name,
      slug: drives.slug,
      ownerId: drives.ownerId,
      drivePrompt: drives.drivePrompt,
      isTrashed: drives.isTrashed,
      createdAt: drives.createdAt,
      updatedAt: drives.updatedAt,
      trashedAt: drives.trashedAt,
    })
    .from(drives)
    .where(inArray(drives.id, driveIds));

  const memberRows = await tx
    .select({
      driveId: driveMembers.driveId,
      role: driveMembers.role,
      lastAccessedAt: driveMembers.lastAccessedAt,
    })
    .from(driveMembers)
    .where(and(eq(driveMembers.userId, userId), inArray(driveMembers.driveId, driveIds)));

  const callerRoleByDrive = new Map<string, 'OWNER' | 'ADMIN' | 'MEMBER'>();
  const lastAccessedByDrive = new Map<string, Date | null>();
  for (const row of memberRows) {
    callerRoleByDrive.set(row.driveId, row.role as 'OWNER' | 'ADMIN' | 'MEMBER');
    lastAccessedByDrive.set(row.driveId, row.lastAccessedAt);
  }

  return driveRows.map((row): DriveSummary => {
    const isOwned = row.ownerId === userId;
    const role: 'OWNER' | 'ADMIN' | 'MEMBER' = isOwned
      ? 'OWNER'
      : callerRoleByDrive.get(row.id) ?? 'MEMBER';
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      ownerId: row.ownerId,
      drivePrompt: row.drivePrompt,
      isOwned,
      role,
      isTrashed: row.isTrashed,
      createdAt: toIsoRequired(row.createdAt),
      updatedAt: toIsoRequired(row.updatedAt),
      trashedAt: toIso(row.trashedAt),
      lastAccessedAt: toIso(lastAccessedByDrive.get(row.id) ?? null),
    };
  });
}

async function fetchDriveMembers(
  tx: Tx,
  driveIds: string[],
): Promise<DriveMemberSummary[]> {
  if (driveIds.length === 0) return [];

  const rows = await tx
    .select({
      id: driveMembers.id,
      driveId: driveMembers.driveId,
      userId: driveMembers.userId,
      role: driveMembers.role,
      invitedAt: driveMembers.invitedAt,
      acceptedAt: driveMembers.acceptedAt,
    })
    .from(driveMembers)
    .where(inArray(driveMembers.driveId, driveIds));

  return rows.map((row) => ({
    id: row.id,
    driveId: row.driveId,
    userId: row.userId,
    role: row.role as 'OWNER' | 'ADMIN' | 'MEMBER',
    invitedAt: toIsoRequired(row.invitedAt),
    acceptedAt: toIso(row.acceptedAt),
  }));
}

async function fetchDriveTree(tx: Tx, driveId: string): Promise<PageTreeNode[]> {
  const rows = await tx
    .select({
      id: pages.id,
      title: pages.title,
      type: pages.type,
      parentId: pages.parentId,
      position: pages.position,
    })
    .from(pages)
    .where(and(eq(pages.driveId, driveId), eq(pages.isTrashed, false)))
    .orderBy(asc(pages.position));

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    type: row.type as PageType,
    parentId: row.parentId,
    position: row.position,
  }));
}

export async function loadAppShell(
  userId: string,
  context: AppShellContext = {},
): Promise<AppShell> {
  if (!userId) {
    throw new Error('loadAppShell: userId is required');
  }

  return await db.transaction(async (tx) => {
    const user = await fetchUser(tx, userId);
    const connectionList = await fetchConnections(tx, userId);
    const driveIdSet = await fetchShellDriveIds(tx, userId);
    const driveIds = Array.from(driveIdSet);

    const [drivesList, driveMemberList] = await Promise.all([
      fetchDriveSummaries(tx, userId, driveIds),
      fetchDriveMembers(tx, driveIds),
    ]);

    let activeDrive: AppShell['activeDrive'];
    if (context.activeDriveId && driveIdSet.has(context.activeDriveId)) {
      const tree = await fetchDriveTree(tx, context.activeDriveId);
      activeDrive = { driveId: context.activeDriveId, tree };
    }

    let currentPage: AppShell['currentPage'];
    if (context.currentPageId) {
      currentPage = await loadPagePayload(userId, context.currentPageId, tx);
    }

    return {
      user,
      connections: connectionList,
      drives: drivesList,
      driveMembers: driveMemberList,
      activeDrive,
      currentPage,
      generatedAt: new Date().toISOString(),
    };
  });
}
