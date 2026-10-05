import { beforeEach, describe, expect, it } from 'vitest';
import { clearPendingSetup, loadPendingSetup, savePendingSetup } from '../pending-setup';

beforeEach(() => localStorage.clear());

describe('pending org setup', () => {
  it('UI-6 (partial): keeps the chosen drives and invitations for an org until setup runs', () => {
    savePendingSetup('org_1', { driveIds: ['d1'], invites: ['a@x.io'], selfEmail: 'me@x.io', driveNames: { d1: 'Product' } });
    expect(loadPendingSetup('org_1')).toEqual({ driveIds: ['d1'], invites: ['a@x.io'], selfEmail: 'me@x.io', driveNames: { d1: 'Product' } });
    expect(loadPendingSetup('org_2')).toBeNull();
    clearPendingSetup('org_1');
    expect(loadPendingSetup('org_1')).toBeNull();
  });

  it('saves nothing when there is nothing to set up', () => {
    savePendingSetup('org_1', { driveIds: [], invites: [], selfEmail: 'me@x.io', driveNames: {} });
    expect(loadPendingSetup('org_1')).toBeNull();
  });

  it('reads a damaged or foreign value as nothing', () => {
    localStorage.setItem('pagespace.orgSetup.org_1', '{not json');
    expect(loadPendingSetup('org_1')).toBeNull();
    localStorage.setItem('pagespace.orgSetup.org_1', JSON.stringify({ driveIds: 'x' }));
    expect(loadPendingSetup('org_1')).toBeNull();
  });
});
