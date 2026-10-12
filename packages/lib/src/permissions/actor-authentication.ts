import type { OrgAuthenticationDecision } from '../organizations/authentication-policy-core';
import { getDriveAuthenticationPolicies, getDrivePolicies, getOrgPolicies, getResourceDriveIds } from '../organizations/policy-reader';
import { decideActorAuthentication, type AccessActor, type OrgAuthenticationDenialCode } from './access-actor';

/**
 * The IO around decideActorAuthentication (SEC-2/3, D-OW-45): the org sign-in policy governing a drive, read at
 * the moment of the decision. Every actor-taking access function asks this before it resolves membership, so a
 * refusal looks exactly like having no access. An automation never needs the read.
 */

const ALLOWED: OrgAuthenticationDecision = { allowed: true };

/** The drives (of `driveIds`) this actor's credential may open. Ids no org governs, or that are no drive, pass. */
export async function filterDrivesForActor(actor: AccessActor, driveIds: readonly string[]): Promise<Set<string>> {
  if (actor.via === 'automation' || driveIds.length === 0) return new Set(driveIds);
  const policies = await getDriveAuthenticationPolicies(driveIds);
  const nowMs = Date.now();
  return new Set(driveIds.filter((id) => decideActorAuthentication({ actor, policy: policies.get(id) ?? null, nowMs }).allowed));
}

/** The resources (pages, or drives as root resources) of `resourceIds` this actor's credential may open. */
export async function filterResourcesForActor(actor: AccessActor, resourceIds: readonly string[]): Promise<Set<string>> {
  if (actor.via === 'automation' || resourceIds.length === 0) return new Set(resourceIds);
  const driveOf = await getResourceDriveIds(resourceIds);
  const allowedDrives = await filterDrivesForActor(actor, [...new Set(driveOf.values())]);
  return new Set(resourceIds.filter((id) => allowedDrives.has(driveOf.get(id) ?? id)));
}

export async function checkActorDriveAuthentication(actor: AccessActor, driveId: string): Promise<OrgAuthenticationDecision> {
  if (actor.via === 'automation') return ALLOWED;
  const policies = await getDriveAuthenticationPolicies([driveId]);
  return decideActorAuthentication({ actor, policy: policies.get(driveId) ?? null, nowMs: Date.now() });
}

export async function checkActorResourceAuthentication(actor: AccessActor, resourceId: string): Promise<OrgAuthenticationDecision> {
  if (actor.via === 'automation') return ALLOWED;
  const driveOf = await getResourceDriveIds([resourceId]);
  return checkActorDriveAuthentication(actor, driveOf.get(resourceId) ?? resourceId);
}

/**
 * The org's own sign-in policy against this actor, for org surfaces that are not a drive (org settings, members,
 * invitations, policies, the drive-org routes' target org). Callers establish that the actor may act in the org
 * first; an org that does not exist reads as the defaults.
 */
export async function checkActorOrgAuthentication(actor: AccessActor, orgId: string): Promise<OrgAuthenticationDecision> {
  if (actor.via === 'automation') return ALLOWED;
  return decideActorAuthentication({ actor, policy: await getOrgPolicies(orgId), nowMs: Date.now() });
}

/** The org whose sign-in policy governs `driveId`, or null for a personal or missing drive. */
export async function drivePolicyOrgId(driveId: string): Promise<string | null> {
  return (await getDrivePolicies(driveId))?.orgId ?? null;
}

/**
 * Why an access function refused this actor, when the reason is the org's sign-in policy: the code a route returns
 * so the person can sign in again (or with a passkey) instead of reading a bare 403/404. Null when sign-in policy is
 * not what refused (no access at all, or no such resource). Accepts a page id or a drive id.
 */
export async function explainOrgAuthenticationDenial(
  actor: AccessActor,
  resourceId: string,
): Promise<OrgAuthenticationDenialCode | null> {
  const decision = await checkActorResourceAuthentication(actor, resourceId);
  return decision.allowed ? null : decision.code;
}
