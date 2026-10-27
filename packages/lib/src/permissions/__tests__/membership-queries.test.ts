import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({ db: { select: vi.fn() } }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: {}, drives: {} }));
vi.mock('@pagespace/db/schema/members', () => ({ driveRoles: { id: 'id', driveId: 'driveId', permissions: 'permissions' }, driveMembers: {}, pagePermissions: {} }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(), and: vi.fn() }));

import { resolveCustomRolePermissions } from '../membership-queries';

describe('resolveCustomRolePermissions', () => {
  it('returns driveWidePermissions when pageId is absent from per-page map', () => {
    const role = {
      permissions: { 'p1': { canView: true, canEdit: true, canShare: true } },
      driveWidePermissions: { canView: true, canEdit: false, canShare: false },
    };
    expect(resolveCustomRolePermissions(role, 'new-page')).toEqual({
      canView: true,
      canEdit: false,
      canShare: false,
    });
  });

  it('per-page entry wins over driveWidePermissions when pageId is present', () => {
    const role = {
      permissions: {
        'p1': { canView: true, canEdit: false, canShare: false },
      },
      driveWidePermissions: { canView: true, canEdit: true, canShare: false },
    };
    // Explicit per-page entry overrides drive-wide
    expect(resolveCustomRolePermissions(role, 'p1')).toEqual({
      canView: true,
      canEdit: false,
      canShare: false,
    });
    // Page not in map falls back to drive-wide
    expect(resolveCustomRolePermissions(role, 'other-page')).toEqual({
      canView: true,
      canEdit: true,
      canShare: false,
    });
  });

  it('returns null when driveWidePermissions is null and pageId is absent from per-page map', () => {
    const role = {
      permissions: { 'p1': { canView: true, canEdit: true, canShare: true } },
      driveWidePermissions: null,
    };
    expect(resolveCustomRolePermissions(role, 'x')).toBeNull();
  });

  it('returns per-page entry when driveWidePermissions is null and pageId is present', () => {
    const role = {
      permissions: { 'x': { canView: true, canEdit: false, canShare: true } },
      driveWidePermissions: null,
    };
    expect(resolveCustomRolePermissions(role, 'x')).toEqual({
      canView: true,
      canEdit: false,
      canShare: true,
    });
  });
});
