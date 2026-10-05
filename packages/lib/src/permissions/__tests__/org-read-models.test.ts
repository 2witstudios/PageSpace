import { describe, it, expect } from 'vitest';
import { summarizeDriveUsage, summarizeMemberActivity, summarizeOrgGuests } from '../org-read-models';

const members = new Set(['u_owner', 'u_admin', 'u_marcus']);

describe('summarizeOrgGuests', () => {
  it('UI-7 (partial) DRV-8 (partial): a guest is a person in an org drive who is not an org member, listed once with each drive', () => {
    const guests = summarizeOrgGuests(
      [
        { userId: 'u_chris', name: 'Chris Rowe', email: 'chris@partner.co', image: null, driveId: 'd_mkt', driveName: 'Marketing Site', acceptedAt: new Date('2026-09-01'), source: 'invite' as const },
        { userId: 'u_aisha', name: 'Aisha Bello', email: 'aisha@studio.example', image: null, driveId: 'd_ds', driveName: 'Design System', acceptedAt: new Date('2026-09-01'), source: 'invite' as const },
        { userId: 'u_aisha', name: 'Aisha Bello', email: 'aisha@studio.example', image: null, driveId: 'd_prod', driveName: 'Product', acceptedAt: null, source: 'invite' as const },
        { userId: 'u_marcus', name: 'Marcus', email: 'marcus@northwind.com', image: null, driveId: 'd_mkt', driveName: 'Marketing Site', acceptedAt: new Date('2026-09-01'), source: 'invite' as const },
      ],
      members,
    );
    expect(guests).toEqual([
      { userId: 'u_aisha', name: 'Aisha Bello', email: 'aisha@studio.example', image: null, drives: [{ id: 'd_ds', name: 'Design System', pending: false }, { id: 'd_prod', name: 'Product', pending: true }] },
      { userId: 'u_chris', name: 'Chris Rowe', email: 'chris@partner.co', image: null, drives: [{ id: 'd_mkt', name: 'Marketing Site', pending: false }] },
    ]);
  });

  it("never lists a departed member's stale org row as a guest (it grants nothing)", () => {
    expect(summarizeOrgGuests([{ userId: 'u_left', name: 'Lou', email: 'lou@x', image: null, driveId: 'd', driveName: 'D', acceptedAt: new Date(), source: 'org' }], members)).toEqual([]);
  });

  it('sorts a guest with no name by address, and one with neither by id', () => {
    const row = (userId: string, name: string | null, email: string | null) => ({ userId, name, email, image: null, driveId: 'd', driveName: 'D', acceptedAt: new Date(), source: 'invite' as const });
    const order = summarizeOrgGuests([row('u_zed', 'Zed', 'zed@x'), row('u_b', null, 'bea@x'), row('a_anon', null, null)], members).map((g) => g.userId);
    expect(order).toEqual(['a_anon', 'u_b', 'u_zed']);
  });

  it('is empty when every person in the drives is an org member', () => {
    expect(summarizeOrgGuests([{ userId: 'u_admin', name: 'A', email: 'a@x', image: null, driveId: 'd', driveName: 'D', acceptedAt: new Date(), source: 'org' as const }], members)).toEqual([]);
  });
});

describe('summarizeDriveUsage', () => {
  it('UI-7 (partial): counts accepted people per drive, how many are guests, and the bytes its files hold', () => {
    const usage = summarizeDriveUsage({
      driveIds: ['d_prod', 'd_fin'],
      memberRows: [
        { driveId: 'd_prod', userId: 'u_owner', acceptedAt: new Date(), source: 'org' as const },
        { driveId: 'd_prod', userId: 'u_marcus', acceptedAt: new Date(), source: 'org' as const },
        { driveId: 'd_prod', userId: 'u_marcus', acceptedAt: new Date(), source: 'org' as const },
        { driveId: 'd_prod', userId: 'u_chris', acceptedAt: new Date(), source: 'invite' as const },
        { driveId: 'd_prod', userId: 'u_pending', acceptedAt: null, source: 'invite' as const },
        { driveId: 'd_prod', userId: 'u_left', acceptedAt: new Date(), source: 'org' as const },
      ],
      orgMemberIds: members,
      fileBytes: [{ driveId: 'd_prod', bytes: 9_200_000_000 }],
    });
    expect(usage).toEqual([
      { driveId: 'd_prod', memberCount: 3, guestCount: 1, storageBytes: 9_200_000_000 },
      { driveId: 'd_fin', memberCount: 0, guestCount: 0, storageBytes: 0 },
    ]);
  });
});

describe('summarizeMemberActivity', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  it('UI-7 (partial) ORG-4 (partial): an Owner or Admin reaches every org drive; a Member the drives they hold a row in', () => {
    const activity = summarizeMemberActivity({
      members: [{ userId: 'u_owner', role: 'OWNER' }, { userId: 'u_admin', role: 'ADMIN' }, { userId: 'u_marcus', role: 'MEMBER' }, { userId: 'u_new', role: 'MEMBER' }],
      orgDriveCount: 6,
      memberRows: [
        { driveId: 'd1', userId: 'u_marcus', acceptedAt: now, source: 'org' as const },
        { driveId: 'd2', userId: 'u_marcus', acceptedAt: now, source: 'org' as const },
        { driveId: 'd2', userId: 'u_marcus', acceptedAt: now, source: 'org' as const },
        { driveId: 'd3', userId: 'u_marcus', acceptedAt: null, source: 'org' as const },
      ],
      lastUsed: [{ userId: 'u_marcus', at: now }, { userId: 'u_owner', at: null }],
    });
    expect(activity).toEqual([
      { userId: 'u_owner', driveCount: 6, lastActiveAt: null },
      { userId: 'u_admin', driveCount: 6, lastActiveAt: null },
      { userId: 'u_marcus', driveCount: 2, lastActiveAt: now.toISOString() },
      { userId: 'u_new', driveCount: 0, lastActiveAt: null },
    ]);
  });
});
