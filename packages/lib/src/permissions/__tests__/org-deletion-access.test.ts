import { describe, it, expect } from 'vitest';
import type { db } from '@pagespace/db/db';
import { resolveOrgDeletionAccessLoss } from '../org-deletion-access';

type Pair = { userId: string; driveId: string };
/** A drive_members row as the read selects it: role is a NOT NULL column. */
type AcceptedRow = Pair & { role: string };

/** An executor whose drive_members read answers `accepted` (the rows still accepted after the deletes). */
const executorWith = (accepted: AcceptedRow[]) => {
  const reads: number[] = [];
  const executor = {
    select: () => ({ from: () => ({ where: async () => (reads.push(1), accepted) }) }),
  } as unknown as Pick<typeof db, 'select'>;
  return { executor, reads };
};

const members = [
  { userId: 'owner', role: 'OWNER' as const },
  { userId: 'admin', role: 'ADMIN' as const },
  { userId: 'member', role: 'MEMBER' as const },
];
const open = { driveId: 'd_open', newOwnerId: 'member', open: true };
const restricted = { driveId: 'd_restricted', newOwnerId: 'owner', open: false };

const sorted = (pairs: Pair[]) => pairs.map((pair) => `${pair.driveId}:${pair.userId}`).sort();

describe('resolveOrgDeletionAccessLoss', () => {
  it('ORG-6 (partial) takes every org Owner and Admin off every drive, and every member off an Open one, except its new owner', async () => {
    const { executor } = executorWith([]);
    expect(sorted(await resolveOrgDeletionAccessLoss(executor, { outcomes: [open, restricted], members, removedRows: [] }))).toEqual([
      'd_open:admin',
      'd_open:owner',
      'd_restricted:admin',
    ]);
  });

  it('ORG-6 (partial) takes off everyone whose row the deletion removed, but never the new owner, once per (person, drive)', async () => {
    const { executor } = executorWith([]);
    const removedRows = [
      { userId: 'former_lead', driveId: 'd_restricted' },
      { userId: 'member', driveId: 'd_restricted' },
      { userId: 'admin', driveId: 'd_restricted' },
      { userId: 'owner', driveId: 'd_restricted' },
    ];
    expect(sorted(await resolveOrgDeletionAccessLoss(executor, { outcomes: [restricted], members, removedRows }))).toEqual([
      'd_restricted:admin',
      'd_restricted:former_lead',
      'd_restricted:member',
    ]);
  });

  it('ORG-6 (partial) keeps anyone still holding an accepted row on the drive', async () => {
    const { executor } = executorWith([{ userId: 'admin', driveId: 'd_open', role: 'MEMBER' }]);
    expect(sorted(await resolveOrgDeletionAccessLoss(executor, { outcomes: [open], members, removedRows: [] }))).toEqual(['d_open:owner']);
  });

  it('D-OW-24 ORG-6 (partial) a GUEST row (a redeemed page share link) keeps no one on the drive: its holder is still taken off', async () => {
    const { executor } = executorWith([{ userId: 'admin', driveId: 'd_open', role: 'GUEST' }]);
    expect(sorted(await resolveOrgDeletionAccessLoss(executor, { outcomes: [open], members, removedRows: [] }))).toEqual(['d_open:admin', 'd_open:owner']);
  });

  it('ORG-6 (partial) reads nothing and takes no one off when the org had no drives', async () => {
    const { executor, reads } = executorWith([{ userId: 'admin', driveId: 'd_open', role: 'MEMBER' }]);
    expect(await resolveOrgDeletionAccessLoss(executor, { outcomes: [], members, removedRows: [] })).toEqual([]);
    expect(reads).toEqual([]);
  });
});
