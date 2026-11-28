import { db } from '@pagespace/db/db';
import { and, isNull, notInArray, or, type SQL } from '@pagespace/db/operators';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';
import { filterDrivesForActor, filterResourcesForActor } from '@pagespace/lib/permissions/actor-authentication';
import { refusedDerivedPages } from '@pagespace/lib/permissions/org-derived-content';

/**
 * SEC-2/3 (D-OW-45, D-OW-62) for activity rows: the extra condition that leaves out every row the actor's credential may
 * not read — rows on an org drive whose sign-in policy refuses it, and rows on a page restating org-derived content (a
 * memory page) a contributing org withholds from it. The same per-page decision the activity AI tool makes
 * (canActorViewPage), taken once over the rows `scope` selects so it can sit in the SQL and keep pagination and counts
 * exact. Shared by GET /api/activities and /api/activities/export. Undefined when nothing is left out.
 */
export async function activitySignInCondition(actor: AccessActor, scope: SQL | undefined): Promise<SQL | undefined> {
  const sources = await db.selectDistinct({ driveId: activityLogs.driveId, pageId: activityLogs.pageId }).from(activityLogs).where(scope);

  const driveIds = [...new Set(sources.flatMap((s) => (s.driveId ? [s.driveId] : [])))];
  const allowedDrives = await filterDrivesForActor(actor, driveIds);
  const refusedDrives = driveIds.filter((id) => !allowedDrives.has(id));

  const pageIds = [...new Set(sources.flatMap((s) => (s.pageId ? [s.pageId] : [])))];
  const withheld = new Set((await refusedDerivedPages(actor, pageIds)).keys());
  // A row that names a page but no drive is decided by the page itself (its drive's policy and derived content).
  const pagesWithoutDrive = [...new Set(sources.flatMap((s) => (s.pageId && !s.driveId ? [s.pageId] : [])))];
  const readable = await filterResourcesForActor(actor, pagesWithoutDrive);
  for (const id of pagesWithoutDrive) if (!readable.has(id)) withheld.add(id);

  const conditions: SQL[] = [];
  if (refusedDrives.length > 0) {
    const kept = or(isNull(activityLogs.driveId), notInArray(activityLogs.driveId, refusedDrives));
    if (kept) conditions.push(kept);
  }
  if (withheld.size > 0) {
    const kept = or(isNull(activityLogs.pageId), notInArray(activityLogs.pageId, [...withheld]));
    if (kept) conditions.push(kept);
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}
