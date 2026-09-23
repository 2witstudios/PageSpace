import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * driveConsenters — the drive's OWNER and ADMINs, pinned as an agent-page account's consenters.
 * Who counts as a drive's admin is a membership answer, so it comes from the permissions layer's
 * drive audience (lead first, then every EFFECTIVE member: pending invitations and stale org rows
 * are no member; an org Owner/Admin's power on an org drive is), never a raw drive_members read.
 */

const { listDriveAudience } = vi.hoisted(() => ({ listDriveAudience: vi.fn() }));
vi.mock('../../permissions/drive-audience', () => ({ listDriveAudience }));
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({ and: vi.fn(), eq: vi.fn(), isNotNull: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({ drives: {}, pages: {} }));
vi.mock('@pagespace/db/schema/members', () => ({ driveMembers: {} }));
vi.mock('../../services/drive-service', () => ({ getDriveAccess: vi.fn() }));
vi.mock('../../permissions/permissions', () => ({ canUserEditPage: vi.fn(), canUserViewPage: vi.fn() }));

import { createAccountFactsRepository } from '../account-facts-repository';

const member = (userId: string, role: 'OWNER' | 'ADMIN' | 'MEMBER', isOwner = false) => ({ userId, role, isOwner, customRoleId: null });

describe('createAccountFactsRepository().driveConsenters', () => {
  beforeEach(() => listDriveAudience.mockReset());

  it('given a drive audience, should pin its lead and its effective ADMINs, sorted, and no MEMBER', async () => {
    listDriveAudience.mockResolvedValue([
      member('u_lead', 'OWNER', true),
      member('u_zed_admin', 'ADMIN'),
      member('u_member', 'MEMBER'),
      // An org Admin with no drive_members row: the audience admits them as ADMIN.
      member('u_org_admin', 'ADMIN'),
    ]);

    const consenters = await createAccountFactsRepository().driveConsenters('drive_1');

    expect(listDriveAudience).toHaveBeenCalledWith('drive_1');
    expect(consenters).toEqual(['u_lead', 'u_org_admin', 'u_zed_admin']);
  });

  it('given a drive with no admins, should pin the lead alone', async () => {
    listDriveAudience.mockResolvedValue([member('u_lead', 'OWNER', true), member('u_member', 'MEMBER')]);

    expect(await createAccountFactsRepository().driveConsenters('drive_1')).toEqual(['u_lead']);
  });

  it('given a missing drive (empty audience), should pin nobody', async () => {
    listDriveAudience.mockResolvedValue([]);

    expect(await createAccountFactsRepository().driveConsenters('drive_gone')).toEqual([]);
  });

  it('given more admins than the bound, should keep the lead and cap the admins at 100', async () => {
    const admins = Array.from({ length: 150 }, (_, i) => member(`u_admin_${String(i).padStart(3, '0')}`, 'ADMIN'));
    listDriveAudience.mockResolvedValue([member('u_zz_lead', 'OWNER', true), ...admins]);

    const consenters = await createAccountFactsRepository().driveConsenters('drive_1');

    expect(consenters).toHaveLength(101);
    expect(consenters).toContain('u_zz_lead');
  });
});
