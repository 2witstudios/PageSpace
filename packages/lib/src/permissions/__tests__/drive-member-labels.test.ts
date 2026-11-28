import { describe, it, expect } from 'vitest';
import { isDriveGuest, isStaleOrgRow } from '../drive-member-labels';

describe('drive-member-labels: who is a guest', () => {
  it('DRV-8 (partial) on an org drive a member with no accepted org role is a guest; an org member is not', () => {
    expect(isDriveGuest({ driveOrgId: 'org-northwind', isOrgMember: false })).toBe(true);
    expect(isDriveGuest({ driveOrgId: 'org-northwind', isOrgMember: true })).toBe(false);
  });

  it('DRV-8 (partial) a personal drive has no org, so nobody on it is a guest', () => {
    expect(isDriveGuest({ driveOrgId: null, isOrgMember: false })).toBe(false);
  });
});

describe('drive-member-labels: a row left behind by a departure', () => {
  it('DRV-8 (partial) an org-materialized row of someone who left the org is stale, not a guest; an invited outsider is not stale', () => {
    expect(isStaleOrgRow({ driveOrgId: 'org-n', isOrgMember: false, source: 'org' })).toBe(true);
    expect(isStaleOrgRow({ driveOrgId: 'org-n', isOrgMember: false, source: 'invite' })).toBe(false);
    expect(isStaleOrgRow({ driveOrgId: 'org-n', isOrgMember: true, source: 'org' })).toBe(false);
    expect(isStaleOrgRow({ driveOrgId: null, isOrgMember: false, source: 'org' })).toBe(false);
  });
});

