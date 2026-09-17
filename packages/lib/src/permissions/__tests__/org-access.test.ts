import { describe, it, expect } from 'vitest';
import {
  resolveOrgDriveAccess,
  type DriveRoleGrant,
  type OrgDriveAccessInput,
  type OrgDriveMembership,
} from '../org-access';

// Northwind Labs fixture names (Sequence Spec): Product is Open, Customer Research is
// Restricted, Finance is Private. The function sees only the facts, never the names.
const ORG_ROLES = ['OWNER', 'ADMIN', 'MEMBER', null] as const;
const VISIBILITIES = ['OPEN', 'RESTRICTED', 'PRIVATE'] as const;

const DEFAULT_ROLE: DriveRoleGrant = { role: 'MEMBER', customRoleId: 'role_viewer' };

type MembershipKey = 'none' | 'inviteMember' | 'orgMember' | 'inviteAdmin' | 'orgAdmin' | 'leadOwner';

const MEMBERSHIPS: Record<MembershipKey, OrgDriveMembership | null> = {
  none: null,
  inviteMember: { role: 'MEMBER', customRoleId: null, source: 'invite' },
  orgMember: { role: 'MEMBER', customRoleId: 'role_editor', source: 'org' },
  inviteAdmin: { role: 'ADMIN', customRoleId: null, source: 'invite' },
  orgAdmin: { role: 'ADMIN', customRoleId: null, source: 'org' },
  leadOwner: { role: 'OWNER', customRoleId: null, source: 'invite' },
};

/**
 * Outcome codes, written out by hand per the leaf, so the table is not a second copy of the
 * implementation's branches: ORG_ADMIN = { ADMIN, org-admin }; ROW = the membership row as-is;
 * DEFAULT = the drive default role with source org; NULL = no org access.
 */
type Outcome = 'ORG_ADMIN' | 'ROW' | 'DEFAULT' | 'NULL';
type Visibility = (typeof VISIBILITIES)[number];
type OrgRoleKey = 'OWNER' | 'ADMIN' | 'MEMBER' | 'none';

// An org-materialized row (source 'org') exists only because of an OPEN drive; on RESTRICTED or
// PRIVATE it is stale (e.g. the drive changed visibility before the sync ran) and counts as no row.
const OWNER_OR_ADMIN_TABLE: Record<Visibility, Record<MembershipKey, Outcome>> = {
  OPEN:       { none: 'ORG_ADMIN', inviteMember: 'ORG_ADMIN', orgMember: 'ORG_ADMIN', inviteAdmin: 'ROW', orgAdmin: 'ROW',       leadOwner: 'ROW' },
  RESTRICTED: { none: 'ORG_ADMIN', inviteMember: 'ORG_ADMIN', orgMember: 'ORG_ADMIN', inviteAdmin: 'ROW', orgAdmin: 'ORG_ADMIN', leadOwner: 'ROW' },
  PRIVATE:    { none: 'ORG_ADMIN', inviteMember: 'ORG_ADMIN', orgMember: 'ORG_ADMIN', inviteAdmin: 'ROW', orgAdmin: 'ORG_ADMIN', leadOwner: 'ROW' },
};

const TABLE: Record<OrgRoleKey, Record<Visibility, Record<MembershipKey, Outcome>>> = {
  OWNER: OWNER_OR_ADMIN_TABLE,
  ADMIN: OWNER_OR_ADMIN_TABLE,
  MEMBER: {
    OPEN:       { none: 'DEFAULT', inviteMember: 'ROW', orgMember: 'ROW',     inviteAdmin: 'ROW', orgAdmin: 'ROW',     leadOwner: 'ROW' },
    RESTRICTED: { none: 'NULL',    inviteMember: 'ROW', orgMember: 'NULL',    inviteAdmin: 'ROW', orgAdmin: 'NULL',    leadOwner: 'ROW' },
    PRIVATE:    { none: 'NULL',    inviteMember: 'ROW', orgMember: 'NULL',    inviteAdmin: 'ROW', orgAdmin: 'NULL',    leadOwner: 'ROW' },
  },
  none: {
    OPEN:       { none: 'NULL', inviteMember: 'NULL', orgMember: 'NULL', inviteAdmin: 'NULL', orgAdmin: 'NULL', leadOwner: 'NULL' },
    RESTRICTED: { none: 'NULL', inviteMember: 'NULL', orgMember: 'NULL', inviteAdmin: 'NULL', orgAdmin: 'NULL', leadOwner: 'NULL' },
    PRIVATE:    { none: 'NULL', inviteMember: 'NULL', orgMember: 'NULL', inviteAdmin: 'NULL', orgAdmin: 'NULL', leadOwner: 'NULL' },
  },
};

function outcomeValue(outcome: Outcome, membership: OrgDriveMembership | null) {
  switch (outcome) {
    case 'ORG_ADMIN':
      return { role: 'ADMIN', customRoleId: null, source: 'org-admin' };
    case 'ROW':
      return membership;
    case 'DEFAULT':
      return { ...DEFAULT_ROLE, source: 'org' };
    case 'NULL':
      return null;
  }
}

const MEMBERSHIP_KEYS = Object.keys(MEMBERSHIPS) as MembershipKey[];

const CASES = ORG_ROLES.flatMap((orgRole) =>
  VISIBILITIES.flatMap((driveVisibility) =>
    MEMBERSHIP_KEYS.map((membershipKey) => {
      const outcome = TABLE[orgRole ?? 'none'][driveVisibility][membershipKey];
      const membership = MEMBERSHIPS[membershipKey];
      const input: OrgDriveAccessInput = { orgRole, driveVisibility, driveMembership: membership, driveDefaultRole: DEFAULT_ROLE };
      return { orgRole, driveVisibility, membershipKey, outcome, input, want: outcomeValue(outcome, membership) };
    }),
  ),
);

describe('resolveOrgDriveAccess', () => {
  it('the table covers every (orgRole incl. none, visibility, membership) combination', () => {
    expect(CASES).toHaveLength(ORG_ROLES.length * VISIBILITIES.length * MEMBERSHIP_KEYS.length);
    expect(CASES).toHaveLength(72);
  });

  describe.each(CASES)('orgRole $orgRole, $driveVisibility drive, membership $membershipKey', ({ input, outcome, want }) => {
    it(`resolves ${outcome}`, () => {
      expect(resolveOrgDriveAccess(input)).toEqual(want);
    });
  });

  describe('ORG-4 (partial) org Owner and Admins resolve ADMIN-equivalent on every org drive', () => {
    it.each(
      (['OWNER', 'ADMIN'] as const).flatMap((orgRole) => VISIBILITIES.map((driveVisibility) => ({ orgRole, driveVisibility }))),
    )('ORG-4 (partial) org $orgRole on a $driveVisibility drive with no row resolves ADMIN via org-admin', ({ orgRole, driveVisibility }) => {
      expect(
        resolveOrgDriveAccess({ orgRole, driveVisibility, driveMembership: null, driveDefaultRole: DEFAULT_ROLE }),
      ).toEqual({ role: 'ADMIN', customRoleId: null, source: 'org-admin' });
    });

    it('ORG-4 (partial) an org Admin on a Private drive is marked org-admin so the resolver can write the audit event', () => {
      const access = resolveOrgDriveAccess({
        orgRole: 'ADMIN',
        driveVisibility: 'PRIVATE',
        driveMembership: { role: 'MEMBER', customRoleId: 'role_viewer', source: 'invite' },
        driveDefaultRole: DEFAULT_ROLE,
      });
      expect(access).toEqual({ role: 'ADMIN', customRoleId: null, source: 'org-admin' });
    });

    it.each(VISIBILITIES)('ORG-4 (partial) an org Admin already holding a drive ADMIN row on a %s drive resolves by the row, not org-admin, so no org-power audit is raised', (driveVisibility) => {
      const row: OrgDriveMembership = { role: 'ADMIN', customRoleId: null, source: 'invite' };
      expect(
        resolveOrgDriveAccess({ orgRole: 'ADMIN', driveVisibility, driveMembership: row, driveDefaultRole: DEFAULT_ROLE }),
      ).toEqual({ role: 'ADMIN', customRoleId: null, source: 'invite' });
    });

    it('ORG-4 (partial) the org branch never downgrades the drive lead OWNER row', () => {
      const access = resolveOrgDriveAccess({
        orgRole: 'ADMIN',
        driveVisibility: 'OPEN',
        driveMembership: { role: 'OWNER', customRoleId: null, source: 'invite' },
        driveDefaultRole: DEFAULT_ROLE,
      });
      expect(access).toEqual({ role: 'OWNER', customRoleId: null, source: 'invite' });
    });
  });

  describe('DRV-5 (partial) Open drive: an org member resolves implicitly with the default role', () => {
    it('DRV-5 (partial) an org MEMBER with no row resolves the drive default role with source org', () => {
      expect(
        resolveOrgDriveAccess({ orgRole: 'MEMBER', driveVisibility: 'OPEN', driveMembership: null, driveDefaultRole: DEFAULT_ROLE }),
      ).toEqual({ role: 'MEMBER', customRoleId: 'role_viewer', source: 'org' });
    });

    it('POL-6 (partial) the implicit role is exactly the drive default role passed in, including a custom role', () => {
      const custom: DriveRoleGrant = { role: 'MEMBER', customRoleId: 'role_contributor' };
      expect(
        resolveOrgDriveAccess({ orgRole: 'MEMBER', driveVisibility: 'OPEN', driveMembership: null, driveDefaultRole: custom }),
      ).toEqual({ role: 'MEMBER', customRoleId: 'role_contributor', source: 'org' });
    });

    it('DRV-5 (partial) an explicit membership row on an Open drive wins over the default role', () => {
      expect(
        resolveOrgDriveAccess({
          orgRole: 'MEMBER',
          driveVisibility: 'OPEN',
          driveMembership: { role: 'ADMIN', customRoleId: null, source: 'invite' },
          driveDefaultRole: DEFAULT_ROLE,
        }),
      ).toEqual({ role: 'ADMIN', customRoleId: null, source: 'invite' });
    });
  });

  describe('X-6 (partial) negatives', () => {
    it.each(VISIBILITIES)('X-6 (partial) a non-member of the org never resolves a %s drive, even with a row', (driveVisibility) => {
      for (const membership of Object.values(MEMBERSHIPS)) {
        expect(
          resolveOrgDriveAccess({ orgRole: null, driveVisibility, driveMembership: membership, driveDefaultRole: DEFAULT_ROLE }),
        ).toBeNull();
      }
    });

    it('DRV-6 (partial) an org MEMBER never resolves a Restricted drive without a row', () => {
      expect(
        resolveOrgDriveAccess({ orgRole: 'MEMBER', driveVisibility: 'RESTRICTED', driveMembership: null, driveDefaultRole: DEFAULT_ROLE }),
      ).toBeNull();
    });

    it('DRV-7 (partial) an org MEMBER never resolves a Private drive without a row', () => {
      expect(
        resolveOrgDriveAccess({ orgRole: 'MEMBER', driveVisibility: 'PRIVATE', driveMembership: null, driveDefaultRole: DEFAULT_ROLE }),
      ).toBeNull();
    });

    it.each(['RESTRICTED', 'PRIVATE'] as const)('DRV-6 (partial) DRV-7 (partial) a stale org-materialized row never opens a %s drive to an org MEMBER', (driveVisibility) => {
      expect(
        resolveOrgDriveAccess({
          orgRole: 'MEMBER',
          driveVisibility,
          driveMembership: { role: 'MEMBER', customRoleId: 'role_editor', source: 'org' },
          driveDefaultRole: DEFAULT_ROLE,
        }),
      ).toBeNull();
    });

    it('ORG-4 (partial) a stale org-materialized ADMIN row on a Private drive still reports org-admin for an org Admin, so the audit is not skipped', () => {
      expect(
        resolveOrgDriveAccess({
          orgRole: 'ADMIN',
          driveVisibility: 'PRIVATE',
          driveMembership: { role: 'ADMIN', customRoleId: null, source: 'org' },
          driveDefaultRole: DEFAULT_ROLE,
        }),
      ).toEqual({ role: 'ADMIN', customRoleId: null, source: 'org-admin' });
    });

    it('DRV-6 (partial) a joined org MEMBER resolves a Restricted drive by the row role, never the default role', () => {
      expect(
        resolveOrgDriveAccess({
          orgRole: 'MEMBER',
          driveVisibility: 'RESTRICTED',
          driveMembership: { role: 'MEMBER', customRoleId: null, source: 'invite' },
          driveDefaultRole: { role: 'ADMIN', customRoleId: null },
        }),
      ).toEqual({ role: 'MEMBER', customRoleId: null, source: 'invite' });
    });
  });
});
