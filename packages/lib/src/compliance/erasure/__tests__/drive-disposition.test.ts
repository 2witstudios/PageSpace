import { describe, it, expect } from 'vitest';
import { planDriveDisposition, type OwnedDriveWithMembers } from '../drive-disposition';

const drives: OwnedDriveWithMembers[] = [
  { id: 'solo1', name: 'Solo One', memberCount: 1 },
  { id: 'solo0', name: 'Empty', memberCount: 0 },
  { id: 'team1', name: 'Team Alpha', memberCount: 3 },
  { id: 'team2', name: 'Team Beta', memberCount: 2 },
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
        { id: 'a', name: 'A', memberCount: 1 },
        { id: 'b', name: 'B', memberCount: 2 },
      ],
      { forceDelete: false }
    );
    expect(plan.soloDriveIds).toEqual(['a']);
    expect(plan.multiMemberDriveIds).toEqual(['b']);
  });
});
