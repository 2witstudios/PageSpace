import { describe, it, expect } from 'vitest';
import {
  canAdministerDrive,
  driveRoleOf,
  isDriveLead,
  isDriveMemberRelationship,
  decideDriveLeadAuthority,
  type DriveRelationship,
} from '../drive-relationship';

const lead: DriveRelationship = { isOwner: true, membership: null };
const member = (role: 'OWNER' | 'ADMIN' | 'MEMBER'): DriveRelationship => ({
  isOwner: false,
  membership: { role, customRoleId: null, source: 'invite', auditOrgAdminPrivateAccess: false },
});
const stranger: DriveRelationship = { isOwner: false, membership: null };

describe('drive relationship decisions', () => {
  it('isDriveLead is true only for the drive\'s ownerId, never for a missing one', () => {
    expect(isDriveLead('u1', { ownerId: 'u1' })).toBe(true);
    expect(isDriveLead('u1', { ownerId: 'u2' })).toBe(false);
    expect(isDriveLead('u1', { ownerId: null })).toBe(false);
    expect(isDriveLead('', { ownerId: undefined })).toBe(false);
  });

  it('driveRoleOf gives OWNER to the lead, the membership role otherwise, and null to a stranger', () => {
    expect(driveRoleOf(lead)).toBe('OWNER');
    expect(driveRoleOf(member('ADMIN'))).toBe('ADMIN');
    expect(driveRoleOf(member('MEMBER'))).toBe('MEMBER');
    expect(driveRoleOf(member('OWNER'))).toBe('OWNER');
    expect(driveRoleOf(stranger)).toBeNull();
  });

  it('canAdministerDrive admits the lead and an ADMIN membership only (a personal drive\'s OWNER row is not ADMIN)', () => {
    expect(canAdministerDrive(lead)).toBe(true);
    expect(canAdministerDrive(member('ADMIN'))).toBe(true);
    expect(canAdministerDrive(member('OWNER'))).toBe(false);
    expect(canAdministerDrive(member('MEMBER'))).toBe(false);
    expect(canAdministerDrive(stranger)).toBe(false);
  });

  it('isDriveMemberRelationship admits the lead and any membership', () => {
    expect(isDriveMemberRelationship(lead)).toBe(true);
    expect(isDriveMemberRelationship(member('MEMBER'))).toBe(true);
    expect(isDriveMemberRelationship(stranger)).toBe(false);
  });
});

describe('decideDriveLeadAuthority (lead-only actions: rename, restore, permanent delete)', () => {
  const orgDrive = { ownerId: 'lena', orgId: 'org-1' };
  const personal = { ownerId: 'marcus', orgId: null };
  const decide = (userId: string, drive: { ownerId: string; orgId: string | null }, orgRole: 'OWNER' | 'ADMIN' | 'MEMBER' | null, orgsEnabled = true) =>
    decideDriveLeadAuthority({ orgsEnabled, userId, drive, orgRole });

  it('the drive lead acts as lead on any drive, dark or enabled', () => {
    expect(decide('lena', orgDrive, 'MEMBER')).toEqual({ allowed: true, via: 'lead' });
    expect(decide('marcus', personal, null, false)).toEqual({ allowed: true, via: 'lead' });
  });

  it('ORG-4 (partial) an org Owner or Admin acts as lead on an org-owned drive, and the answer names the org power so it is audited', () => {
    expect(decide('jono', orgDrive, 'OWNER')).toEqual({ allowed: true, via: 'org-owner', orgId: 'org-1' });
    expect(decide('priya', orgDrive, 'ADMIN')).toEqual({ allowed: true, via: 'org-admin', orgId: 'org-1' });
  });

  it('an org MEMBER and a non-member are refused on an org drive', () => {
    expect(decide('nina', orgDrive, 'MEMBER')).toEqual({ allowed: false });
    expect(decide('dana', orgDrive, null)).toEqual({ allowed: false });
  });

  it('a personal drive is unchanged: only its owner, whatever org role the caller holds elsewhere', () => {
    expect(decide('priya', personal, 'ADMIN')).toEqual({ allowed: false });
    expect(decide('nina', personal, null)).toEqual({ allowed: false });
  });

  it('while ORGS_ENABLED is false org power acts as nothing', () => {
    expect(decide('priya', orgDrive, 'ADMIN', false)).toEqual({ allowed: false });
  });
});
