import { describe, it, expect } from 'vitest';
import {
  planDriveOrgMembership,
  chunk,
  settleInBatches,
  summarizeAffectedUsers,
  type OrgSyncDrive,
  type ExistingDriveMemberRow,
  type DriveOrgMembershipPlan,
} from '../org-membership-sync-core';

const openDrive = (overrides: Partial<OrgSyncDrive> = {}): OrgSyncDrive => ({
  id: 'drive-product',
  ownerId: 'user-jono',
  orgId: 'org-northwind',
  orgVisibility: 'OPEN',
  defaultCustomRoleId: null,
  ...overrides,
});

const row = (
  userId: string,
  source: ExistingDriveMemberRow['source'],
  driveId = 'drive-product',
  overrides: Partial<ExistingDriveMemberRow> = {},
): ExistingDriveMemberRow => ({
  id: `row-${driveId}-${userId}`,
  driveId,
  userId,
  source,
  customRoleId: null,
  accepted: true,
  ...overrides,
});

const emptyPlan = (driveId = 'drive-product'): DriveOrgMembershipPlan => ({
  driveId,
  inserts: [],
  deletes: [],
  conversions: [],
  repairs: [],
  admissions: [],
});

describe('planDriveOrgMembership', () => {
  it('DRV-5 (partial) materializes an org-sourced row for every org member of an Open drive who has none', () => {
    const plan = planDriveOrgMembership({
      drive: openDrive({ defaultCustomRoleId: 'role-default' }),
      orgMemberUserIds: ['user-priya', 'user-marcus'],
      existingRows: [],
    });

    expect(plan.inserts).toEqual([
      { driveId: 'drive-product', userId: 'user-priya', customRoleId: 'role-default' },
      { driveId: 'drive-product', userId: 'user-marcus', customRoleId: 'role-default' },
    ]);
    expect(plan.deletes).toEqual([]);
    expect(plan.conversions).toEqual([]);
  });

  it('DRV-5 (partial) never materializes a row for the drive lead, whose ownership lives on drives.ownerId', () => {
    const plan = planDriveOrgMembership({
      drive: openDrive(),
      orgMemberUserIds: ['user-jono', 'user-priya'],
      existingRows: [],
    });

    expect(plan.inserts.map((i) => i.userId)).toEqual(['user-priya']);
  });

  it('D-OW-6 is idempotent: a drive already in step plans no change', () => {
    const plan = planDriveOrgMembership({
      drive: openDrive(),
      orgMemberUserIds: ['user-priya', 'user-marcus'],
      existingRows: [row('user-priya', 'org'), row('user-marcus', 'org')],
    });

    expect(plan).toEqual(emptyPlan());
  });

  it('D-OW-6 leaves an org member who already holds an invited row alone (no duplicate, no downgrade)', () => {
    const plan = planDriveOrgMembership({
      drive: openDrive(),
      orgMemberUserIds: ['user-dana'],
      existingRows: [row('user-dana', 'invite')],
    });

    expect(plan).toEqual(emptyPlan());
  });

  it('D-OW-6 removes the org-sourced row of a user who left the org', () => {
    const plan = planDriveOrgMembership({
      drive: openDrive(),
      orgMemberUserIds: ['user-priya'],
      existingRows: [row('user-priya', 'org'), row('user-lena', 'org')],
    });

    expect(plan.inserts).toEqual([]);
    expect(plan.deletes).toEqual([{ rowId: 'row-drive-product-user-lena', driveId: 'drive-product', userId: 'user-lena' }]);
  });

  it.each(['RESTRICTED', 'PRIVATE'] as const)(
    'D-OW-6 removes every org-sourced row when visibility changes away from Open (%s)',
    (orgVisibility) => {
      const plan = planDriveOrgMembership({
        drive: openDrive({ orgVisibility }),
        orgMemberUserIds: ['user-priya', 'user-marcus'],
        existingRows: [row('user-priya', 'org'), row('user-marcus', 'org')],
      });

      expect(plan.inserts).toEqual([]);
      expect(plan.deletes.map((d) => d.userId)).toEqual(['user-priya', 'user-marcus']);
    },
  );

  it('D-OW-6 removes every org-sourced row of a drive moved out of its org by default', () => {
    const plan = planDriveOrgMembership({
      drive: openDrive({ orgId: null }),
      orgMemberUserIds: ['user-priya'],
      existingRows: [row('user-priya', 'org')],
    });

    expect(plan.inserts).toEqual([]);
    expect(plan.deletes.map((d) => d.userId)).toEqual(['user-priya']);
    expect(plan.conversions).toEqual([]);
  });

  it('D-OW-10 keep-as-invited converts org-sourced rows to invited rows instead of removing them', () => {
    const plan = planDriveOrgMembership({
      drive: openDrive({ orgId: null }),
      orgMemberUserIds: [],
      existingRows: [row('user-priya', 'org'), row('user-chris', 'invite')],
      removedOrgRows: 'keepAsInvite',
    });

    expect(plan.deletes).toEqual([]);
    expect(plan.conversions).toEqual([{ rowId: 'row-drive-product-user-priya', driveId: 'drive-product', userId: 'user-priya' }]);
  });

  it('DRV-8 (partial) never touches a guest row (source invite, user not in the org) in any transition', () => {
    const guest = row('user-chris', 'invite');
    const transitions: Array<Parameters<typeof planDriveOrgMembership>[0]> = [
      { drive: openDrive(), orgMemberUserIds: ['user-priya'], existingRows: [guest] },
      { drive: openDrive({ orgVisibility: 'PRIVATE' }), orgMemberUserIds: ['user-priya'], existingRows: [guest] },
      { drive: openDrive({ orgId: null }), orgMemberUserIds: [], existingRows: [guest] },
      { drive: openDrive({ orgId: null }), orgMemberUserIds: [], existingRows: [guest], removedOrgRows: 'keepAsInvite' },
      { drive: openDrive(), orgMemberUserIds: [], existingRows: [guest], userScope: ['user-chris'] },
    ];

    for (const input of transitions) {
      const plan = planDriveOrgMembership(input);
      const touched = [...plan.inserts, ...plan.deletes, ...plan.conversions, ...plan.repairs].map((c) => c.userId);
      expect(touched).not.toContain('user-chris');
    }
  });

  it.each([
    ['a Private drive still in the org', { orgVisibility: 'PRIVATE' as const }, ['user-priya', 'user-lena']],
    ['a leave from an Open drive', {}, ['user-priya']],
  ])('D-OW-10 keep-as-invited applies only to a drive moved out of its org, never to %s', (_label, driveOverrides, members) => {
    const plan = planDriveOrgMembership({
      drive: openDrive(driveOverrides),
      orgMemberUserIds: members.filter((m) => m !== 'user-lena'),
      existingRows: [row('user-lena', 'org')],
      removedOrgRows: 'keepAsInvite',
    });

    expect(plan.conversions).toEqual([]);
    expect(plan.deletes.map((d) => d.userId)).toEqual(['user-lena']);
  });

  it('DRV-5 (partial) resets an org row to the drive default role when the default changed, leaving invited rows on their own role', () => {
    const plan = planDriveOrgMembership({
      drive: openDrive({ defaultCustomRoleId: 'role-new' }),
      orgMemberUserIds: ['user-priya', 'user-marcus', 'user-dana'],
      existingRows: [
        row('user-priya', 'org', 'drive-product', { customRoleId: 'role-old' }),
        row('user-marcus', 'org', 'drive-product', { customRoleId: 'role-new' }),
        row('user-dana', 'invite', 'drive-product', { customRoleId: 'role-editor' }),
      ],
    });

    expect(plan.repairs).toEqual([
      { rowId: 'row-drive-product-user-priya', driveId: 'drive-product', userId: 'user-priya', customRoleId: 'role-new' },
    ]);
    expect(plan.inserts).toEqual([]);
  });

  it('DRV-5 (partial) repairs an org row that is not accepted', () => {
    const plan = planDriveOrgMembership({
      drive: openDrive(),
      orgMemberUserIds: ['user-priya'],
      existingRows: [row('user-priya', 'org', 'drive-product', { accepted: false })],
    });

    expect(plan.repairs.map((r) => r.userId)).toEqual(['user-priya']);
  });

  it('DRV-8 (partial) never accepts or rewrites a pending invite row, even an org member\'s on an Open drive', () => {
    const plan = planDriveOrgMembership({
      drive: openDrive({ defaultCustomRoleId: 'role-default' }),
      orgMemberUserIds: ['user-priya'],
      existingRows: [
        row('user-priya', 'invite', 'drive-product', { accepted: false, customRoleId: 'role-editor' }),
        row('user-chris', 'invite', 'drive-product', { accepted: false }),
      ],
    });

    expect(plan).toEqual(emptyPlan());
  });

  it('DRV-8 (partial) leaves pending invite rows alone on a drive that does not materialize', () => {
    const plan = planDriveOrgMembership({
      drive: openDrive({ orgVisibility: 'PRIVATE' }),
      orgMemberUserIds: ['user-priya'],
      existingRows: [row('user-priya', 'invite', 'drive-product', { accepted: false })],
    });

    expect(plan).toEqual(emptyPlan());
  });

  it('D-OW-6 limits a per-user sync (join or leave) to the scoped users', () => {
    const plan = planDriveOrgMembership({
      drive: openDrive(),
      orgMemberUserIds: ['user-priya', 'user-marcus'],
      existingRows: [row('user-lena', 'org')],
      userScope: ['user-priya'],
    });

    expect(plan.inserts.map((i) => i.userId)).toEqual(['user-priya']);
    expect(plan.deletes).toEqual([]);
  });

  it('D-OW-6 ignores existing rows that belong to another drive', () => {
    const plan = planDriveOrgMembership({
      drive: openDrive(),
      orgMemberUserIds: ['user-priya'],
      existingRows: [row('user-priya', 'org', 'drive-finance'), row('user-lena', 'org', 'drive-finance')],
    });

    expect(plan.inserts.map((i) => i.userId)).toEqual(['user-priya']);
    expect(plan.deletes).toEqual([]);
  });

  it('D-OW-6 plans each org member once even when the member list repeats a user', () => {
    const plan = planDriveOrgMembership({
      drive: openDrive(),
      orgMemberUserIds: ['user-priya', 'user-priya'],
      existingRows: [],
    });

    expect(plan.inserts).toHaveLength(1);
  });
});

describe('planDriveOrgMembership admissions (approved join requests)', () => {
  const restricted = openDrive({ orgVisibility: 'RESTRICTED', defaultCustomRoleId: 'role-default' });

  it('DRV-6 (partial) admits an approved org member of a Restricted drive with the drive default role, as a direct row', () => {
    const plan = planDriveOrgMembership({
      drive: restricted, orgMemberUserIds: ['user-lena', 'user-marcus'], existingRows: [], admit: ['user-lena'],
    });
    expect(plan.admissions).toEqual([{ driveId: 'drive-product', userId: 'user-lena', customRoleId: 'role-default' }]);
    expect(plan.inserts).toEqual([]);
  });

  it('DRV-6 (partial) admits nobody the sync was not asked to admit: a Restricted drive materializes no rows', () => {
    const plan = planDriveOrgMembership({ drive: restricted, orgMemberUserIds: ['user-lena', 'user-marcus'], existingRows: [] });
    expect(plan.admissions).toEqual([]);
    expect(plan.inserts).toEqual([]);
  });

  it('DRV-6 (partial) never admits someone outside the org, the lead, or anyone holding a direct row (a pending invite is theirs to accept)', () => {
    const plan = planDriveOrgMembership({
      drive: restricted,
      orgMemberUserIds: ['user-jono', 'user-lena', 'user-tomas'],
      existingRows: [row('user-lena', 'invite', 'drive-product', { accepted: false })],
      admit: ['user-chris', 'user-jono', 'user-lena'],
    });
    expect(plan.admissions).toEqual([]);
  });

  it('DRV-6 (partial) replaces a stale org row with the admitted direct row', () => {
    const plan = planDriveOrgMembership({
      drive: restricted, orgMemberUserIds: ['user-lena'], existingRows: [row('user-lena', 'org')], admit: ['user-lena'],
    });
    expect(plan.deletes).toEqual([{ rowId: 'row-drive-product-user-lena', driveId: 'drive-product', userId: 'user-lena' }]);
    expect(plan.admissions).toEqual([{ driveId: 'drive-product', userId: 'user-lena', customRoleId: 'role-default' }]);
  });

  it('DRV-5 (partial) admits nothing on an Open drive or a drive outside any org: materialization already covers the member', () => {
    for (const drive of [openDrive(), openDrive({ orgId: null, orgVisibility: 'RESTRICTED' })]) {
      expect(planDriveOrgMembership({ drive, orgMemberUserIds: ['user-lena'], existingRows: [], admit: ['user-lena'] }).admissions).toEqual([]);
    }
  });

  it('X-4 (partial) an admission is a member_added event', () => {
    expect(summarizeAffectedUsers([{ ...emptyPlan(), admissions: [{ driveId: 'drive-product', userId: 'user-lena', customRoleId: null }] }]))
      .toEqual([{ userId: 'user-lena', operation: 'member_added', driveIds: ['drive-product'] }]);
  });
});

describe('summarizeAffectedUsers', () => {
  it('X-4 (partial) yields exactly one event per affected user across every drive in the sync', () => {
    const plans: DriveOrgMembershipPlan[] = [
      {
        driveId: 'drive-product',
        inserts: [{ driveId: 'drive-product', userId: 'user-priya', customRoleId: null }],
        deletes: [{ rowId: 'r1', driveId: 'drive-product', userId: 'user-lena' }],
        conversions: [],
        repairs: [],
        admissions: [],
      },
      {
        driveId: 'drive-design',
        inserts: [{ driveId: 'drive-design', userId: 'user-priya', customRoleId: null }],
        deletes: [],
        conversions: [{ rowId: 'r2', driveId: 'drive-design', userId: 'user-tomas' }],
        repairs: [],
        admissions: [],
      },
      emptyPlan('drive-engineering'),
    ];

    expect(summarizeAffectedUsers(plans)).toEqual([
      { userId: 'user-priya', operation: 'member_added', driveIds: ['drive-product', 'drive-design'] },
      { userId: 'user-lena', operation: 'member_removed', driveIds: ['drive-product'] },
      { userId: 'user-tomas', operation: 'member_role_changed', driveIds: ['drive-design'] },
    ]);
  });

  it('X-4 (partial) reports a user both added and removed in one sync as removed, so the client refetches its drive list either way', () => {
    const plans: DriveOrgMembershipPlan[] = [
      {
        driveId: 'drive-a',
        inserts: [{ driveId: 'drive-a', userId: 'user-priya', customRoleId: null }],
        deletes: [],
        conversions: [],
        repairs: [],
        admissions: [],
      },
      {
        driveId: 'drive-b',
        inserts: [],
        deletes: [{ rowId: 'r1', driveId: 'drive-b', userId: 'user-priya' }],
        conversions: [],
        repairs: [],
        admissions: [],
      },
    ];

    expect(summarizeAffectedUsers(plans)).toEqual([
      { userId: 'user-priya', operation: 'member_removed', driveIds: ['drive-a', 'drive-b'] },
    ]);
  });

  it('X-4 (partial) reports a role repair as role changed', () => {
    const plans: DriveOrgMembershipPlan[] = [
      { ...emptyPlan('drive-a'), repairs: [{ rowId: 'r2', driveId: 'drive-a', userId: 'user-marcus', customRoleId: 'role-new' }] },
    ];

    expect(summarizeAffectedUsers(plans)).toEqual([
      { userId: 'user-marcus', operation: 'member_role_changed', driveIds: ['drive-a'] },
    ]);
  });

  it('X-4 (partial) yields no event when nothing changed', () => {
    expect(summarizeAffectedUsers([emptyPlan()])).toEqual([]);
  });
});

describe('chunk', () => {
  it('D-OW-6 splits bulk writes under the Postgres bind-parameter limit', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 500)).toEqual([]);
  });

  it('D-OW-6 refuses a non-positive chunk size instead of looping forever', () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe('settleInBatches', () => {
  it('X-4 (partial) never runs more than the batch size of event sends at once, and settles every one', async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 45 }, (_, i) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      if (i === 7) throw new Error('boom');
      return i;
    });

    const settled = await settleInBatches(tasks, 10);

    expect(peak).toBe(10);
    expect(settled).toHaveLength(45);
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1);
  });
});
