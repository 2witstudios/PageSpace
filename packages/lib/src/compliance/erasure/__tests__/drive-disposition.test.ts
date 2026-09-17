import { describe, it, expect } from 'vitest';
import { planDriveDisposition, type OwnedDriveWithMembers } from '../drive-disposition';

const drives: OwnedDriveWithMembers[] = [
  { id: 'solo1', name: 'Solo One', memberCount: 1, orgId: null },
  { id: 'solo0', name: 'Empty', memberCount: 0, orgId: null },
  { id: 'team1', name: 'Team Alpha', memberCount: 3, orgId: null },
  { id: 'team2', name: 'Team Beta', memberCount: 2, orgId: null },
];

describe('planDriveDisposition (no force)', () => {
  it('given multi-member drives without force, should block and name them', () => {
    const plan = planDriveDisposition(drives, { forceDelete: false });
    expect(plan.blocked).toBe(true);
    expect(plan.multiMemberDriveNames).toEqual(['Team Alpha', 'Team Beta']);
    // Nothing is deleted while blocked — erasure cannot proceed.
    expect(plan.drivesToDelete).toEqual([]);
    expect(plan.forcedDriveIds).toEqual([]);
  });

  it('given only solo drives, should delete them and not block', () => {
    const soloOnly = drives.filter((d) => d.memberCount <= 1);
    const plan = planDriveDisposition(soloOnly, { forceDelete: false });
    expect(plan.blocked).toBe(false);
    expect(plan.drivesToDelete.sort()).toEqual(['solo0', 'solo1']);
    expect(plan.multiMemberDriveNames).toEqual([]);
  });

  it('given no owned drives, should be a no-op and not block', () => {
    const plan = planDriveDisposition([], { forceDelete: false });
    expect(plan.blocked).toBe(false);
    expect(plan.drivesToDelete).toEqual([]);
  });
});

describe('planDriveDisposition (force escalation)', () => {
  it('given force-delete, should delete every owned drive including multi-member ones and not block', () => {
    const plan = planDriveDisposition(drives, { forceDelete: true });
    expect(plan.blocked).toBe(false);
    expect(plan.drivesToDelete.sort()).toEqual(['solo0', 'solo1', 'team1', 'team2'].sort());
    // The forced set tracks which were only deleted because of escalation (for evidence).
    expect(plan.forcedDriveIds.sort()).toEqual(['team1', 'team2']);
    expect(plan.multiMemberDriveNames).toEqual(['Team Alpha', 'Team Beta']);
  });

  it('boundary: a drive with exactly 1 member is solo, 2 members is multi', () => {
    const plan = planDriveDisposition(
      [
        { id: 'a', name: 'A', memberCount: 1, orgId: null },
        { id: 'b', name: 'B', memberCount: 2, orgId: null },
      ],
      { forceDelete: false }
    );
    expect(plan.soloDriveIds).toEqual(['a']);
    expect(plan.multiMemberDriveIds).toEqual(['b']);
  });
});

describe('planDriveDisposition (org drives the person leads)', () => {
  // Northwind Labs: Marcus leads Product (an org drive with many members) and owns a solo
  // personal drive. His org drives belong to the org; erasure reassigns their lead to the
  // org Owner (leave-and-delete cascades) instead of deleting or blocking on them.
  const marcusDrives: OwnedDriveWithMembers[] = [
    { id: 'product', name: 'Product', memberCount: 9, orgId: 'org-northwind' },
    { id: 'notes', name: 'Notes', memberCount: 1, orgId: null },
  ];

  it('O-7 (partial) an org drive the person leads is neither deleted nor blocking, and is listed for lead reassignment', () => {
    const plan = planDriveDisposition(marcusDrives, { forceDelete: false });
    expect(plan.blocked).toBe(false);
    expect(plan.drivesToDelete).toEqual(['notes']);
    expect(plan.multiMemberDriveNames).toEqual([]);
    expect(plan.orgDriveIds).toEqual(['product']);
  });

  it('O-7 (partial) force escalation never deletes an org drive', () => {
    const plan = planDriveDisposition(marcusDrives, { forceDelete: true });
    expect(plan.drivesToDelete).toEqual(['notes']);
    expect(plan.forcedDriveIds).toEqual([]);
    expect(plan.orgDriveIds).toEqual(['product']);
  });
});
