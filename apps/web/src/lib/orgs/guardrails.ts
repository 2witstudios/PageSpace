import { db, eq, and, organizations, orgMembers, orgDrives } from '@pagespace/db';

// Re-export pure check functions
export {
  checkAIProviderAllowed,
  checkStorageLimit,
  checkAITokenLimit,
  checkExternalSharing,
  checkDomainAllowed,
  type OrgGuardrails,
  type GuardrailCheckResult,
} from './guardrail-checks';

import type { OrgGuardrails } from './guardrail-checks';

export async function getOrgForDrive(driveId: string) {
  const [orgDrive] = await db
    .select({
      orgId: orgDrives.orgId,
    })
    .from(orgDrives)
    .where(eq(orgDrives.driveId, driveId))
    .limit(1);

  if (!orgDrive) return null;

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgDrive.orgId))
    .limit(1);

  return org ?? null;
}

export async function getOrgForUser(userId: string) {
  const [membership] = await db
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    .limit(1);

  if (!membership) return null;

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, membership.orgId))
    .limit(1);

  return org ?? null;
}

export async function getOrgGuardrails(orgId: string): Promise<OrgGuardrails | null> {
  const [org] = await db
    .select({
      allowedAIProviders: organizations.allowedAIProviders,
      maxStorageBytes: organizations.maxStorageBytes,
      maxAITokensPerDay: organizations.maxAITokensPerDay,
      requireMFA: organizations.requireMFA,
      allowExternalSharing: organizations.allowExternalSharing,
      allowedDomains: organizations.allowedDomains,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return org ?? null;
}

export async function isOrgAdmin(userId: string, orgId: string): Promise<boolean> {
  const [member] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);

  return member?.role === 'OWNER' || member?.role === 'ADMIN';
}

export async function isOrgOwner(userId: string, orgId: string): Promise<boolean> {
  const [org] = await db
    .select({ ownerId: organizations.ownerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return org?.ownerId === userId;
}

export async function getOrgMemberCount(orgId: string): Promise<number> {
  const members = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(eq(orgMembers.orgId, orgId));

  return members.length;
}
