import { db } from '@pagespace/db/db';
import { eq, and, inArray } from '@pagespace/db/operators';
import { calendarEvents, calendarEventDrives } from '@pagespace/db/schema/calendar';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { isDriveOwnerOrAdmin, isUserDriveMember } from '../permissions/permissions';
import { getDriveMemberUserIds } from './drive-member-service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceFailure = { ok: false; status: number; error: string };

export interface EventDriveEntry {
  driveId: string;
  driveName: string;
  driveSlug: string;
  isHome: boolean;
  sharedAt: Date | null;
  sharedBy: string | null;
}

// ---------------------------------------------------------------------------
// Pure validation functions — zero I/O, all context pre-fetched by caller
// ---------------------------------------------------------------------------

/**
 * Pure guard for shareEventWithDrive.
 * All permission data is passed in as plain values — no DB calls inside.
 */
export function validateShareEventInput(input: {
  actingUserId: string;
  event: { id: string; driveId: string | null; createdById: string; isTrashed: boolean };
  targetDriveId: string;
  actingUserIsHomeDriveAdmin: boolean;
  actingUserIsTargetDriveMember: boolean;
}): { ok: true } | ServiceFailure {
  const { actingUserId, event, targetDriveId, actingUserIsHomeDriveAdmin, actingUserIsTargetDriveMember } = input;

  if (event.isTrashed) {
    return { ok: false, status: 404, error: 'Event not found' };
  }
  if (!event.driveId) {
    return { ok: false, status: 400, error: 'Personal events cannot be shared with drives' };
  }
  if (targetDriveId === event.driveId) {
    return { ok: false, status: 400, error: 'Cannot share event with its home drive' };
  }
  if (actingUserId !== event.createdById && !actingUserIsHomeDriveAdmin) {
    return { ok: false, status: 403, error: 'You do not have permission to share this event' };
  }
  if (!actingUserIsTargetDriveMember) {
    return { ok: false, status: 400, error: 'You are not a member of the target drive' };
  }
  return { ok: true };
}

/**
 * Pure guard for unshareEventFromDrive.
 * All permission data is passed in as plain values — no DB calls inside.
 */
export function validateUnshareEventInput(input: {
  actingUserId: string;
  event: { id: string; driveId: string | null; createdById: string; isTrashed: boolean };
  targetDriveId: string;
  actingUserIsHomeDriveAdmin: boolean;
  actingUserIsTargetDriveAdmin: boolean;
  junctionRowExists: boolean;
}): { ok: true } | ServiceFailure {
  const { actingUserId, event, targetDriveId, actingUserIsHomeDriveAdmin, actingUserIsTargetDriveAdmin, junctionRowExists } = input;

  if (event.isTrashed) {
    return { ok: false, status: 404, error: 'Event not found' };
  }
  if (targetDriveId === event.driveId) {
    return { ok: false, status: 400, error: 'Cannot remove the home drive from an event' };
  }
  if (!junctionRowExists) {
    return { ok: false, status: 404, error: 'Event is not shared with this drive' };
  }
  const canManage =
    actingUserId === event.createdById ||
    actingUserIsHomeDriveAdmin ||
    actingUserIsTargetDriveAdmin;
  if (!canManage) {
    return { ok: false, status: 403, error: 'You do not have permission to remove this drive share' };
  }
  return { ok: true };
}

/**
 * Pure membership predicate.
 * Short-circuits on home drive match — avoids iterating shared sets unnecessarily.
 */
export function isUserInAnyDriveSet(
  userId: string,
  homeDriveMembers: Set<string>,
  sharedDriveMembers: Set<string>[],
): boolean {
  if (homeDriveMembers.has(userId)) return true;
  return sharedDriveMembers.some((s) => s.has(userId));
}

// ---------------------------------------------------------------------------
// DB effect: thin insert/delete wrappers — no validation logic
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertCalendarEventDrive(
  executor: Tx | typeof db,
  input: { eventId: string; driveId: string; sharedBy: string },
) {
  const [row] = await executor
    .insert(calendarEventDrives)
    .values(input)
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Orchestrators: fetch context → pure validation → effect
// ---------------------------------------------------------------------------

/**
 * Share a calendar event with an additional drive.
 * Triggers on the event remain bound to the home drive (calendarEvents.driveId).
 */
export async function shareEventWithDrive(input: {
  actingUserId: string;
  eventId: string;
  driveId: string;
}): Promise<{ ok: true; status: 201; row: typeof calendarEventDrives.$inferSelect } | ServiceFailure> {
  const { actingUserId, eventId, driveId } = input;

  const [event] = await db
    .select({ id: calendarEvents.id, driveId: calendarEvents.driveId, createdById: calendarEvents.createdById, isTrashed: calendarEvents.isTrashed })
    .from(calendarEvents)
    .where(eq(calendarEvents.id, eventId))
    .limit(1);

  if (!event) return { ok: false, status: 404, error: 'Event not found' };
  if (!event.driveId) return { ok: false, status: 400, error: 'Personal events cannot be shared with drives' };
  if (driveId === event.driveId) return { ok: false, status: 400, error: 'Cannot share event with its home drive' };

  const [actingUserIsHomeDriveAdmin, actingUserIsTargetDriveMember] = await Promise.all([
    isDriveOwnerOrAdmin(actingUserId, event.driveId),
    isUserDriveMember(actingUserId, driveId),
  ]);

  const validation = validateShareEventInput({
    actingUserId,
    event,
    targetDriveId: driveId,
    actingUserIsHomeDriveAdmin,
    actingUserIsTargetDriveMember,
  });
  if (!validation.ok) return validation;

  try {
    const row = await insertCalendarEventDrive(db, { eventId, driveId, sharedBy: actingUserId });
    return { ok: true, status: 201, row };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return { ok: false, status: 409, error: 'Event is already shared with this drive' };
    }
    throw err;
  }
}

/**
 * Remove a drive from an event's shared-drive list.
 * The home drive (calendarEvents.driveId) cannot be removed.
 */
export async function unshareEventFromDrive(input: {
  actingUserId: string;
  eventId: string;
  driveId: string;
}): Promise<{ ok: true; status: 200 } | ServiceFailure> {
  const { actingUserId, eventId, driveId } = input;

  const [event] = await db
    .select({ id: calendarEvents.id, driveId: calendarEvents.driveId, createdById: calendarEvents.createdById, isTrashed: calendarEvents.isTrashed })
    .from(calendarEvents)
    .where(eq(calendarEvents.id, eventId))
    .limit(1);

  if (!event) return { ok: false, status: 404, error: 'Event not found' };
  if (driveId === event.driveId) return { ok: false, status: 400, error: 'Cannot remove the home drive from an event' };

  const [actingUserIsHomeDriveAdmin, actingUserIsTargetDriveAdmin, [junctionRow]] = await Promise.all([
    event.driveId ? isDriveOwnerOrAdmin(actingUserId, event.driveId) : Promise.resolve(false),
    isDriveOwnerOrAdmin(actingUserId, driveId),
    db.select({ id: calendarEventDrives.id })
      .from(calendarEventDrives)
      .where(and(eq(calendarEventDrives.eventId, eventId), eq(calendarEventDrives.driveId, driveId)))
      .limit(1),
  ]);

  const validation = validateUnshareEventInput({
    actingUserId,
    event,
    targetDriveId: driveId,
    actingUserIsHomeDriveAdmin,
    actingUserIsTargetDriveAdmin,
    junctionRowExists: !!junctionRow,
  });
  if (!validation.ok) return validation;

  await db.delete(calendarEventDrives).where(
    and(eq(calendarEventDrives.eventId, eventId), eq(calendarEventDrives.driveId, driveId)),
  );

  return { ok: true, status: 200 };
}

/**
 * List all drives an event is shared with.
 * Home drive (isHome:true) is always first, synthesized from calendarEvents.driveId.
 * Returns [] for personal events (driveId null).
 */
export async function listEventDrives(eventId: string): Promise<EventDriveEntry[]> {
  const [event] = await db
    .select({ driveId: calendarEvents.driveId })
    .from(calendarEvents)
    .where(eq(calendarEvents.id, eventId))
    .limit(1);

  if (!event?.driveId) return [];

  const [homeDrive, sharedRows] = await Promise.all([
    db.select({ id: drives.id, name: drives.name, slug: drives.slug })
      .from(drives)
      .where(eq(drives.id, event.driveId))
      .limit(1)
      .then(([r]) => r ?? null),
    db.select({
      driveId: calendarEventDrives.driveId,
      sharedBy: calendarEventDrives.sharedBy,
      sharedAt: calendarEventDrives.sharedAt,
      driveName: drives.name,
      driveSlug: drives.slug,
    })
      .from(calendarEventDrives)
      .innerJoin(drives, eq(calendarEventDrives.driveId, drives.id))
      .where(eq(calendarEventDrives.eventId, eventId)),
  ]);

  const result: EventDriveEntry[] = [];

  if (homeDrive) {
    result.push({
      driveId: homeDrive.id,
      driveName: homeDrive.name,
      driveSlug: homeDrive.slug,
      isHome: true,
      sharedAt: null,
      sharedBy: null,
    });
  }

  for (const row of sharedRows) {
    result.push({
      driveId: row.driveId,
      driveName: row.driveName,
      driveSlug: row.driveSlug,
      isHome: false,
      sharedAt: row.sharedAt,
      sharedBy: row.sharedBy ?? null,
    });
  }

  return result;
}

/**
 * Check if a user is a member of the event's home drive OR any shared drive.
 * Fast-path: skips junction query if home-drive membership is confirmed first.
 */
export async function isUserMemberOfAnyEventDrive(
  userId: string,
  event: { id: string; driveId: string | null },
): Promise<boolean> {
  if (!event.driveId) return false;

  const homeDriveMembers = new Set(await getDriveMemberUserIds(event.driveId));
  if (isUserInAnyDriveSet(userId, homeDriveMembers, [])) return true;

  const sharedRows = await db
    .select({ driveId: calendarEventDrives.driveId })
    .from(calendarEventDrives)
    .where(eq(calendarEventDrives.eventId, event.id));

  if (sharedRows.length === 0) return false;

  const sharedMemberSets = await Promise.all(
    sharedRows.map((r) => getDriveMemberUserIds(r.driveId).then((ids) => new Set(ids))),
  );

  return isUserInAnyDriveSet(userId, homeDriveMembers, sharedMemberSets);
}

/**
 * Return the union of all member user IDs across the home drive and all shared drives.
 * Uses a single batched query for shared-drive members — not N+1.
 */
export async function getAllMemberUserIdsForEvent(
  eventId: string,
  homeDriveId: string | null,
): Promise<Set<string>> {
  if (!homeDriveId) return new Set();

  const [homeMembers, sharedRows] = await Promise.all([
    getDriveMemberUserIds(homeDriveId),
    db.select({ driveId: calendarEventDrives.driveId })
      .from(calendarEventDrives)
      .where(eq(calendarEventDrives.eventId, eventId)),
  ]);

  const result = new Set(homeMembers);

  if (sharedRows.length > 0) {
    const sharedDriveIds = sharedRows.map((r) => r.driveId);
    const sharedMembers = await db
      .select({ userId: driveMembers.userId })
      .from(driveMembers)
      .where(inArray(driveMembers.driveId, sharedDriveIds));
    for (const { userId } of sharedMembers) result.add(userId);
  }

  return result;
}

/**
 * Return [homeDriveId, ...sharedDriveIds] for broadcast fan-out.
 * Home drive is always first. Deduplicates in case of accidental junction row for home drive.
 */
export async function getAllDriveIdsForEvent(eventId: string): Promise<string[]> {
  const [event] = await db
    .select({ driveId: calendarEvents.driveId })
    .from(calendarEvents)
    .where(eq(calendarEvents.id, eventId))
    .limit(1);

  if (!event?.driveId) return [];

  const sharedRows = await db
    .select({ driveId: calendarEventDrives.driveId })
    .from(calendarEventDrives)
    .where(eq(calendarEventDrives.eventId, eventId));

  const seen = new Set([event.driveId]);
  const result = [event.driveId];
  for (const { driveId } of sharedRows) {
    if (!seen.has(driveId)) {
      seen.add(driveId);
      result.push(driveId);
    }
  }
  return result;
}
