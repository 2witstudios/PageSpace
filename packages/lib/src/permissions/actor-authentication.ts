import { getDriveAuthenticationPolicies, getOrgPolicies, getResourceDriveIds } from '../organizations/policy-reader';
import { decideOrgAuthentication, policyInForce, type OrgAuthenticationDecision } from '../organizations/authentication-policy-core';
import {
  automationReaches,
  decideActorAuthentication,
  type AccessActor,
  type ActorGateDecision,
  type OrgAuthenticationDenialCode,
} from './access-actor';
import { refusedDerivedPages } from './org-derived-content';

/**
 * The IO around decideActorAuthentication (SEC-2/3, D-OW-45): the org sign-in policy governing a drive, read at
 * the moment of the decision. Every actor-taking access function asks this before it resolves membership, so a
 * refusal looks exactly like having no access. An automation never needs the read: it is decided by its scope
 * (D-OW-62), which confines it to the drives it lives in.
 */

/**
 * The drives (of `driveIds`) this actor may open: for a credential, those whose org sign-in policy admits it (ids no
 * org governs, or that are no drive, pass); for an automation, those its scope reaches.
 */
export async function filterDrivesForActor(actor: AccessActor, driveIds: readonly string[]): Promise<Set<string>> {
  if (actor.via === 'automation') return new Set(driveIds.filter((id) => automationReaches(actor.scope, id)));
  if (driveIds.length === 0) return new Set();
  const policies = await getDriveAuthenticationPolicies(driveIds);
  const nowMs = Date.now();
  return new Set(driveIds.filter((id) => decideActorAuthentication({ actor, driveId: id, policy: policies.get(id) ?? null, nowMs }).allowed));
}

/** The resources (pages, or drives as root resources) of `resourceIds` this actor's credential may open. */
export async function filterResourcesForActor(actor: AccessActor, resourceIds: readonly string[]): Promise<Set<string>> {
  if (resourceIds.length === 0) return new Set();
  if (actor.via === 'automation' && actor.scope.kind === 'held-drives') return new Set(resourceIds);
  const driveOf = await getResourceDriveIds(resourceIds);
  const allowedDrives = await filterDrivesForActor(actor, [...new Set(driveOf.values())]);
  const inAllowedDrives = resourceIds.filter((id) => allowedDrives.has(driveOf.get(id) ?? id));
  const withheld = await refusedDerivedPages(actor, inAllowedDrives);
  return new Set(inAllowedDrives.filter((id) => !withheld.has(id)));
}

/**
 * The pages of `pageIds` this actor may read once its drives are admitted: drops the pages that restate org-derived
 * content (memory pages, D-OW-62) a contributing org's sign-in policy withholds from the credential. For listings that
 * are gated per drive (a drive's pages, every accessible page).
 */
export async function dropWithheldDerivedPages(actor: AccessActor, pageIds: readonly string[]): Promise<string[]> {
  const withheld = await refusedDerivedPages(actor, pageIds);
  return pageIds.filter((id) => !withheld.has(id));
}

export async function checkActorDriveAuthentication(actor: AccessActor, driveId: string): Promise<ActorGateDecision> {
  if (actor.via === 'automation') return decideActorAuthentication({ actor, driveId, policy: null, nowMs: Date.now() });
  const policies = await getDriveAuthenticationPolicies([driveId]);
  return decideActorAuthentication({ actor, driveId, policy: policies.get(driveId) ?? null, nowMs: Date.now() });
}

export async function checkActorResourceAuthentication(actor: AccessActor, resourceId: string): Promise<ActorGateDecision> {
  if (actor.via === 'automation' && actor.scope.kind === 'held-drives') return { allowed: true };
  const driveOf = await getResourceDriveIds([resourceId]);
  const driveDecision = await checkActorDriveAuthentication(actor, driveOf.get(resourceId) ?? resourceId);
  if (!driveDecision.allowed) return driveDecision;
  // A page restating org-derived content (a memory page, D-OW-62) also needs every contributing org's admission.
  const refusal = (await refusedDerivedPages(actor, [resourceId])).get(resourceId);
  return refusal ? { allowed: false, code: refusal.code } : driveDecision;
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
  if (actor.via === 'automation') return null;
  const decision = await checkActorResourceAuthentication(actor, resourceId);
  return decision.allowed || decision.code === 'automation_out_of_scope' ? null : decision.code;
}

/**
 * The org's OWN sign-in policy against the actor, for acting on the org itself (its settings, members, invitations,
 * domains, policies — authorizeOrgRequest, after the role check). Uses the policy in force (policyInForce), so a
 * damaged stored age stays repairable. Sign-in policy never applies to an automation, which never reaches org admin
 * routes. Callers establish the actor's role in the org first, so a non-member never learns its policy.
 */
export async function checkActorOrgAuthentication(actor: AccessActor, orgId: string): Promise<OrgAuthenticationDecision> {
  if (actor.via === 'automation') return { allowed: true };
  const policies = await getOrgPolicies(orgId);
  return decideOrgAuthentication({ policy: policyInForce(policies), authentication: actor.authentication, nowMs: Date.now() });
}
