/**
 * A stand-in for @pagespace/lib/permissions/drive-relationship-loader in route and tool tests of
 * lead-only actions. It decides with the REAL pure decideDriveLeadAuthority, reads each user's org
 * role from `leadAuthority.orgRoles`, and records the audit event the real loader writes for an
 * org-power action. The loader's own IO (the org role read, the audit row) is proven against
 * Postgres in packages/lib drive-gate-primitives.integration.test.ts.
 */
import { vi } from 'vitest';
import { decideDriveLeadAuthority } from '@pagespace/lib/permissions/drive-relationship';

type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export const leadAuthority = {
  orgsEnabled: true,
  orgRoles: new Map<string, OrgRole>(),
  audited: [] as Array<{ userId: string; driveId: string; action: string; via: string }>,
  reset() {
    this.orgsEnabled = true;
    this.orgRoles.clear();
    this.audited.length = 0;
  },
};

export const loadDriveLeadAuthority = vi.fn(async (
  userId: string,
  drive: { id: string; ownerId: string; orgId: string | null },
  action: string,
) => {
  const authority = decideDriveLeadAuthority({
    orgsEnabled: leadAuthority.orgsEnabled,
    userId,
    drive,
    orgRole: drive.orgId ? leadAuthority.orgRoles.get(userId) ?? null : null,
  });
  if (authority.allowed && authority.via !== 'lead') {
    leadAuthority.audited.push({ userId, driveId: drive.id, action, via: authority.via });
  }
  return authority;
});

/** The ruling's cases (#2689 point-guard ruling), for it.each tables. */
export const LEAD_ACTION_CASES = [
  { who: 'the drive lead', userId: 'lena', orgRole: null, drive: 'org', allowed: true, audited: false },
  { who: 'an org Owner', userId: 'jono', orgRole: 'OWNER', drive: 'org', allowed: true, audited: true },
  { who: 'an org Admin', userId: 'priya', orgRole: 'ADMIN', drive: 'org', allowed: true, audited: true },
  { who: 'an org MEMBER', userId: 'nina', orgRole: 'MEMBER', drive: 'org', allowed: false, audited: false },
  { who: 'a non-member', userId: 'dana', orgRole: null, drive: 'org', allowed: false, audited: false },
  { who: 'the owner of a personal drive', userId: 'marcus', orgRole: null, drive: 'personal', allowed: true, audited: false },
  { who: 'a non-owner (an org Admin elsewhere) on a personal drive', userId: 'priya', orgRole: 'ADMIN', drive: 'personal', allowed: false, audited: false },
] as const;

export const LEAD_ACTION_DRIVES = {
  org: { ownerId: 'lena', orgId: 'org-1', orgVisibility: 'PRIVATE' as const },
  personal: { ownerId: 'marcus', orgId: null, orgVisibility: 'OPEN' as const },
};

export const recordOrgPowerDriveAction = vi.fn(async (
  userId: string,
  drive: { id: string; ownerId: string; orgId: string | null },
  action: string,
) => {
  await loadDriveLeadAuthority(userId, drive, action);
});
