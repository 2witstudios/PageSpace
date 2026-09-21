import { describe, it, expect } from 'vitest';
import {
  canAdministerDrive,
  driveRoleOf,
  isDriveLead,
  isDriveMemberRelationship,
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
