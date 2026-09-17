import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The IO shape of loadEffectiveDriveMembership: which queries run, in which order, and when the
 * ORG-4 audit event is written. The decision itself is pinned in org-drive-resolution.test.ts and
 * the real rows in org-drive-resolvers.integration.test.ts.
 */

const flags = vi.hoisted(() => ({ orgsEnabled: false }));
const selects = vi.hoisted(() => ({ results: [] as unknown[][], tables: [] as string[] }));

vi.mock('../../organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: { __table: string }) => {
        selects.tables.push(table.__table);
        const chain = {
          where: () => chain,
          limit: async () => selects.results.shift() ?? [],
        };
        return chain;
      },
    })),
  },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: { __table: 'drive_members', driveId: 'driveId', userId: 'userId', role: 'role', customRoleId: 'customRoleId', source: 'source', acceptedAt: 'acceptedAt' },
  driveRoles: { __table: 'drive_roles', id: 'id', driveId: 'driveId', isDefault: 'isDefault' },
}));
vi.mock('@pagespace/db/schema/organizations', () => ({
  orgMembers: { __table: 'org_members', orgId: 'orgId', userId: 'userId', role: 'role' },
}));
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNotNull: vi.fn(),
}));
vi.mock('../../audit/audit-log', () => ({ audit: vi.fn() }));

import { audit } from '../../audit/audit-log';
import { loadEffectiveDriveMembership } from '../org-drive-membership';

const PRIVATE_ORG_DRIVE = { id: 'drive_finance', orgId: 'org_northwind', orgVisibility: 'PRIVATE' as const };
const OPEN_ORG_DRIVE = { id: 'drive_product', orgId: 'org_northwind', orgVisibility: 'OPEN' as const };

describe('loadEffectiveDriveMembership', () => {
  beforeEach(() => {
    flags.orgsEnabled = false;
    selects.results = [];
    selects.tables = [];
    vi.mocked(audit).mockClear();
  });

  it('while ORGS_ENABLED is false runs only the drive_members query, even for an org drive, and never audits', async () => {
    selects.results = [[{ role: 'MEMBER', customRoleId: null, source: 'org' }]];

    const result = await loadEffectiveDriveMembership('user_marcus', PRIVATE_ORG_DRIVE);

    expect(selects.tables).toEqual(['drive_members']);
    expect(result).toEqual({ role: 'MEMBER', customRoleId: null, source: 'org', auditOrgAdminPrivateAccess: false });
    expect(audit).not.toHaveBeenCalled();
  });

  it('while ORGS_ENABLED is true runs no org query for a personal drive or a drive row without org facts', async () => {
    flags.orgsEnabled = true;

    expect(await loadEffectiveDriveMembership('user_nina', { id: 'drive_notes', orgId: null, orgVisibility: 'OPEN' })).toBeNull();
    expect(await loadEffectiveDriveMembership('user_nina', { id: 'drive_notes' })).toBeNull();

    expect(selects.tables).toEqual(['drive_members', 'drive_members']);
  });

  it('DRV-5 (partial) reads the org role, then the drive default role, for an org member with no row on an OPEN drive', async () => {
    flags.orgsEnabled = true;
    selects.results = [[], [{ role: 'MEMBER' }], [{ id: 'role_contributor' }]];

    const result = await loadEffectiveDriveMembership('user_nina', OPEN_ORG_DRIVE);

    expect(selects.tables).toEqual(['drive_members', 'org_members', 'drive_roles']);
    expect(result).toEqual({ role: 'MEMBER', customRoleId: 'role_contributor', source: 'org', auditOrgAdminPrivateAccess: false });
  });

  it('ORG-4 (partial) writes one authz.access.granted audit event when an org Admin opens a PRIVATE drive through org power', async () => {
    flags.orgsEnabled = true;
    selects.results = [[], [{ role: 'ADMIN' }]];

    const result = await loadEffectiveDriveMembership('user_priya', PRIVATE_ORG_DRIVE);

    expect(selects.tables).toEqual(['drive_members', 'org_members']);
    expect(result).toMatchObject({ role: 'ADMIN', source: 'org-admin' });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      eventType: 'authz.access.granted',
      userId: 'user_priya',
      resourceType: 'drive',
      resourceId: 'drive_finance',
      details: { via: 'org_admin', orgId: 'org_northwind', orgRole: 'ADMIN', orgVisibility: 'PRIVATE' },
    });
  });

  it('ORG-4 (partial) writes no audit event when an org Admin opens an OPEN drive, or a PRIVATE drive through their own ADMIN row', async () => {
    flags.orgsEnabled = true;
    selects.results = [[], [{ role: 'ADMIN' }], [{ role: 'ADMIN', customRoleId: null, source: 'invite' }], [{ role: 'ADMIN' }]];

    await loadEffectiveDriveMembership('user_priya', OPEN_ORG_DRIVE);
    await loadEffectiveDriveMembership('user_omar', PRIVATE_ORG_DRIVE);

    expect(audit).not.toHaveBeenCalled();
  });
});
