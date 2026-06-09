import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  planPermissionRestoreOps,
  planMemberRestoreOps,
  planRoleRestoreOps,
} from '../restore-permissions-service';

// ============================================================================
// planPermissionRestoreOps — pure tests
// ============================================================================

describe('planPermissionRestoreOps', () => {
  const affected = ['page-a'];

  it('backup perm for affected page, current has different userId → delete current, insert backup', () => {
    const backupPerms = [{ pageId: 'page-a', userId: 'u1', canView: true, canEdit: false, canShare: false, canDelete: false }];
    const currentPerms = [{ pageId: 'page-a', userId: 'u2' }];
    const result = planPermissionRestoreOps(backupPerms, currentPerms, affected);
    expect(result.toDelete).toEqual([{ pageId: 'page-a', userId: 'u2' }]);
    expect(result.toInsert).toEqual(backupPerms);
  });

  it('current perm for page outside affectedPageIds → not in toDelete', () => {
    const currentPerms = [{ pageId: 'other-page', userId: 'u1' }];
    const result = planPermissionRestoreOps([], currentPerms, affected);
    expect(result.toDelete).toHaveLength(0);
  });

  it('backup empty, current has perms for affected pages → delete all current, insert nothing', () => {
    const currentPerms = [{ pageId: 'page-a', userId: 'u1' }];
    const result = planPermissionRestoreOps([], currentPerms, affected);
    expect(result.toDelete).toHaveLength(1);
    expect(result.toInsert).toHaveLength(0);
  });

  it('both empty → empty result', () => {
    const result = planPermissionRestoreOps([], [], affected);
    expect(result).toEqual({ toDelete: [], toInsert: [] });
  });

  it('calling twice with same args → identical output', () => {
    const backupPerms = [{ pageId: 'page-a', userId: 'u1', canView: true, canEdit: false, canShare: false, canDelete: false }];
    const currentPerms = [{ pageId: 'page-a', userId: 'u2' }];
    expect(planPermissionRestoreOps(backupPerms, currentPerms, affected))
      .toEqual(planPermissionRestoreOps(backupPerms, currentPerms, affected));
  });
});

// ============================================================================
// planMemberRestoreOps — pure tests
// ============================================================================

describe('planMemberRestoreOps', () => {
  it('backup has member X, current has member Y → toDelete Y userId, toInsert X', () => {
    const backupMembers = [{ userId: 'u1', role: 'MEMBER' }];
    const currentMembers = [{ userId: 'u2' }];
    const result = planMemberRestoreOps(backupMembers, currentMembers);
    expect(result.toDelete).toEqual(['u2']);
    expect(result.toInsert).toEqual(backupMembers);
  });

  it('member in both backup and current → still delete+reinsert (full replacement)', () => {
    const backupMembers = [{ userId: 'u1', role: 'MEMBER' }];
    const currentMembers = [{ userId: 'u1' }];
    const result = planMemberRestoreOps(backupMembers, currentMembers);
    expect(result.toDelete).toContain('u1');
    expect(result.toInsert).toEqual(backupMembers);
  });

  it('both empty → empty result', () => {
    expect(planMemberRestoreOps([], [])).toEqual({ toDelete: [], toInsert: [] });
  });
});

// ============================================================================
// planRoleRestoreOps — pure tests (analogous to member tests)
// ============================================================================

describe('planRoleRestoreOps', () => {
  it('backup has role X, current has role Y → toDelete Y roleId, toInsert X', () => {
    const backupRoles = [{ roleId: 'r1', name: 'Editor' }];
    const currentRoles = [{ roleId: 'r2' }];
    const result = planRoleRestoreOps(backupRoles, currentRoles);
    expect(result.toDelete).toEqual(['r2']);
    expect(result.toInsert).toEqual(backupRoles);
  });

  it('both empty → empty result', () => {
    expect(planRoleRestoreOps([], [])).toEqual({ toDelete: [], toInsert: [] });
  });
});

// ============================================================================
// applyPermRestoreOps — effectful executor tests (mock tx with users-table check)
// ============================================================================

vi.mock('@pagespace/db/db', () => ({ db: {} }));

import { applyPermRestoreOps } from '../restore-permissions-service';

const makeTx = (userExists = true) => ({
  delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
  insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(userExists ? [{ id: 'u1' }] : []),
    }),
  }),
});

describe('applyPermRestoreOps', () => {
  const driveId = 'drive_1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('member userId not found in users table → skipped, no insert, no throw', async () => {
    const permOps = { toDelete: [], toInsert: [] };
    const memberOps = { toDelete: [], toInsert: [{ userId: 'u1', role: 'MEMBER' }] };
    const roleOps = { toDelete: [], toInsert: [] };
    const tx = makeTx(false);

    const result = await applyPermRestoreOps(permOps, memberOps, roleOps, driveId, tx as never);
    expect(result.skippedMembers).toContain('u1');
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('all members valid → skippedMembers is empty', async () => {
    const permOps = { toDelete: [], toInsert: [] };
    const memberOps = { toDelete: [], toInsert: [{ userId: 'u1', role: 'MEMBER' }] };
    const roleOps = { toDelete: [], toInsert: [] };
    const tx = makeTx(true);

    const result = await applyPermRestoreOps(permOps, memberOps, roleOps, driveId, tx as never);
    expect(result.skippedMembers).toEqual([]);
    expect(tx.insert).toHaveBeenCalled();
  });

  it('roles inserted correctly → tx.insert called for each backup role', async () => {
    const permOps = { toDelete: [], toInsert: [] };
    const memberOps = { toDelete: [], toInsert: [] };
    const roleOps = { toDelete: [], toInsert: [{ roleId: 'r1', name: 'Admin' }, { roleId: 'r2', name: 'Editor' }] };
    const tx = makeTx(true);

    await applyPermRestoreOps(permOps, memberOps, roleOps, driveId, tx as never);
    expect(tx.insert).toHaveBeenCalledTimes(2);
  });

  it('permissions deleted by pageId scope → only affectedPageIds touched', async () => {
    const permOps = {
      toDelete: [{ pageId: 'page-a', userId: 'u2' }],
      toInsert: [{ pageId: 'page-a', userId: 'u1', canView: true, canEdit: false, canShare: false, canDelete: false }],
    };
    const memberOps = { toDelete: [], toInsert: [] };
    const roleOps = { toDelete: [], toInsert: [] };
    const tx = makeTx(true);

    await applyPermRestoreOps(permOps, memberOps, roleOps, driveId, tx as never);
    expect(tx.delete).toHaveBeenCalled();
    expect(tx.insert).toHaveBeenCalled();
  });

  it('roles are inserted before members (FK ordering for customRoleId)', async () => {
    const permOps = { toDelete: [], toInsert: [] };
    const memberOps = { toDelete: [], toInsert: [{ userId: 'u1', role: 'MEMBER' }] };
    const roleOps = { toDelete: [], toInsert: [{ roleId: 'r1', name: 'Admin' }] };
    const tx = makeTx(true);

    await applyPermRestoreOps(permOps, memberOps, roleOps, driveId, tx as never);

    // All insert().values() calls share the same mock values fn — check call order
    const valuesArgs = tx.insert.mock.results[0].value.values.mock.calls.map(
      (c: unknown[]) => c[0] as Record<string, unknown>,
    );
    const roleIdx = valuesArgs.findIndex((a: Record<string, unknown>) => a.id === 'r1');
    const memberIdx = valuesArgs.findIndex((a: Record<string, unknown>) => a.userId === 'u1');
    expect(roleIdx).not.toBe(-1);
    expect(memberIdx).not.toBe(-1);
    expect(roleIdx).toBeLessThan(memberIdx);
  });

  it('inserted permission preserves grantedBy, note, expiresAt from backup row', async () => {
    const expiresAt = new Date('2025-12-31');
    const permOps = {
      toDelete: [],
      toInsert: [{
        pageId: 'page-a', userId: 'u1', canView: true, canEdit: false, canShare: false, canDelete: false,
        grantedBy: 'admin-1', note: 'restored from backup', expiresAt,
      }],
    };
    const memberOps = { toDelete: [], toInsert: [] };
    const roleOps = { toDelete: [], toInsert: [] };
    const tx = makeTx(true);

    await applyPermRestoreOps(permOps, memberOps, roleOps, driveId, tx as never);

    const insertedPerm = tx.insert.mock.results[0].value.values.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedPerm.grantedBy).toBe('admin-1');
    expect(insertedPerm.note).toBe('restored from backup');
    expect(insertedPerm.expiresAt).toBe(expiresAt);
  });
});
