/**
 * [D-OW-28] Which environments' and apps' cost owners can no longer reach the drive they are
 * attributed in (review #2760 P3-4) — the access half of the removed-creator sweep
 * (organizations/creator-reattribution), decided here with the org-aware membership answer.
 *
 * Org drives only, and only while orgs are enabled: a personal drive's compute is its owner's own
 * wallet whoever created it, and a dark deployment has no org layer to consult. The drive's lead is
 * never "outside" their own drive.
 */
import { db } from '@pagespace/db/db';
import { and, eq, isNotNull, ne } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';
import { loadEffectiveDriveMembership } from './org-drive-membership';

export interface CostOwnerOutsideDrive {
  driveId: string;
  orgId: string;
  costOwnerId: string;
}

export async function listCostOwnersOutsideTheirDrive(): Promise<CostOwnerOutsideDrive[]> {
  if (!ORGS_ENABLED) return [];
  const cols = { orgId: drives.orgId, ownerId: drives.ownerId, orgVisibility: drives.orgVisibility };
  const envPairs = await db
    .selectDistinct({ driveId: driveEnvs.driveId, costOwnerId: driveEnvs.costOwnerId, ...cols })
    .from(driveEnvs)
    .innerJoin(drives, eq(drives.id, driveEnvs.driveId))
    .where(and(isNotNull(driveEnvs.costOwnerId), isNotNull(drives.orgId), ne(drives.ownerId, driveEnvs.costOwnerId)));
  const appPairs = await db
    .selectDistinct({ driveId: publishedApps.driveId, costOwnerId: publishedApps.costOwnerId, ...cols })
    .from(publishedApps)
    .innerJoin(drives, eq(drives.id, publishedApps.driveId))
    .where(and(isNotNull(publishedApps.costOwnerId), isNotNull(drives.orgId), ne(drives.ownerId, publishedApps.costOwnerId)));

  const seen = new Set<string>();
  const outside: CostOwnerOutsideDrive[] = [];
  for (const p of [...envPairs, ...appPairs]) {
    if (p.costOwnerId === null || p.orgId === null) continue;
    const key = `${p.driveId}\u0000${p.costOwnerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const drive = { id: p.driveId, ownerId: p.ownerId, orgId: p.orgId, orgVisibility: p.orgVisibility };
    // A sweep, not an access: it writes no org-admin access audit.
    if ((await loadEffectiveDriveMembership(p.costOwnerId, drive, { audit: false })) === null) {
      outside.push({ driveId: p.driveId, orgId: p.orgId, costOwnerId: p.costOwnerId });
    }
  }
  return outside;
}
