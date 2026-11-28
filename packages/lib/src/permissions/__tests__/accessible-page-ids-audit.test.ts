import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('../org-admin-access-audit', () => ({ auditOrgAdminPrivateDriveAccess: vi.fn(async () => undefined) }));
vi.mock('../actor-authentication', () => ({ dropWithheldDerivedPages: vi.fn(), filterDrivesForActor: vi.fn() }));

import { auditOrgAdminPrivateDriveAccess } from '../org-admin-access-audit';
import { auditOrgPowerAccess } from '../accessible-page-ids';

beforeEach(() => vi.mocked(auditOrgAdminPrivateDriveAccess).mockClear());

describe('auditOrgPowerAccess', () => {
  it('ORG-4 (partial) writes one event per PRIVATE drive org power opened, and none for rows org power did not open', () => {
    auditOrgPowerAccess('user-1', [
      { org_power_drive_id: 'drive-a', org_power_org_id: 'org-1', org_power_role: 'ADMIN' },
      { org_power_drive_id: 'drive-a', org_power_org_id: 'org-1', org_power_role: 'ADMIN' },
      { org_power_drive_id: 'drive-b', org_power_org_id: 'org-1', org_power_role: 'OWNER' },
      { org_power_drive_id: null, org_power_org_id: null, org_power_role: null },
      { org_power_drive_id: 'drive-c', org_power_org_id: null, org_power_role: 'ADMIN' },
      { org_power_drive_id: 'drive-d', org_power_org_id: 'org-1', org_power_role: 'GUEST' },
    ]);
    expect(vi.mocked(auditOrgAdminPrivateDriveAccess).mock.calls.map(([event]) => event)).toEqual([
      { userId: 'user-1', driveId: 'drive-a', orgId: 'org-1', orgRole: 'ADMIN' },
      { userId: 'user-1', driveId: 'drive-b', orgId: 'org-1', orgRole: 'OWNER' },
    ]);
  });

  it('ORG-4 (partial) a member role is still an org role, so a row naming one is audited', () => {
    auditOrgPowerAccess('user-1', [{ org_power_drive_id: 'drive-e', org_power_org_id: 'org-1', org_power_role: 'MEMBER' }]);
    expect(auditOrgAdminPrivateDriveAccess).toHaveBeenCalledWith({ userId: 'user-1', driveId: 'drive-e', orgId: 'org-1', orgRole: 'MEMBER' });
  });
});
