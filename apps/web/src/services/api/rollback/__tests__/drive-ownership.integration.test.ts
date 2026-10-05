/**
 * Rollback and redo of a drive `ownership_transfer` against a REAL Postgres.
 *
 * The transfer route hands a drive over through `transferDriveOwnership`, which
 * revokes the outgoing owner's Imago agent grants in the same transaction
 * (DEC-2). Rolling the transfer back, or redoing it, changes the owner again,
 * so it must go through the same helper: otherwise a redo leaves the previous
 * owner's Imago agents inside a drive they no longer own (IMG-4.5 review,
 * finding 1). These tests replay the activity the transfer route logs through
 * the real executors and read owners and memberships back from the database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { factories } from '@pagespace/db/test/factories';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import { setImagoDriveAccess } from '@pagespace/lib/agents/imago-drive-access';
import { transferDriveOwnership } from '@pagespace/lib/services/drive-service';
import { ensureTestDb } from '@/test/ensure-test-db';
import { defaultRollbackDeps, type PageUpdateContext } from '../deps';
import { rollbackDriveChange } from '../rollback-executors';
import { redoDriveChange } from '../redo-executors';
import type { ActivityLogForRollback } from '../types';

const seededUserIds: string[] = [];

beforeAll(async () => {
  await ensureTestDb();
});

afterAll(async () => {
  if (seededUserIds.length === 0) return;
  await db.delete(users).where(inArray(users.id, seededUserIds));
});

async function userWithAgents() {
  const user = await factories.createUser();
  seededUserIds.push(user.id);
  await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: 'home' });
  return user;
}

/** A drive A owns with A's Imago agents in it, handed to admin B by the transfer route's helper. */
async function transferred() {
  const from = await userWithAgents();
  const to = await userWithAgents();
  const drive = await factories.createDrive(from.id, { name: 'Handed over' });
  await factories.createDriveMember(drive.id, to.id, { role: 'ADMIN' });
  const fromAgents = Object.values((await provisionImagoAgents(from.id)).agents);
  const toAgents = Object.values((await provisionImagoAgents(to.id)).agents);
  await transferDriveOwnership(drive.id, from.id, to.id);
  return { from, to, drive, fromAgents, toAgents };
}

/** The activity the transfer route logs (`logDriveActivity(..., 'ownership_transfer', ...)`). */
function transferActivity(driveId: string, fromUserId: string, toUserId: string): ActivityLogForRollback {
  return {
    id: 'activity_transfer',
    timestamp: new Date(),
    userId: fromUserId,
    actorEmail: 'from@example.com',
    actorDisplayName: null,
    operation: 'ownership_transfer',
    resourceType: 'drive',
    resourceId: driveId,
    resourceTitle: 'Handed over',
    driveId,
    pageId: null,
    isAiGenerated: false,
    aiProvider: null,
    aiModel: null,
    contentSnapshot: null,
    contentRef: null,
    contentFormat: null,
    contentSize: null,
    updatedFields: null,
    previousValues: { ownerId: fromUserId },
    newValues: { ownerId: toUserId },
    metadata: null,
    streamId: null,
    streamSeq: null,
    changeGroupId: null,
    changeGroupType: null,
    stateHashBefore: null,
    stateHashAfter: null,
    rollbackFromActivityId: null,
    rollbackSourceOperation: null,
    rollbackSourceTimestamp: null,
    rollbackSourceTitle: null,
  };
}

function context(userId: string): PageUpdateContext {
  return { userId, changeGroupId: 'cg_test', changeGroupType: 'user', source: 'restore' };
}

async function ownerOf(driveId: string) {
  const [row] = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, driveId));
  return row.ownerId;
}

async function membersIn(driveId: string, agentIds: string[]) {
  const rows = await db
    .select({ agentPageId: driveAgentMembers.agentPageId })
    .from(driveAgentMembers)
    .where(and(eq(driveAgentMembers.driveId, driveId), inArray(driveAgentMembers.agentPageId, agentIds)));
  return rows.map((row) => row.agentPageId).sort();
}

const sorted = (ids: readonly string[]) => [...ids].sort();

describe('ownership_transfer rollback and redo (real Postgres)', () => {
  it("given a rolled-back transfer, should restore the owner and revoke the outgoing owner's Imago grants", async () => {
    const { from, to, drive, toAgents } = await transferred();
    // B, the owner for now, lets their Imago in.
    expect((await setImagoDriveAccess(to.id, drive.id, true)).ok).toBe(true);
    expect(await membersIn(drive.id, toAgents)).toEqual(sorted(toAgents));

    await rollbackDriveChange(defaultRollbackDeps(), transferActivity(drive.id, from.id, to.id), context(from.id));

    expect(await ownerOf(drive.id)).toBe(from.id);
    expect(await membersIn(drive.id, toAgents)).toEqual([]);
  });

  it("given a redo after the previous owner re-granted Imago, should hand the drive over again without the previous owner's Imago agents", async () => {
    const { from, to, drive, fromAgents } = await transferred();
    const activity = transferActivity(drive.id, from.id, to.id);
    await rollbackDriveChange(defaultRollbackDeps(), activity, context(from.id));
    // A owns the drive again and switches their Imago back on.
    expect((await setImagoDriveAccess(from.id, drive.id, true)).ok).toBe(true);
    expect(await membersIn(drive.id, fromAgents)).toEqual(sorted(fromAgents));

    await redoDriveChange(defaultRollbackDeps(), activity, { ownerId: to.id }, 'ownership_transfer', context(from.id));

    expect(await ownerOf(drive.id)).toBe(to.id);
    expect(await membersIn(drive.id, fromAgents)).toEqual([]);
  });

  it("given the rollback threaded through the caller's transaction, should commit and abort with it", async () => {
    const { from, to, drive, toAgents } = await transferred();
    expect((await setImagoDriveAccess(to.id, drive.id, true)).ok).toBe(true);
    const activity = transferActivity(drive.id, from.id, to.id);

    await expect(db.transaction(async (tx) => {
      await rollbackDriveChange({ ...defaultRollbackDeps(), db: tx as unknown as typeof db }, activity, context(from.id));
      throw new Error('caller aborts');
    })).rejects.toThrow('caller aborts');
    expect(await ownerOf(drive.id)).toBe(to.id);
    expect(await membersIn(drive.id, toAgents)).toEqual(sorted(toAgents));

    await db.transaction((tx) =>
      rollbackDriveChange({ ...defaultRollbackDeps(), db: tx as unknown as typeof db }, activity, context(from.id)));
    expect(await ownerOf(drive.id)).toBe(from.id);
    expect(await membersIn(drive.id, toAgents)).toEqual([]);
  });

  it('given a drive whose owner already matches, should leave owner and grants alone', async () => {
    const { from, to, drive, toAgents } = await transferred();
    expect((await setImagoDriveAccess(to.id, drive.id, true)).ok).toBe(true);

    await redoDriveChange(defaultRollbackDeps(), transferActivity(drive.id, from.id, to.id), { ownerId: to.id }, 'ownership_transfer', context(to.id));

    expect(await ownerOf(drive.id)).toBe(to.id);
    expect(await membersIn(drive.id, toAgents)).toEqual(sorted(toAgents));
  });
});
