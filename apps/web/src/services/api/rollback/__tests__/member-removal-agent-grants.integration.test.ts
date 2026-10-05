/**
 * Member removal by rollback, redo and backup restore against a REAL Postgres
 * (IMG-4.9 review, minor).
 *
 * The member-removal route revokes the agent grants the removed user made in
 * the drive (`revokeAgentMembershipsGrantedBy`). Three other paths delete a
 * `drive_members` row: rolling back a `member_add`, redoing a `member_remove`
 * and restoring a drive backup. Each must revoke the same grants, or the
 * removed user's Imago agents stay listed in — and consultable from — a drive
 * the user left, and come back silently if the user is ever re-added.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { driveAgentMembers, driveMembers } from '@pagespace/db/schema/members';
import { factories } from '@pagespace/db/test/factories';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import { setImagoDriveAccess } from '@pagespace/lib/agents/imago-drive-access';
import { ensureTestDb } from '@/test/ensure-test-db';
import { defaultRollbackDeps } from '../deps';
import { rollbackMemberChange } from '../rollback-executors';
import { redoMemberChange } from '../redo-executors';
import { planMemberRestoreOps, revokeAgentGrantsOfRemovedMembers } from '../../restore-permissions-service';
import type { ActivityLogForRollback } from '../types';

const seededUserIds: string[] = [];

beforeAll(async () => {
  await ensureTestDb();
});

afterAll(async () => {
  if (seededUserIds.length === 0) return;
  await db.delete(users).where(inArray(users.id, seededUserIds));
});

/** A drive owned by someone else where `admin` is an ADMIN and switched their Imago agents on. */
async function adminWithImagoIn() {
  const owner = await factories.createUser();
  const admin = await factories.createUser();
  seededUserIds.push(owner.id, admin.id);
  await factories.createDrive(admin.id, { kind: 'HOME', name: 'Home', slug: 'home' });
  const drive = await factories.createDrive(owner.id, { name: 'Shared' });
  await factories.createDriveMember(drive.id, admin.id, { role: 'ADMIN', acceptedAt: new Date() });
  const agents = Object.values((await provisionImagoAgents(admin.id)).agents);
  expect((await setImagoDriveAccess(admin.id, drive.id, true)).ok).toBe(true);
  expect(await agentsIn(drive.id, agents)).toHaveLength(agents.length);
  return { owner, admin, drive, agents };
}

async function agentsIn(driveId: string, agentIds: string[]) {
  const rows = await db
    .select({ agentPageId: driveAgentMembers.agentPageId })
    .from(driveAgentMembers)
    .where(and(eq(driveAgentMembers.driveId, driveId), inArray(driveAgentMembers.agentPageId, agentIds)));
  return rows.map((row) => row.agentPageId);
}

function memberActivity(driveId: string, targetUserId: string, operation: 'member_add' | 'member_remove'): ActivityLogForRollback {
  return {
    id: 'activity_member',
    timestamp: new Date(),
    userId: targetUserId,
    actorEmail: 'owner@example.com',
    actorDisplayName: null,
    operation,
    resourceType: 'member',
    resourceId: targetUserId,
    resourceTitle: null,
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
    previousValues: null,
    newValues: { userId: targetUserId, role: 'ADMIN' },
    metadata: { targetUserId },
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

describe('member removal outside the member route revokes the agent grants the member made', () => {
  it('given a rollback of the member_add, should remove the member and their Imago agents', async () => {
    const { admin, drive, agents } = await adminWithImagoIn();

    await rollbackMemberChange(defaultRollbackDeps(), memberActivity(drive.id, admin.id, 'member_add'));

    expect(await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, drive.id), eq(driveMembers.userId, admin.id)))).toEqual([]);
    expect(await agentsIn(drive.id, agents)).toEqual([]);
  });

  it('given a redo of a member_remove, should remove the member and their Imago agents', async () => {
    const { admin, drive, agents } = await adminWithImagoIn();

    await redoMemberChange(defaultRollbackDeps(), memberActivity(drive.id, admin.id, 'member_remove'), null, 'member_remove');

    expect(await agentsIn(drive.id, agents)).toEqual([]);
  });

  it('given a backup restore that drops the member, should revoke their Imago agents', async () => {
    const { admin, drive, agents } = await adminWithImagoIn();
    const memberOps = planMemberRestoreOps([], [{ userId: admin.id }] as never[]);

    await db.transaction((tx) => revokeAgentGrantsOfRemovedMembers(tx, drive.id, memberOps, []));

    expect(await agentsIn(drive.id, agents)).toEqual([]);
  });

  it('given a backup restore that brings the member back, should keep their Imago agents', async () => {
    const { admin, drive, agents } = await adminWithImagoIn();
    const memberOps = planMemberRestoreOps([{ userId: admin.id, role: 'ADMIN' }] as never[], [{ userId: admin.id }] as never[]);

    await db.transaction((tx) => revokeAgentGrantsOfRemovedMembers(tx, drive.id, memberOps, []));

    expect(await agentsIn(drive.id, agents)).toHaveLength(agents.length);
  });
});
