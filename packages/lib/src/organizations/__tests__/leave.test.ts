import { describe, it, expect } from 'vitest';
import { decideLeave, planLeadReassignments } from '../leave';

describe('decideLeave', () => {
  it('O-8 (partial) a Member or Admin may leave', () => {
    expect(decideLeave({ role: 'MEMBER' })).toEqual({ ok: true });
    expect(decideLeave({ role: 'ADMIN' })).toEqual({ ok: true });
  });

  it('O-8 (partial) a non-member cannot leave', () => {
    expect(decideLeave(null)).toEqual({ ok: false, reason: 'NOT_A_MEMBER' });
  });

  it('ORG-6 (partial) the Owner cannot leave without transferring ownership first', () => {
    expect(decideLeave({ role: 'OWNER' })).toEqual({ ok: false, reason: 'OWNER_MUST_TRANSFER' });
  });
});

describe('planLeadReassignments', () => {
  it('O-7 (partial) every org drive the departing lead leads goes to that org\'s Owner', () => {
    const plan = planLeadReassignments('lead', [
      { driveId: 'd1', orgId: 'o1', orgOwnerId: 'owner1' },
      { driveId: 'd2', orgId: 'o2', orgOwnerId: 'owner2' },
    ]);
    expect(plan).toEqual([
      { driveId: 'd1', orgId: 'o1', fromUserId: 'lead', toUserId: 'owner1' },
      { driveId: 'd2', orgId: 'o2', fromUserId: 'lead', toUserId: 'owner2' },
    ]);
  });

  it('O-7 (partial) a drive the org Owner already leads is not reassigned to itself', () => {
    expect(planLeadReassignments('owner1', [
      { driveId: 'd1', orgId: 'o1', orgOwnerId: 'owner1' },
    ])).toEqual([]);
  });

  it('O-7 (partial) no led org drives means no reassignments', () => {
    expect(planLeadReassignments('lead', [])).toEqual([]);
  });
});
