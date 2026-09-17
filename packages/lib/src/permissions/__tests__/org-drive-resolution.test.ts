import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveDriveMembership,
  decideListedDriveRole,
  type OrgDriveFacts,
} from '../org-drive-resolution';
import type { DriveRoleGrant, OrgDriveMembership } from '../org-access';

const DEFAULT_ROLE: DriveRoleGrant = { role: 'MEMBER', customRoleId: 'role_default' };

const PERSONAL: OrgDriveFacts = { orgId: null, orgVisibility: 'OPEN' };
const OPEN: OrgDriveFacts = { orgId: 'org_northwind', orgVisibility: 'OPEN' };
const RESTRICTED: OrgDriveFacts = { orgId: 'org_northwind', orgVisibility: 'RESTRICTED' };
const PRIVATE: OrgDriveFacts = { orgId: 'org_northwind', orgVisibility: 'PRIVATE' };

const inviteMember: OrgDriveMembership = { role: 'MEMBER', customRoleId: null, source: 'invite' };
const inviteAdmin: OrgDriveMembership = { role: 'ADMIN', customRoleId: null, source: 'invite' };
const orgRow: OrgDriveMembership = { role: 'MEMBER', customRoleId: 'role_default', source: 'org' };

describe('resolveEffectiveDriveMembership', () => {
  describe('while ORGS_ENABLED is false', () => {
    it('returns the accepted row exactly as today for a personal drive, and null without one', () => {
      expect(resolveEffectiveDriveMembership({
        orgsEnabled: false, drive: PERSONAL, orgRole: null, row: inviteAdmin, driveDefaultRole: DEFAULT_ROLE,
      })).toEqual({ ...inviteAdmin, auditOrgAdminPrivateAccess: false });
      expect(resolveEffectiveDriveMembership({
        orgsEnabled: false, drive: PERSONAL, orgRole: 'OWNER', row: null, driveDefaultRole: DEFAULT_ROLE,
      })).toBeNull();
    });

    it('ignores org roles and visibility on an org drive: an org Admin without a row gets nothing, a stale org row still counts as today', () => {
      expect(resolveEffectiveDriveMembership({
        orgsEnabled: false, drive: PRIVATE, orgRole: 'ADMIN', row: null, driveDefaultRole: DEFAULT_ROLE,
      })).toBeNull();
      expect(resolveEffectiveDriveMembership({
        orgsEnabled: false, drive: OPEN, orgRole: 'MEMBER', row: null, driveDefaultRole: DEFAULT_ROLE,
      })).toBeNull();
      expect(resolveEffectiveDriveMembership({
        orgsEnabled: false, drive: RESTRICTED, orgRole: null, row: orgRow, driveDefaultRole: DEFAULT_ROLE,
      })).toEqual({ ...orgRow, auditOrgAdminPrivateAccess: false });
    });
  });

  describe('while ORGS_ENABLED is true', () => {
    const on = { orgsEnabled: true, driveDefaultRole: DEFAULT_ROLE } as const;

    it('leaves a personal drive exactly row-based: an org role never applies to a drive with no org', () => {
      expect(resolveEffectiveDriveMembership({ ...on, drive: PERSONAL, orgRole: 'OWNER', row: null })).toBeNull();
      expect(resolveEffectiveDriveMembership({ ...on, drive: PERSONAL, orgRole: null, row: orgRow }))
        .toEqual({ ...orgRow, auditOrgAdminPrivateAccess: false });
    });

    it('ORG-4 (partial) org Owner and Admin resolve ADMIN on every visibility, and only PRIVATE asks for the audit event', () => {
      for (const orgRole of ['OWNER', 'ADMIN'] as const) {
        expect(resolveEffectiveDriveMembership({ ...on, drive: OPEN, orgRole, row: null }))
          .toEqual({ role: 'ADMIN', customRoleId: null, source: 'org-admin', auditOrgAdminPrivateAccess: false });
        expect(resolveEffectiveDriveMembership({ ...on, drive: RESTRICTED, orgRole, row: null }))
          .toEqual({ role: 'ADMIN', customRoleId: null, source: 'org-admin', auditOrgAdminPrivateAccess: false });
        expect(resolveEffectiveDriveMembership({ ...on, drive: PRIVATE, orgRole, row: null }))
          .toEqual({ role: 'ADMIN', customRoleId: null, source: 'org-admin', auditOrgAdminPrivateAccess: true });
      }
    });

    it('ORG-4 (partial) an org Admin whose own invited ADMIN row opens a PRIVATE drive owes no org-admin audit', () => {
      expect(resolveEffectiveDriveMembership({ ...on, drive: PRIVATE, orgRole: 'ADMIN', row: inviteAdmin }))
        .toEqual({ ...inviteAdmin, auditOrgAdminPrivateAccess: false });
    });

    it('DRV-5 (partial) an org MEMBER with no row resolves on an OPEN drive with the drive default role', () => {
      expect(resolveEffectiveDriveMembership({ ...on, drive: OPEN, orgRole: 'MEMBER', row: null }))
        .toEqual({ role: 'MEMBER', customRoleId: 'role_default', source: 'org', auditOrgAdminPrivateAccess: false });
    });

    it('DRV-6 (partial) an org MEMBER with no row resolves nothing on a RESTRICTED or PRIVATE drive', () => {
      expect(resolveEffectiveDriveMembership({ ...on, drive: RESTRICTED, orgRole: 'MEMBER', row: null })).toBeNull();
      expect(resolveEffectiveDriveMembership({ ...on, drive: PRIVATE, orgRole: 'MEMBER', row: null })).toBeNull();
    });

    it('DRV-6 (partial) a stale source org row never opens a RESTRICTED or PRIVATE drive for an org MEMBER', () => {
      expect(resolveEffectiveDriveMembership({ ...on, drive: RESTRICTED, orgRole: 'MEMBER', row: orgRow })).toBeNull();
      expect(resolveEffectiveDriveMembership({ ...on, drive: PRIVATE, orgRole: 'MEMBER', row: orgRow })).toBeNull();
    });

    it('X-6 (partial) a non-member resolves nothing on an OPEN org drive, and a stale org row of a departed member opens nothing on any visibility', () => {
      for (const drive of [OPEN, RESTRICTED, PRIVATE]) {
        expect(resolveEffectiveDriveMembership({ ...on, drive, orgRole: null, row: null })).toBeNull();
        expect(resolveEffectiveDriveMembership({ ...on, drive, orgRole: null, row: orgRow })).toBeNull();
      }
    });

    it('DRV-8 (partial) a guest (not in the org) keeps exactly their invited row on any visibility', () => {
      for (const drive of [OPEN, RESTRICTED, PRIVATE]) {
        expect(resolveEffectiveDriveMembership({ ...on, drive, orgRole: null, row: inviteMember }))
          .toEqual({ ...inviteMember, auditOrgAdminPrivateAccess: false });
      }
    });
  });
});

describe('decideListedDriveRole', () => {
  describe('while ORGS_ENABLED is false', () => {
    it('lists exactly as today: a row gives its role, a page permission alone gives MEMBER, nothing gives null, on personal and org drives alike', () => {
      for (const drive of [PERSONAL, OPEN, RESTRICTED, PRIVATE]) {
        const off = { orgsEnabled: false, drive, orgRole: 'OWNER' as const };
        expect(decideListedDriveRole({ ...off, row: inviteAdmin, viaPagePermission: false })).toBe('ADMIN');
        expect(decideListedDriveRole({ ...off, row: orgRow, viaPagePermission: false })).toBe('MEMBER');
        expect(decideListedDriveRole({ ...off, row: null, viaPagePermission: true })).toBe('MEMBER');
        expect(decideListedDriveRole({ ...off, row: null, viaPagePermission: false })).toBeNull();
      }
    });
  });

  describe('while ORGS_ENABLED is true', () => {
    const on = { orgsEnabled: true, viaPagePermission: false } as const;

    it('lists a personal drive exactly as today', () => {
      expect(decideListedDriveRole({ ...on, drive: PERSONAL, orgRole: null, row: inviteAdmin })).toBe('ADMIN');
      expect(decideListedDriveRole({ orgsEnabled: true, drive: PERSONAL, orgRole: null, row: null, viaPagePermission: true })).toBe('MEMBER');
    });

    it('DRV-5 (partial) lists an OPEN org drive to every org member without a row, with their resolved role', () => {
      expect(decideListedDriveRole({ ...on, drive: OPEN, orgRole: 'MEMBER', row: null })).toBe('MEMBER');
      expect(decideListedDriveRole({ ...on, drive: OPEN, orgRole: 'ADMIN', row: null })).toBe('ADMIN');
      expect(decideListedDriveRole({ ...on, drive: OPEN, orgRole: 'OWNER', row: null })).toBe('ADMIN');
    });

    it('DRV-6 (partial) never lists a RESTRICTED drive to an org member, Admin or Owner who has not joined, nor via a stale org row', () => {
      for (const orgRole of ['MEMBER', 'ADMIN', 'OWNER'] as const) {
        expect(decideListedDriveRole({ ...on, drive: RESTRICTED, orgRole, row: null })).toBeNull();
        expect(decideListedDriveRole({ ...on, drive: RESTRICTED, orgRole, row: orgRow })).toBeNull();
        expect(decideListedDriveRole({ ...on, drive: PRIVATE, orgRole, row: null })).toBeNull();
      }
    });

    it('DRV-6 (partial) lists a RESTRICTED drive once joined (an invite row), with the org Admin resolving ADMIN', () => {
      expect(decideListedDriveRole({ ...on, drive: RESTRICTED, orgRole: 'MEMBER', row: inviteMember })).toBe('MEMBER');
      expect(decideListedDriveRole({ ...on, drive: RESTRICTED, orgRole: 'ADMIN', row: inviteMember })).toBe('ADMIN');
    });

    it('X-6 (partial) lists no org drive to a non-member: not an OPEN one, not via a stale org row, not via a page permission alone', () => {
      for (const drive of [OPEN, RESTRICTED, PRIVATE]) {
        expect(decideListedDriveRole({ ...on, drive, orgRole: null, row: null })).toBeNull();
        expect(decideListedDriveRole({ ...on, drive, orgRole: null, row: orgRow })).toBeNull();
        expect(decideListedDriveRole({ orgsEnabled: true, drive, orgRole: null, row: null, viaPagePermission: true })).toBeNull();
      }
    });

    it('DRV-8 (partial) lists the drive a guest was invited to, with their row role', () => {
      expect(decideListedDriveRole({ ...on, drive: PRIVATE, orgRole: null, row: inviteMember })).toBe('MEMBER');
    });
  });
});
