/**
 * [D-OW-28] An environment or published app whose CREATOR can no longer reach its drive is handed
 * to the drive's lead (review #2760 P3-4).
 *
 * Leaving the org re-attributes at once (leaveOrganization). A creator removed from ONE drive while
 * staying in the org is the other way out, and it has many doors — an explicit removal, a role
 * change, an OPEN drive turned closed, a guest hold, a sync — so rather than hook each one, this
 * sweep asks the one question that matters for every env and app with a cost owner: is that person
 * still an effective member of the drive (permissions/cost-owners-outside-drive, the org-aware answer)?
 * If not, its cost owner is cleared — the drive lead's cap carries it from then on, exactly as on a
 * departure — and `org.compute.reattributed` is audited with `reason: removed_from_drive`.
 *
 * Run hourly by the period sweep, BEFORE the member-cap un-park, so an app parked on a removed
 * creator's cap is judged against the lead's from the same tick. Only while orgs are enabled and
 * only for org drives: a personal drive's compute is its owner's wallet whoever created it, and a
 * dark deployment's membership answer has no org layer to consult. Never throws.
 */
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { loggers } from '../logging/logger-config';
import { errorLogFields } from '../logging/error-cause';
import { listCostOwnersOutsideTheirDrive, type CostOwnerOutsideDrive } from '../permissions/cost-owners-outside-drive';
import { ORGS_ENABLED } from './orgs-enabled';
import { recordComputeReattributions, type ComputeReattribution } from './leave';

export interface ReattributeRemovedCreatorsResult {
  outcome: 'disabled' | 'swept';
  /** (drive, cost owner) pairs whose cost owner is outside the drive. */
  examined: number;
  /** Envs and apps handed to the drive lead. */
  reattributed: number;
  failed: number;
}

export async function reattributeRemovedCreators(): Promise<ReattributeRemovedCreatorsResult> {
  const result: ReattributeRemovedCreatorsResult = { outcome: 'swept', examined: 0, reattributed: 0, failed: 0 };
  if (!ORGS_ENABLED) return { ...result, outcome: 'disabled' };

  let pairs: CostOwnerOutsideDrive[];
  try {
    pairs = await listCostOwnersOutsideTheirDrive();
  } catch (error) {
    result.failed += 1;
    loggers.api.error('Creator re-attribution sweep could not list attributed envs and apps', undefined, errorLogFields(error));
    return result;
  }

  result.examined = pairs.length;
  for (const pair of pairs) {
    try {
      const items: ComputeReattribution[] = await db.transaction(async (tx) => {
        const envRows = await tx
          .update(driveEnvs)
          .set({ costOwnerId: null })
          .where(and(eq(driveEnvs.driveId, pair.driveId), eq(driveEnvs.costOwnerId, pair.costOwnerId)))
          .returning({ id: driveEnvs.id });
        const appRows = await tx
          .update(publishedApps)
          .set({ costOwnerId: null })
          .where(and(eq(publishedApps.driveId, pair.driveId), eq(publishedApps.costOwnerId, pair.costOwnerId)))
          .returning({ id: publishedApps.id });
        const base = { orgId: pair.orgId, driveId: pair.driveId, formerCostOwnerId: pair.costOwnerId, reason: 'removed_from_drive' as const };
        return [
          ...envRows.map((r) => ({ ...base, kind: 'drive_env' as const, id: r.id })),
          ...appRows.map((r) => ({ ...base, kind: 'published_app' as const, id: r.id })),
        ];
      });
      result.reattributed += items.length;
      // After commit: a rolled-back update never leaves an event behind.
      await recordComputeReattributions(items);
    } catch (error) {
      result.failed += 1;
      loggers.api.error('Creator re-attribution failed for one drive member — retried next sweep', undefined, {
        driveId: pair.driveId,
        ...errorLogFields(error),
      });
    }
  }
  return result;
}
