/**
 * Rollback and redo of a drive `ownership_transfer` against a REAL Postgres.
 *
 * The transfer route hands a drive over through `transferDriveOwnership`, and
 * rolling the transfer back, or redoing it, changes the owner again through
 * the same helper (IMG-4.5 review, finding 1). Since IMG-10.10 that helper has
 * nothing to do for Imago — Imago reaches a drive through its user, and the
 * per-drive setting is each user's own — so a transfer, its rollback and its
 * redo must leave both users' Imago choices exactly as they were. These tests
 * replay the activity the transfer route logs through the real executors and
 * read owners and choices back from the database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { imagoDriveAccess } from '@pagespace/db/schema/imago-drive-access';
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

/** A drive A owns and keeps Imago out of, handed to admin B by the transfer route's helper. */
async function transferred() {
  const from = await userWithAgents();
  const to = await userWithAgents();
  const drive = await factories.createDrive(from.id, { name: 'Handed over' });
  await factories.createDriveMember(drive.id, to.id, { role: 'ADMIN', acceptedAt: new Date() });
  await provisionImagoAgents(from.id);
  await provisionImagoAgents(to.id);
  expect((await setImagoDriveAccess(from.id, drive.id, false)).ok).toBe(true);
  await transferDriveOwnership(drive.id, from.id, to.id);
  return { from, to, drive };
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

async function choiceOf(userId: string, driveId: string) {
  const [row] = await db
    .select({ enabled: imagoDriveAccess.enabled })
    .from(imagoDriveAccess)
    .where(and(eq(imagoDriveAccess.userId, userId), eq(imagoDriveAccess.driveId, driveId)));
  return row?.enabled ?? null;
}

describe('ownership_transfer rollback and redo (real Postgres)', () => {
  it("given a transfer, should keep each user's own Imago choice for the drive", async () => {
    const { from, to, drive } = await transferred();

    expect(await ownerOf(drive.id)).toBe(to.id);
    expect(await choiceOf(from.id, drive.id)).toBe(false);
    expect(await choiceOf(to.id, drive.id)).toBeNull();
  });

  it("given a rolled-back transfer, should restore the owner and leave both users' Imago choices alone", async () => {
    const { from, to, drive } = await transferred();
    expect((await setImagoDriveAccess(to.id, drive.id, false)).ok).toBe(true);

    await rollbackDriveChange(defaultRollbackDeps(), transferActivity(drive.id, from.id, to.id), context(from.id));

    expect(await ownerOf(drive.id)).toBe(from.id);
    expect(await choiceOf(from.id, drive.id)).toBe(false);
    expect(await choiceOf(to.id, drive.id)).toBe(false);
  });

  it('given a redo, should hand the drive over again and leave the choices alone', async () => {
    const { from, to, drive } = await transferred();
    const activity = transferActivity(drive.id, from.id, to.id);
    await rollbackDriveChange(defaultRollbackDeps(), activity, context(from.id));
    expect((await setImagoDriveAccess(from.id, drive.id, true)).ok).toBe(true);

    await redoDriveChange(defaultRollbackDeps(), activity, { ownerId: to.id }, 'ownership_transfer', context(from.id));

    expect(await ownerOf(drive.id)).toBe(to.id);
    expect(await choiceOf(from.id, drive.id)).toBe(true);
  });

  it("given the rollback threaded through the caller's transaction, should commit and abort with it", async () => {
    const { from, to, drive } = await transferred();
    const activity = transferActivity(drive.id, from.id, to.id);

    await expect(db.transaction(async (tx) => {
      await rollbackDriveChange({ ...defaultRollbackDeps(), db: tx as unknown as typeof db }, activity, context(from.id));
      throw new Error('caller aborts');
    })).rejects.toThrow('caller aborts');
    expect(await ownerOf(drive.id)).toBe(to.id);

    await db.transaction((tx) =>
      rollbackDriveChange({ ...defaultRollbackDeps(), db: tx as unknown as typeof db }, activity, context(from.id)));
    expect(await ownerOf(drive.id)).toBe(from.id);
  });

  it('given a drive whose owner already matches, should leave the owner alone', async () => {
    const { from, to, drive } = await transferred();

    await redoDriveChange(defaultRollbackDeps(), transferActivity(drive.id, from.id, to.id), { ownerId: to.id }, 'ownership_transfer', context(to.id));

    expect(await ownerOf(drive.id)).toBe(to.id);
  });
});
