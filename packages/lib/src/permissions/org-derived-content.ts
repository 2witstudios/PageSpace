import { decideOrgAuthentication, type OrgAuthenticationDecision } from '../organizations/authentication-policy-core';
import { getDerivedPageOrgIds, getOrgPolicies, getResourceDriveIds, listOrgIdsOfDrives } from '../organizations/policy-reader';
import type { AccessActor, OrgAuthenticationDenialCode } from './access-actor';

/**
 * Content DERIVED from several orgs' drives and stored for one person (a Pulse summary, distilled memory — D-OW-62):
 * it was produced by an automation reading every drive the person holds, so it may be served only to a credential
 * that every contributing org's sign-in policy admits (SEC-2/3). Personal drives contribute no org.
 */

export type DerivedContentAccess =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: OrgAuthenticationDenialCode; readonly orgIds: readonly string[] };

/**
 * Pure: all contributing orgs must admit the credential. The code names what unlocks every refusing org at once —
 * a passkey sign-in when any of them requires one (a fresh passkey also satisfies a maximum age), else signing in
 * again. `orgIds` lists the refusing orgs, sorted.
 */
export function decideDerivedContentAccess(
  decisions: ReadonlyArray<{ readonly orgId: string; readonly decision: OrgAuthenticationDecision }>,
): DerivedContentAccess {
  const refused = decisions.flatMap(({ orgId, decision }) => (decision.allowed ? [] : [{ orgId, code: decision.code }]));
  if (refused.length === 0) return { allowed: true };
  const code = refused.some((r) => r.code === 'org_strong_sign_in_required') ? 'org_strong_sign_in_required' : 'org_reauthentication_required';
  return { allowed: false, code, orgIds: [...new Set(refused.map((r) => r.orgId))].sort() };
}

/**
 * The IO around decideDerivedContentAccess: each contributing org's stored policy, read now, with CONTENT semantics (a
 * damaged value refuses, as for any org drive). Derived content is served to a credential; an automation reading it
 * back is confined by its own scope elsewhere, so it is admitted here.
 */
export async function checkDerivedContentAccess(actor: AccessActor, orgIds: readonly string[]): Promise<DerivedContentAccess> {
  const unique = [...new Set(orgIds)];
  if (unique.length === 0 || actor.via === 'automation') return { allowed: true };
  const nowMs = Date.now();
  const decisions = await Promise.all(unique.map(async (orgId) => {
    const { requireStrongSignIn, maximumSessionAgeMinutes } = await getOrgPolicies(orgId);
    return { orgId, decision: decideOrgAuthentication({ policy: { requireStrongSignIn, maximumSessionAgeMinutes }, authentication: actor.authentication, nowMs }) };
  }));
  return decideDerivedContentAccess(decisions);
}

/**
 * The orgs governing `driveIds` (personal drives govern none), sorted: what content read from those drives records as
 * its contributing orgs.
 */
export async function orgIdsOfDrives(driveIds: readonly string[]): Promise<string[]> {
  return listOrgIdsOfDrives(driveIds);
}

/**
 * The orgs governing content read from `driveIds` and from `pageIds` (a page reached by a page-level grant, with no
 * membership of its drive, still contributes its drive's org), sorted.
 */
export async function orgIdsOfSources(sources: { readonly driveIds: readonly string[]; readonly pageIds: readonly string[] }): Promise<string[]> {
  const pageDrives = sources.pageIds.length > 0 ? [...(await getResourceDriveIds(sources.pageIds)).values()] : [];
  return listOrgIdsOfDrives([...sources.driveIds, ...pageDrives]);
}

export type DerivedContentRefusal = Extract<DerivedContentAccess, { readonly allowed: false }>;

/**
 * The pages of `pageIds` that restate org-derived content (memory pages, D-OW-62) and that this credential may not
 * read, each with its refusal. Every page read path asks this through the actor sign-in gate (actor-authentication),
 * so the page is withheld wherever it would be read. Pages sharing the same contributing orgs are decided once. An
 * automation is judged by its scope alone: nothing is withheld from it here.
 */
export async function refusedDerivedPages(actor: AccessActor, pageIds: readonly string[]): Promise<Map<string, DerivedContentRefusal>> {
  const refused = new Map<string, DerivedContentRefusal>();
  if (pageIds.length === 0 || actor.via === 'automation') return refused;
  const derived = await getDerivedPageOrgIds(pageIds);
  const decided = new Map<string, DerivedContentAccess>();
  for (const [pageId, orgIds] of derived) {
    const key = orgIds.join(',');
    const access = decided.get(key) ?? (await checkDerivedContentAccess(actor, orgIds));
    decided.set(key, access);
    if (!access.allowed) refused.set(pageId, access);
  }
  return refused;
}
