import { beforeEach, describe, expect, it } from 'vitest';
import { clearPendingSetup, loadPendingSetup, purgePendingSetups, savePendingSetup } from '../pending-setup';
import { clearStoresIfUserChanged } from '@/lib/auth/clear-user-stores';

const plan = { driveIds: ['d1'], invites: ['a@x.io'], selfEmail: 'me@x.io', driveNames: { d1: 'Product' } };

beforeEach(() => localStorage.clear());

describe('pending org setup', () => {
  it('UI-6 (partial): keeps the chosen drives and invitations for one person and one org until setup runs', () => {
    savePendingSetup('u_a', 'org_1', plan);
    expect(loadPendingSetup('u_a', 'org_1')).toEqual(plan);
    expect(loadPendingSetup('u_a', 'org_2')).toBeNull();
    clearPendingSetup('u_a', 'org_1');
    expect(loadPendingSetup('u_a', 'org_1')).toBeNull();
  });

  it('another person on the same browser never sees it, even for the same org', () => {
    savePendingSetup('u_a', 'org_1', plan);
    expect(loadPendingSetup('u_b', 'org_1')).toBeNull();
  });

  it('an account switch purges every saved plan (sign-in cleanup)', () => {
    clearStoresIfUserChanged('u_a');
    savePendingSetup('u_a', 'org_1', plan);
    localStorage.setItem('unrelated', 'kept');
    clearStoresIfUserChanged('u_b');
    expect(localStorage.getItem('pagespace.orgSetup.u_a.org_1')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('kept');
  });

  it('the same person signing in again keeps their plan', () => {
    clearStoresIfUserChanged('u_a');
    savePendingSetup('u_a', 'org_1', plan);
    clearStoresIfUserChanged('u_a');
    expect(loadPendingSetup('u_a', 'org_1')).toEqual(plan);
  });

  it('sign-out purges every saved plan', () => {
    savePendingSetup('u_a', 'org_1', plan);
    savePendingSetup('u_a', 'org_2', plan);
    purgePendingSetups();
    expect(loadPendingSetup('u_a', 'org_1')).toBeNull();
    expect(loadPendingSetup('u_a', 'org_2')).toBeNull();
  });

  it('holds no secrets: only drive ids and names, invitee addresses and the creator address', () => {
    savePendingSetup('u_a', 'org_1', plan);
    expect(Object.keys(JSON.parse(localStorage.getItem('pagespace.orgSetup.u_a.org_1') ?? '{}')).sort()).toEqual(['driveIds', 'driveNames', 'invites', 'selfEmail']);
  });

  it('saves nothing when there is nothing to set up', () => {
    savePendingSetup('u_a', 'org_1', { driveIds: [], invites: [], selfEmail: 'me@x.io', driveNames: {} });
    expect(loadPendingSetup('u_a', 'org_1')).toBeNull();
  });

  it('reads a damaged or foreign value as nothing', () => {
    localStorage.setItem('pagespace.orgSetup.u_a.org_1', '{not json');
    expect(loadPendingSetup('u_a', 'org_1')).toBeNull();
    localStorage.setItem('pagespace.orgSetup.u_a.org_1', JSON.stringify({ driveIds: 'x' }));
    expect(loadPendingSetup('u_a', 'org_1')).toBeNull();
  });
});
