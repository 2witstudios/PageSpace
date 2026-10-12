import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import type { VerifiedAuthentication } from '../auth/authentication-evidence';
import { decideOrgAuthentication, type OrgAuthenticationDecision } from './authentication-policy-core';
import { getDrivePolicies } from './policy-reader';

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

/** Permission APIs also accept a drive ID as their root resource. */
export async function checkResourceAuthentication(
  resourceId: string,
  authentication: VerifiedAuthentication | null | undefined,
): Promise<OrgAuthenticationDecision> {
  const page = await db.query.pages.findFirst({ where: eq(pages.id, resourceId), columns: { driveId: true } });
  return checkDriveAuthentication(page?.driveId ?? resourceId, authentication);
}
