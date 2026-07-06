/**
 * resolveGrantAuthority (extracted from the authorize/route.ts consent
 * check, ADR 0002 Decision 2, reused by the device-decision P1b check).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDriveAccess = vi.fn();
vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: (...args: unknown[]) => getDriveAccess(...args),
}));

const getMemberCustomRoleId = vi.fn();
const customRoleBelongsToDrive = vi.fn();
vi.mock('@pagespace/lib/permissions/membership-queries', () => ({
  getMemberCustomRoleId: (...args: unknown[]) => getMemberCustomRoleId(...args),
  customRoleBelongsToDrive: (...args: unknown[]) => customRoleBelongsToDrive(...args),
}));

import { resolveGrantAuthority } from '../oauth-grant-authority';
import type { ScopeSet } from '@pagespace/lib/auth/oauth/scopes';

function scopeSet(drives: Array<[string, ScopeSet['drives'] extends ReadonlyMap<string, infer V> ? V : never]>): ScopeSet {
  return { account: false, offlineAccess: false, drives: new Map(drives), manageKeys: false };
}

const USER_ID = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
  getDriveAccess.mockResolvedValue({ isOwner: true, isAdmin: true, isMember: true, role: 'OWNER' });
  getMemberCustomRoleId.mockResolvedValue(null);
  customRoleBelongsToDrive.mockResolvedValue(true);
});

describe('resolveGrantAuthority', () => {
  it('resolves authority for a single drive scope', async () => {
    const scopes = scopeSet([['drive-1', { kind: 'drive', driveId: 'drive-1', role: { kind: 'inherit' } }]]);

    const authority = await resolveGrantAuthority(scopes, USER_ID);

    expect(authority.size).toBe(1);
    expect(authority.get('drive-1')).toMatchObject({ isOwner: true, isAdmin: true, isMember: true });
    expect(getDriveAccess).toHaveBeenCalledWith('drive-1', USER_ID);
  });

  it('resolves authority for every drive in a multi-drive scope set', async () => {
    const scopes = scopeSet([
      ['drive-1', { kind: 'drive', driveId: 'drive-1', role: { kind: 'inherit' } }],
      ['drive-2', { kind: 'drive', driveId: 'drive-2', role: { kind: 'admin' } }],
      ['drive-3', { kind: 'drive', driveId: 'drive-3', role: { kind: 'member' } }],
    ]);

    const authority = await resolveGrantAuthority(scopes, USER_ID);

    expect(authority.size).toBe(3);
    expect(getDriveAccess).toHaveBeenCalledTimes(3);
    expect(getDriveAccess).toHaveBeenCalledWith('drive-1', USER_ID);
    expect(getDriveAccess).toHaveBeenCalledWith('drive-2', USER_ID);
    expect(getDriveAccess).toHaveBeenCalledWith('drive-3', USER_ID);
  });

  it('only checks customRoleBelongsToDrive for a custom-role scope, not for inherit/admin/member', async () => {
    const scopes = scopeSet([
      ['drive-1', { kind: 'drive', driveId: 'drive-1', role: { kind: 'inherit' } }],
      ['drive-2', { kind: 'drive', driveId: 'drive-2', role: { kind: 'custom', customRoleId: 'role-x' } }],
    ]);

    await resolveGrantAuthority(scopes, USER_ID);

    expect(customRoleBelongsToDrive).toHaveBeenCalledTimes(1);
    expect(customRoleBelongsToDrive).toHaveBeenCalledWith('role-x', 'drive-2');
  });

  it("wires roleBelongsToDrive() to customRoleBelongsToDrive's resolved value for a custom-role scope", async () => {
    customRoleBelongsToDrive.mockResolvedValue(false);
    const scopes = scopeSet([['drive-1', { kind: 'drive', driveId: 'drive-1', role: { kind: 'custom', customRoleId: 'role-x' } }]]);

    const authority = await resolveGrantAuthority(scopes, USER_ID);

    expect(authority.get('drive-1')?.roleBelongsToDrive('role-x')).toBe(false);
  });

  it('returns an empty map for a scope set with no drive scopes, without calling any lookup', async () => {
    const scopes = scopeSet([]);

    const authority = await resolveGrantAuthority(scopes, USER_ID);

    expect(authority.size).toBe(0);
    expect(getDriveAccess).not.toHaveBeenCalled();
  });

  it('resolves per-drive lookups concurrently, not serialized one drive at a time', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    getDriveAccess.mockImplementation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      return { isOwner: true, isAdmin: true, isMember: true, role: 'OWNER' };
    });

    const scopes = scopeSet([
      ['drive-1', { kind: 'drive', driveId: 'drive-1', role: { kind: 'inherit' } }],
      ['drive-2', { kind: 'drive', driveId: 'drive-2', role: { kind: 'inherit' } }],
      ['drive-3', { kind: 'drive', driveId: 'drive-3', role: { kind: 'inherit' } }],
    ]);

    await resolveGrantAuthority(scopes, USER_ID);

    // Serialized (for-of + await one drive at a time) would never exceed 1.
    expect(maxConcurrent).toBeGreaterThan(1);
  });
});
