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

const MEMBERSHIPS: ReadonlyArray<{ label: string; membership: OrgDriveMembership | null }> = [
  { label: 'no membership row', membership: null },
  { label: 'an invited MEMBER row', membership: { role: 'MEMBER', customRoleId: null, source: 'invite' } },
  { label: 'an org-materialized MEMBER row', membership: { role: 'MEMBER', customRoleId: 'role_editor', source: 'org' } },
  { label: 'an invited ADMIN row', membership: { role: 'ADMIN', customRoleId: null, source: 'invite' } },
  { label: 'the drive lead OWNER row', membership: { role: 'OWNER', customRoleId: null, source: 'invite' } },
];

type Expected = ReturnType<typeof resolveOrgDriveAccess>;

/** The requirement, stated once as a table oracle independent of the implementation's branch order. */
function expected(input: OrgDriveAccessInput): Expected {
  const { orgRole, driveVisibility, driveMembership, driveDefaultRole } = input;
  if (orgRole === null) return null;
  if (orgRole === 'OWNER' || orgRole === 'ADMIN') {
    if (driveMembership?.role === 'OWNER') {
      return { role: 'OWNER', customRoleId: null, source: driveMembership.source };
    }
    return { role: 'ADMIN', customRoleId: null, source: 'org-admin' };
  }
  if (driveMembership) {
    return { role: driveMembership.role, customRoleId: driveMembership.customRoleId, source: driveMembership.source };
  }
  if (driveVisibility === 'OPEN') {
    return { role: driveDefaultRole.role, customRoleId: driveDefaultRole.customRoleId, source: 'org' };
  }
  return null;
}

const CASES = ORG_ROLES.flatMap((orgRole) =>
  VISIBILITIES.flatMap((driveVisibility) =>
    MEMBERSHIPS.map(({ label, membership }) => ({
      orgRole,
      driveVisibility,
      label,
      input: { orgRole, driveVisibility, driveMembership: membership, driveDefaultRole: DEFAULT_ROLE },
    })),
  ),
);

describe('resolveOrgDriveAccess', () => {
  it('the table covers every (orgRole incl. none, visibility, membership) combination', () => {
    expect(CASES).toHaveLength(ORG_ROLES.length * VISIBILITIES.length * MEMBERSHIPS.length);
    expect(CASES).toHaveLength(60);
  });

  describe.each(CASES)('orgRole $orgRole, $driveVisibility drive, $label', ({ input }) => {
    it('resolves per the org access table', () => {
      expect(resolveOrgDriveAccess(input)).toEqual(expected(input));
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
      for (const { membership } of MEMBERSHIPS) {
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
