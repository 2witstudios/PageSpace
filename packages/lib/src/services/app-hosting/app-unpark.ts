/**
 * app-unpark — the way back OUT of `parked` for a credit-parked app (review 5407898542 P1).
 *
 * Parking is enforcement, not a fault, and a park the system cannot undo is a deletion by another
 * name. Two doors, one rule:
 *
 *  - AUTOMATIC ({@link releaseMemberCapParks}): an app parked because its creator's allowance of the
 *    org's credits ran out ([D-OW-28], `parked: org_member_cap_reached`) is released when that
 *    allowance has room again — at the pool refill (D-OW-12: the seat period IS the pool period), or
 *    at midnight UTC for a daily cap, or when an Owner/Admin raises the cap. Run by the hourly period
 *    sweep (C5), right after the periods roll. ONLY that reason: an insolvency park, a daily-awake-
 *    budget park (the idle reaper's own sweep) and an app whose org has turned published apps off
 *    (POL-10) are never released here. POL-10 is a separate state, not a park — it is asked at every
 *    wake — and an app it refuses stays parked through a cap reset, so a policy flip can never be
 *    undone by the money clock.
 *  - MANUAL ({@link unparkPublishedApp}): the creator, the drive lead or an org Owner/Admin
 *    (permissions/app-unpark-authority), any credit park, audited `org.app.unparked`.
 *
 * THE CAP IS RE-CHECKED, AND A STILL-CAPPED UN-PARK IS REFUSED — never re-attributed. Both doors ask
 * the real gate for the app's own charge (its cost owner's cap, under the pool lock), release the
 * hold it took, and move `parked → stopped` only if it passed. Re-attributing the app to whoever
 * clicked would silently move its running cost onto an admin's allowance; an admin who wants it back
 * raises the creator's cap (or the pool) first, and the un-park then passes on its own.
 *
 * `parked → stopped`, never `parked → running`: the next request wakes it through the normal gated
 * wake, which is where money is reserved. The write is guarded on the SAME park reason it read, so a
 * fresh park for another reason racing this one is never overwritten.
 */

import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { publishedApps, type PublishedApp } from '@pagespace/db/schema/published-apps';
import { recordOrgAuditEvent } from '../../audit/org-audit';
import { loggers } from '../../logging/logger-config';
import { errorLogFields } from '../../logging/error-cause';
import { getDrivePolicies } from '../../organizations/policy-reader';
import { publishedAppsDecision } from '../../organizations/org-action-decisions';
import { loadAppUnparkAuthority, type AppUnparkVia } from '../../permissions/app-unpark-authority';
import { defaultAppBillingDeps, type AppBillingDeps } from './app-billing';
import { DAILY_CAP_PARK_REASON, MEMBER_CAP_PARK_REASON } from './app-lifecycle-metering';
import { isAppHostingEnabled, resolveDailyAwakeSecondsCap } from './app-hosting-env';
import { planDailyAwakeCap, utcDayOf } from './app-metering-core';
import { isCreditMetered } from './dedicated-tier';
import { planTransition } from './provisioner-core';

export const MEMBER_CAP_PARK_ERROR = `parked: ${MEMBER_CAP_PARK_REASON}`;

export interface AppUnparkDeps {
  isEnabled: () => boolean;
  billing: Pick<AppBillingDeps, 'resolveCharge' | 'gate' | 'releaseHold'>;
  /** POL-10, asked fresh: an app the org has turned off is never un-parked. */
  publishedAppsAllowed: (driveId: string) => Promise<boolean>;
  dailyAwakeCapSeconds: () => number;
  now: () => Date;
}

export const defaultAppUnparkDeps: AppUnparkDeps = {
  isEnabled: isAppHostingEnabled,
  billing: defaultAppBillingDeps,
  publishedAppsAllowed: async (driveId) => publishedAppsDecision((await getDrivePolicies(driveId))?.policies ?? null).ok,
  dailyAwakeCapSeconds: resolveDailyAwakeSecondsCap,
  now: () => new Date(),
};

/** Why an app may not leave `parked` right now. */
export type UnparkHeld =
  /** POL-10: the org has turned published apps off. */
  | 'org_policy'
  /** The app spent its daily awake budget and the day has not rolled over. */
  | 'daily_cap'
  /** The gate still refuses the app's own charge: its cost owner's cap (or the pool) cannot cover a wake. */
  | 'still_capped'
  /** The drive cannot be resolved, so there is no honest payer to re-check. */
  | 'unresolved_payer';

type UnparkCheck = { ok: true } | { ok: false; held: UnparkHeld; gateReason?: string };

/** Re-ask everything that parked the app, against the app's OWN charge. Reserves nothing it keeps. */
async function checkUnparkable(row: PublishedApp, deps: AppUnparkDeps): Promise<UnparkCheck> {
  if (!(await deps.publishedAppsAllowed(row.driveId))) return { ok: false, held: 'org_policy' };
  if (row.lastError === `parked: ${DAILY_CAP_PARK_REASON}`) {
    const budget = planDailyAwakeCap({
      tier: row.tier,
      counterDay: row.awakeSecondsDay,
      secondsToday: row.awakeSecondsToday,
      today: utcDayOf(deps.now()),
      capSeconds: deps.dailyAwakeCapSeconds(),
    });
    if (budget.exceeded) return { ok: false, held: 'daily_cap' };
  }
  if (!isCreditMetered(row.tier)) return { ok: true };
  const charge = await deps.billing.resolveCharge({ driveId: row.driveId, costOwnerId: row.costOwnerId });
  if (!charge) return { ok: false, held: 'unresolved_payer' };
  const gate = await deps.billing.gate({ charge });
  if (!gate.allowed) return { ok: false, held: 'still_capped', gateReason: gate.orgRefusal ?? gate.reason };
  if (gate.holdId) await deps.billing.releaseHold(gate.holdId);
  return { ok: true };
}

/** `parked → stopped`, guarded on the status AND the park reason that was judged. */
async function writeUnpark(row: PublishedApp): Promise<boolean> {
  const plan = planTransition(row.status, 'stopped', { imageDigest: row.imageDigest, machineId: row.machineId, tier: row.tier });
  if (!plan.allowed) return false;
  const reasonGuard = row.lastError === null ? undefined : eq(publishedApps.lastError, row.lastError);
  const [moved] = await db
    .update(publishedApps)
    .set({ status: 'stopped', lastError: null })
    .where(and(eq(publishedApps.id, row.id), eq(publishedApps.status, 'parked'), reasonGuard))
    .returning({ id: publishedApps.id });
  return moved !== undefined;
}

export type UnparkPublishedAppResult =
  | { outcome: 'unparked'; via: AppUnparkVia }
  | { outcome: 'refused'; reason: 'disabled' | 'not_found' | 'not_parked' | 'forbidden' | 'raced' }
  | { outcome: 'held'; held: UnparkHeld; gateReason?: string };

/**
 * MANUAL un-park by `actorId`. The authority is decided in the permissions module; the cap is
 * re-checked and a still-capped app is REFUSED (`held: still_capped`), not re-attributed.
 */
export async function unparkPublishedApp(
  input: { publishedAppId: string; actorId: string },
  deps: AppUnparkDeps = defaultAppUnparkDeps,
): Promise<UnparkPublishedAppResult> {
  if (!deps.isEnabled()) return { outcome: 'refused', reason: 'disabled' };
  const [row] = await db.select().from(publishedApps).where(eq(publishedApps.id, input.publishedAppId)).limit(1);
  if (!row) return { outcome: 'refused', reason: 'not_found' };
  const [drive] = await db
    .select({ id: drives.id, ownerId: drives.ownerId, orgId: drives.orgId, orgVisibility: drives.orgVisibility })
    .from(drives)
    .where(eq(drives.id, row.driveId))
    .limit(1);
  if (!drive) return { outcome: 'refused', reason: 'not_found' };

  const authority = await loadAppUnparkAuthority(input.actorId, drive, row.costOwnerId);
  if (!authority.allowed) return { outcome: 'refused', reason: 'forbidden' };
  if (row.status !== 'parked') return { outcome: 'refused', reason: 'not_parked' };

  const check = await checkUnparkable(row, deps);
  if (!check.ok) return { outcome: 'held', held: check.held, ...(check.gateReason ? { gateReason: check.gateReason } : {}) };
  if (!(await writeUnpark(row))) return { outcome: 'refused', reason: 'raced' };

  if (drive.orgId) {
    try {
      await recordOrgAuditEvent({
        orgId: drive.orgId,
        eventType: 'org.app.unparked',
        actorId: input.actorId,
        resourceType: 'published_app',
        resourceId: row.id,
        driveId: row.driveId,
        details: { via: authority.via, parkedFor: row.lastError, costOwnerId: row.costOwnerId },
      });
    } catch (error) {
      // The un-park has landed; a lost audit append is logged, never a reason to re-park.
      loggers.security.error('[Audit] org.app.unparked append failed', { publishedAppId: row.id, ...errorLogFields(error) });
    }
  }
  return { outcome: 'unparked', via: authority.via };
}

export interface ReleaseMemberCapParksResult {
  outcome: 'disabled' | 'swept';
  /** Member-cap-parked apps examined. */
  examined: number;
  unparked: number;
  /** The creator's cap (or the pool) still cannot cover a wake: stays parked, re-asked next sweep. */
  stillCapped: number;
  /** POL-10 has the org's apps off: stays parked whatever the cap says. */
  policyHeld: number;
  failed: number;
}

/**
 * AUTOMATIC un-park of every app parked for its creator's member cap whose cap has room again.
 * Never throws: a failing app stays parked and is retried on the next hourly sweep.
 */
export async function releaseMemberCapParks(deps: AppUnparkDeps = defaultAppUnparkDeps): Promise<ReleaseMemberCapParksResult> {
  const result: ReleaseMemberCapParksResult = { outcome: 'swept', examined: 0, unparked: 0, stillCapped: 0, policyHeld: 0, failed: 0 };
  if (!deps.isEnabled()) return { ...result, outcome: 'disabled' };

  let rows: PublishedApp[];
  try {
    rows = await db
      .select()
      .from(publishedApps)
      .where(and(eq(publishedApps.status, 'parked'), eq(publishedApps.lastError, MEMBER_CAP_PARK_ERROR)));
  } catch (error) {
    result.failed += 1;
    loggers.ai.error('Member-cap un-park sweep could not list parked apps — they stay parked until the next sweep', undefined, errorLogFields(error));
    return result;
  }

  result.examined = rows.length;
  for (const row of rows) {
    try {
      const check = await checkUnparkable(row, deps);
      if (!check.ok) {
        if (check.held === 'org_policy') result.policyHeld += 1;
        else result.stillCapped += 1;
        continue;
      }
      if (await writeUnpark(row)) result.unparked += 1;
    } catch (error) {
      result.failed += 1;
      loggers.ai.error('Member-cap un-park failed for one app — it stays parked and is retried next sweep', undefined, {
        publishedAppId: row.id,
        driveId: row.driveId,
        ...errorLogFields(error),
      });
    }
  }
  return result;
}
