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
import { sessionService } from '@pagespace/lib/auth/session-service';
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';
import { updateDriveLastAccessed } from '@pagespace/lib/services/drive-service';
import { COOKIE_CONFIG } from '@/lib/auth/cookie-config';
import { ensureTestDb } from '@/test/ensure-test-db';
import { createDriveBackup } from '@/services/api/drive-backup-service';
import { POST as restoreBackup } from '@/app/api/drives/[driveId]/backups/[backupId]/restore/route';
import { defaultRollbackDeps } from '../deps';
import { rollbackMemberChange } from '../rollback-executors';
import { redoMemberChange } from '../redo-executors';
import { planMemberRestoreOps, revokeAgentGrantsOfRemovedMembers } from '../../restore-permissions-service';
import type { ActivityLogForRollback } from '../types';

const APP_ORIGIN = 'http://localhost:3000';
const seededUserIds: string[] = [];
let previousWebAppUrl: string | undefined;

beforeAll(async () => {
  await ensureTestDb();
  previousWebAppUrl = process.env.WEB_APP_URL;
  process.env.WEB_APP_URL = APP_ORIGIN;
});

afterAll(async () => {
  if (previousWebAppUrl === undefined) delete process.env.WEB_APP_URL;
  else process.env.WEB_APP_URL = previousWebAppUrl;
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

describe('backup restore through the route (real Postgres, real session and CSRF)', () => {
  async function restoreAs(userId: string, driveId: string, backupId: string) {
    const token = await sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 60 * 60 * 1000 });
    const claims = await sessionService.validateSession(token);
    if (!claims) throw new Error('session did not validate');
    const response = await restoreBackup(
      new Request(`http://localhost/api/drives/${driveId}/backups/${backupId}/restore`, {
        method: 'POST',
        headers: {
          cookie: `${COOKIE_CONFIG.session.name}=${token}`,
          'x-csrf-token': generateCSRFToken(claims.sessionId),
          origin: APP_ORIGIN,
        },
      }),
      { params: Promise.resolve({ driveId, backupId }) },
    );
    expect(response.status).toBe(200);
  }

  async function backupOf(driveId: string, userId: string) {
    const backup = await createDriveBackup(driveId, userId, { label: 'before' });
    if (!backup.success || !backup.backupId) throw new Error('backup failed');
    return backup.backupId;
  }

  it('given a restore that drops a member, should revoke their Imago agents', async () => {
    const owner = await factories.createUser();
    const admin = await factories.createUser();
    seededUserIds.push(owner.id, admin.id);
    await factories.createDrive(admin.id, { kind: 'HOME', name: 'Home', slug: 'home' });
    const drive = await factories.createDrive(owner.id, { name: 'Shared' });
    const backupId = await backupOf(drive.id, owner.id);
    await factories.createDriveMember(drive.id, admin.id, { role: 'ADMIN', acceptedAt: new Date() });
    const agents = Object.values((await provisionImagoAgents(admin.id)).agents);
    expect((await setImagoDriveAccess(admin.id, drive.id, true)).ok).toBe(true);
    expect(await agentsIn(drive.id, agents)).toHaveLength(agents.length);

    await restoreAs(owner.id, drive.id, backupId);

    expect(await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, drive.id), eq(driveMembers.userId, admin.id)))).toEqual([]);
    expect(await agentsIn(drive.id, agents)).toEqual([]);
  });

  it("given a backup taken before the owner's lazily created member row, should keep the owner's own Imago agents", async () => {
    const owner = await factories.createUser();
    seededUserIds.push(owner.id);
    await factories.createDrive(owner.id, { kind: 'HOME', name: 'Home', slug: 'home' });
    const drive = await factories.createDrive(owner.id, { name: 'Owned' });
    const agents = Object.values((await provisionImagoAgents(owner.id)).agents);
    expect(await agentsIn(drive.id, agents)).toHaveLength(agents.length);
    const backupId = await backupOf(drive.id, owner.id);
    // The owner's first visit creates their OWNER row, after the backup.
    await updateDriveLastAccessed(owner.id, drive.id);

    await restoreAs(owner.id, drive.id, backupId);

    expect(await agentsIn(drive.id, agents)).toHaveLength(agents.length);
  });
});
