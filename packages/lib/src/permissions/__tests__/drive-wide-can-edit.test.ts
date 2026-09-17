/**
 * resolveDriveWideCanEdit — the single drive-wide canEdit rule (#2627).
 *
 * owner / admin / plain member => true. A custom role bounds a MEMBER's
 * drive-wide edit to what the role's driveWidePermissions explicitly grant.
 * Unresolvable roles and null driveWidePermissions fail closed. This rule is
 * what every root-create affordance and check must agree on: the drives DTO
 * flag, getUserAccessLevel's drive-as-root fallback, and the token resolvers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({ db: { select: vi.fn() } }));
vi.mock('@pagespace/db/schema/members', () => ({
  driveRoles: {
    id: 'driveRoles.id',
    driveId: 'driveRoles.driveId',
    driveWidePermissions: 'driveRoles.driveWidePermissions',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));

import { resolveDriveWideCanEdit } from '../membership-queries';
import { db } from '@pagespace/db/db';

function chain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

describe('resolveDriveWideCanEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given no entries, should return an empty map without touching the database', async () => {
    const map = await resolveDriveWideCanEdit([]);
    expect(map.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('given owner, admin and plain-member drives, should grant edit without querying custom roles', async () => {
    const map = await resolveDriveWideCanEdit([
      { driveId: 'd_owner', role: 'OWNER', customRoleId: null },
      { driveId: 'd_admin', role: 'ADMIN', customRoleId: null },
      { driveId: 'd_member', role: 'MEMBER', customRoleId: null },
    ]);
    expect(map.get('d_owner')).toBe(true);
    expect(map.get('d_admin')).toBe(true);
    expect(map.get('d_member')).toBe(true);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('given custom-role members, should batch-resolve all roles in one query', async () => {
    vi.mocked(db.select).mockReturnValue(
      chain([
        { id: 'role_edit', driveWidePermissions: { canView: true, canEdit: true, canShare: false } },
        { id: 'role_view', driveWidePermissions: { canView: true, canEdit: false, canShare: false } },
      ]),
    );
    const map = await resolveDriveWideCanEdit([
      { driveId: 'd_edit', role: 'MEMBER', customRoleId: 'role_edit' },
      { driveId: 'd_view', role: 'MEMBER', customRoleId: 'role_view' },
      { driveId: 'd_shared_role', role: 'MEMBER', customRoleId: 'role_edit' },
    ]);
    expect(map.get('d_edit')).toBe(true);
    expect(map.get('d_view')).toBe(false);
    expect(map.get('d_shared_role')).toBe(true);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('given an unresolvable custom role, should fail closed', async () => {
    vi.mocked(db.select).mockReturnValue(chain([]));
    const map = await resolveDriveWideCanEdit([
      { driveId: 'd_gone', role: 'MEMBER', customRoleId: 'role_gone' },
    ]);
    expect(map.get('d_gone')).toBe(false);
  });

  it('given a custom role with null driveWidePermissions, should fail closed', async () => {
    vi.mocked(db.select).mockReturnValue(chain([{ id: 'role_null', driveWidePermissions: null }]));
    const map = await resolveDriveWideCanEdit([
      { driveId: 'd_null', role: 'MEMBER', customRoleId: 'role_null' },
    ]);
    expect(map.get('d_null')).toBe(false);
  });
});
