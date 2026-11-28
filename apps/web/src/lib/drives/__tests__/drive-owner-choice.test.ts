import { describe, it, expect } from 'vitest';
import { creatableOrgs, defaultDriveOwner, driveOrgContext } from '../drive-owner-choice';

const nw = { id: 'org_nw', name: 'Northwind', canCreateDrives: true };
const acme = { id: 'org_acme', name: 'Acme', canCreateDrives: false };
const drives = [{ id: 'd_prod', orgId: 'org_nw' }, { id: 'd_acme', orgId: 'org_acme' }, { id: 'd_mine', orgId: null }];

describe('drive owner choice', () => {
  it('DRV-3 (partial) the org context is the named org, else the org of the drive the person is in, else none', () => {
    expect(driveOrgContext({ explicitOrgId: 'org_x', currentDriveId: 'd_prod', drives })).toBe('org_x');
    expect(driveOrgContext({ explicitOrgId: undefined, currentDriveId: 'd_prod', drives })).toBe('org_nw');
    expect(driveOrgContext({ explicitOrgId: null, currentDriveId: 'd_mine', drives })).toBeNull();
    expect(driveOrgContext({ explicitOrgId: null, currentDriveId: null, drives })).toBeNull();
  });

  it('DRV-3 (partial) only orgs that let the person create drives are offered, and the context org is the default only when offered', () => {
    const offered = creatableOrgs([nw, acme, { id: 'org_old', name: 'Old' }]);
    expect(offered).toEqual([nw]);
    expect(defaultDriveOwner('org_nw', offered)).toBe('org_nw');
    expect(defaultDriveOwner('org_acme', offered)).toBeNull();
    expect(defaultDriveOwner(null, offered)).toBeNull();
  });
});
