import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import type { VerifiedAuthentication } from '../auth/authentication-evidence';
import { decideOrgAuthentication, type OrgAuthenticationDecision } from './authentication-policy-core';
import { getDrivePolicies, getOrgPolicies } from './policy-reader';

/**
 * The org's own sign-in policy against a credential, for org surfaces that are not a drive (org
 * settings, members, invitations, policies, the drive-org routes' target org). Callers establish
 * that the caller may act in the org first; an org that does not exist reads as the defaults.
 */
export async function checkOrgAuthentication(
  orgId: string,
  authentication: VerifiedAuthentication | null | undefined,
): Promise<OrgAuthenticationDecision> {
  const policy = await getOrgPolicies(orgId);
  return decideOrgAuthentication({ policy, authentication: authentication ?? null, nowMs: Date.now() });
}

/** Credential policy is an additional restriction; callers must still establish resource permissions. */
export async function checkDriveAuthentication(
  driveId: string,
  authentication: VerifiedAuthentication | null | undefined,
): Promise<OrgAuthenticationDecision> {
  const governing = await getDrivePolicies(driveId);
  return governing
    ? decideOrgAuthentication({ policy: governing.policies, authentication: authentication ?? null, nowMs: Date.now() })
    : { allowed: true };
}

/** The org whose sign-in policy governs `driveId`, or null for a personal or missing drive. */
export async function drivePolicyOrgId(driveId: string): Promise<string | null> {
  return (await getDrivePolicies(driveId))?.orgId ?? null;
}

/** Permission APIs also accept a drive ID as their root resource. */
export async function checkResourceAuthentication(
  resourceId: string,
  authentication: VerifiedAuthentication | null | undefined,
): Promise<OrgAuthenticationDecision> {
  const page = await db.query.pages.findFirst({ where: eq(pages.id, resourceId), columns: { driveId: true } });
  return checkDriveAuthentication(page?.driveId ?? resourceId, authentication);
}
