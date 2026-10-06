import { describe, it, expect } from 'vitest';
import {
  driveAccessWidens,
  memberAccessWidens,
  roleGrantWidens,
  type DriveAccessSnapshot,
  type RoleGrant,
} from '../loosening-core';

const NONE = { canView: false, canEdit: false, canShare: false };
const VIEW = { canView: true, canEdit: false, canShare: false };
const EDIT = { canView: true, canEdit: true, canShare: false };
const ALL = { canView: true, canEdit: true, canShare: true };

const role = (driveWide: RoleGrant['driveWidePermissions'], permissions: RoleGrant['permissions'] = {}): RoleGrant => ({ driveWidePermissions: driveWide, permissions });

const DRIVE = { leadId: 'lead', orgId: 'org' as string | null, orgVisibility: 'RESTRICTED' as const };

function snapshot(over: Partial<DriveAccessSnapshot> = {}): DriveAccessSnapshot {
  return {
    drive: DRIVE,
    members: {},
    grants: {},
    roles: {},
    agents: {},
    ...over,
  };
}

describe('roleGrantWidens', () => {
  it('SEAT-9 (partial) [D-OW-33] a role widens when it gains a drive-wide flag, a page flag, or a drive-wide fallback on a page it listed narrower', () => {
    expect(roleGrantWidens(role(VIEW), role(EDIT))).toBe(true);
    expect(roleGrantWidens(role(null), role(VIEW))).toBe(true);
    expect(roleGrantWidens(role(null, { p1: VIEW }), role(null, { p1: EDIT }))).toBe(true);
    expect(roleGrantWidens(role(null, { p1: VIEW }), role(null, { p1: VIEW, p2: VIEW }))).toBe(true);
    // p1 was listed with nothing; dropping the entry lets the new drive-wide view fall through onto it.
    expect(roleGrantWidens(role(null, { p1: NONE }), role(VIEW))).toBe(true);
    // A page entry the old role did not list is judged against the old entry only: the page may be private, where
    // the old drive-wide grant never reached.
    expect(roleGrantWidens(role(ALL), role(ALL, { p1: VIEW }))).toBe(true);
    expect(roleGrantWidens(null, role(VIEW))).toBe(true);
  });

  it('SEAT-9 (partial) [D-OW-33] a role that keeps or loses flags does not widen', () => {
    expect(roleGrantWidens(role(EDIT), role(VIEW))).toBe(false);
    expect(roleGrantWidens(role(EDIT), role(EDIT))).toBe(false);
    expect(roleGrantWidens(role(VIEW, { p1: ALL }), role(VIEW, { p1: VIEW }))).toBe(false);
    expect(roleGrantWidens(role(VIEW, { p1: ALL }), role(null))).toBe(false);
    expect(roleGrantWidens(role(VIEW), null)).toBe(false);
    expect(roleGrantWidens(null, null)).toBe(false);
    expect(roleGrantWidens(role(VIEW), role(VIEW, { p1: NONE }))).toBe(false);
  });
});

describe('memberAccessWidens', () => {
  it('SEAT-9 (partial) [D-OW-33] a new row, a promotion, a guest becoming a member, and a wider custom role widen', () => {
    expect(memberAccessWidens(null, { role: 'MEMBER', customRole: null })).toBe(true);
    expect(memberAccessWidens(null, { role: 'GUEST', customRole: null })).toBe(true);
    expect(memberAccessWidens({ role: 'MEMBER', customRole: null }, { role: 'ADMIN', customRole: null })).toBe(true);
    expect(memberAccessWidens({ role: 'ADMIN', customRole: null }, { role: 'OWNER', customRole: null })).toBe(true);
    expect(memberAccessWidens({ role: 'GUEST', customRole: null }, { role: 'MEMBER', customRole: role(null) })).toBe(true);
    expect(memberAccessWidens({ role: 'MEMBER', customRole: role(VIEW) }, { role: 'MEMBER', customRole: role(EDIT) })).toBe(true);
    // From the plain member role (view of non-private pages): a custom role that lists a page, or edits drive-wide.
    expect(memberAccessWidens({ role: 'MEMBER', customRole: null }, { role: 'MEMBER', customRole: role(null, { p1: VIEW }) })).toBe(true);
    expect(memberAccessWidens({ role: 'MEMBER', customRole: null }, { role: 'MEMBER', customRole: role(EDIT) })).toBe(true);
    // To the plain member role: unless the old role already viewed and edited everywhere it reached.
    expect(memberAccessWidens({ role: 'MEMBER', customRole: role(VIEW) }, { role: 'MEMBER', customRole: null })).toBe(true);
    expect(memberAccessWidens({ role: 'MEMBER', customRole: role(EDIT, { p1: VIEW }) }, { role: 'MEMBER', customRole: null })).toBe(true);
  });

  it('SEAT-9 (partial) [D-OW-33] a demotion, a narrower custom role, becoming a guest, and no change do not widen', () => {
    expect(memberAccessWidens({ role: 'ADMIN', customRole: null }, { role: 'MEMBER', customRole: role(ALL) })).toBe(false);
    expect(memberAccessWidens({ role: 'OWNER', customRole: null }, { role: 'ADMIN', customRole: null })).toBe(false);
    expect(memberAccessWidens({ role: 'ADMIN', customRole: null }, { role: 'ADMIN', customRole: role(ALL) })).toBe(false);
    expect(memberAccessWidens({ role: 'MEMBER', customRole: role(EDIT) }, { role: 'MEMBER', customRole: role(VIEW) })).toBe(false);
    expect(memberAccessWidens({ role: 'MEMBER', customRole: null }, { role: 'GUEST', customRole: null })).toBe(false);
    expect(memberAccessWidens({ role: 'MEMBER', customRole: null }, { role: 'MEMBER', customRole: null })).toBe(false);
    // Plain member → a role that only views drive-wide: never more than the plain role.
    expect(memberAccessWidens({ role: 'MEMBER', customRole: null }, { role: 'MEMBER', customRole: role(VIEW) })).toBe(false);
    expect(memberAccessWidens({ role: 'MEMBER', customRole: null }, { role: 'MEMBER', customRole: role(null, { p1: NONE }) })).toBe(false);
    // A role that viewed and edited everywhere it reached → the plain member role.
    expect(memberAccessWidens({ role: 'MEMBER', customRole: role(EDIT, { p1: EDIT }) }, { role: 'MEMBER', customRole: null })).toBe(false);
  });
});

describe('driveAccessWidens', () => {
  it('SEAT-9 (partial) [D-OW-33] no change, removals and narrowing do not widen a drive', () => {
    const before = snapshot({
      members: { u1: { role: 'ADMIN', customRoleId: null, accepted: true }, u2: { role: 'MEMBER', customRoleId: 'r1', accepted: true } },
      grants: { 'p1:u2': { canView: true, canEdit: true, canShare: false, canDelete: false } },
      roles: { r1: { grant: role(EDIT), isDefault: false } },
      agents: { a1: { role: 'MEMBER', customRoleId: null, includeContext: true } },
    });
    expect(driveAccessWidens(before, before)).toBe(false);
    expect(driveAccessWidens(before, snapshot())).toBe(false);
    expect(driveAccessWidens(before, snapshot({
      members: { u1: { role: 'MEMBER', customRoleId: null, accepted: true }, u2: { role: 'MEMBER', customRoleId: 'r1', accepted: true } },
      grants: { 'p1:u2': { canView: true, canEdit: false, canShare: false, canDelete: false } },
      roles: { r1: { grant: role(VIEW), isDefault: false } },
      agents: { a1: { role: 'MEMBER', customRoleId: null, includeContext: false } },
    }))).toBe(false);
    expect(driveAccessWidens(snapshot({ drive: { leadId: 'lead', orgId: 'org', orgVisibility: 'OPEN' } }), snapshot({ drive: { leadId: 'lead', orgId: 'org', orgVisibility: 'PRIVATE' } }))).toBe(false);
  });

  it('SEAT-9 (partial) [D-OW-33] a new or newly accepted member, a promotion, a wider held role, a wider grant, a new or wider agent, a lead change and a more open drive each widen', () => {
    const base = snapshot({
      members: { u2: { role: 'MEMBER', customRoleId: 'r1', accepted: true }, u3: { role: 'MEMBER', customRoleId: null, accepted: false } },
      roles: { r1: { grant: role(VIEW), isDefault: false }, r2: { grant: role(VIEW), isDefault: false } },
      agents: { a1: { role: 'MEMBER', customRoleId: null, includeContext: false } },
    });
    const widened = (over: Partial<DriveAccessSnapshot>) => driveAccessWidens(base, { ...base, ...over });
    expect(widened({ members: { ...base.members, u4: { role: 'MEMBER', customRoleId: null, accepted: true } } })).toBe(true);
    expect(widened({ members: { ...base.members, u3: { role: 'MEMBER', customRoleId: null, accepted: true } } })).toBe(true);
    expect(widened({ members: { ...base.members, u2: { role: 'ADMIN', customRoleId: null, accepted: true } } })).toBe(true);
    expect(widened({ roles: { ...base.roles, r1: { grant: role(EDIT), isDefault: false } } })).toBe(true);
    expect(widened({ grants: { 'p1:u2': { canView: true, canEdit: false, canShare: false, canDelete: false } } })).toBe(true);
    expect(widened({ agents: { ...base.agents, a2: { role: 'MEMBER', customRoleId: null, includeContext: false } } })).toBe(true);
    expect(widened({ agents: { a1: { role: 'MEMBER', customRoleId: null, includeContext: true } } })).toBe(true);
    expect(widened({ agents: { a1: { role: 'ADMIN', customRoleId: null, includeContext: false } } })).toBe(true);
    expect(widened({ drive: { ...DRIVE, leadId: 'someone-else' } })).toBe(true);
    expect(widened({ drive: { ...DRIVE, orgVisibility: 'OPEN' } })).toBe(true);
    expect(widened({ drive: { ...DRIVE, orgId: 'other-org' } })).toBe(true);
  });

  it('SEAT-9 (partial) [D-OW-33] widening a role nobody holds does not widen the drive; a pending row stays pending without widening', () => {
    const base = snapshot({
      members: { u3: { role: 'MEMBER', customRoleId: 'r2', accepted: false } },
      roles: { r1: { grant: role(VIEW), isDefault: false }, r2: { grant: role(VIEW), isDefault: false } },
    });
    expect(driveAccessWidens(base, { ...base, roles: { ...base.roles, r1: { grant: role(ALL), isDefault: false } } })).toBe(false);
    // A pending invitation grants nothing yet, so its role may change freely (accepting it is what is guarded).
    expect(driveAccessWidens(base, { ...base, roles: { ...base.roles, r2: { grant: role(ALL), isDefault: false } } })).toBe(false);
  });
});
