/**
 * Local Environments epic (GA wave 3) — the Art 15 collectors for what a
 * subject's agent RAN on local machines (`drive_env_grant_audit`) and what
 * those machines will run WITHOUT ASKING (`drive_env_approvals`), against a
 * real database.
 *
 * Both tables were caught unregistered by `gdpr-export-coverage.test.ts` on
 * the wave's first CI run. The ruling was collectors, not the allowlist: what
 * commands a person had run on their machine, and what programs they
 * approved, are their personal data — an export that omits them is
 * incomplete. This test proves the collectors read the rows they claim to
 * and none of anyone else's.
 *
 * Runner: named as a `test:db` step in `.github/workflows/security.yml`
 * (ci.yml's `test:integration` matches it too).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { driveEnvLocal } from '@pagespace/db/schema/drive-env-local';
import { driveEnvGrantAudit } from '@pagespace/db/schema/drive-env-grant-audit';
import { driveEnvApprovals } from '@pagespace/db/schema/drive-env-approvals';
import { factories } from '@pagespace/db/test/factories';
import { collectUserLocalEnvActivity, collectUserLocalEnvApprovals, collectAllUserData } from '../gdpr-export';

const createdUsers: string[] = [];
const createdDrives: string[] = [];

afterAll(async () => {
  if (createdDrives.length) await db.delete(drives).where(inArray(drives.id, createdDrives)).catch(() => {});
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers)).catch(() => {});
});

const T0 = new Date('2026-09-09T12:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

async function seedSubject() {
  const user = await factories.createUser();
  const drive = await factories.createDrive(user.id);
  createdUsers.push(user.id);
  createdDrives.push(drive.id);
  return { user, drive };
}

/** A local env owned by `owner` in `drive`. */
async function seedMachine(driveId: string, ownerId: string, name: string) {
  const [env] = await db.insert(driveEnvs).values({ driveId, name, substrate: 'local' }).returning();
  await db.insert(driveEnvLocal).values({ envId: env!.id, ownerId, label: name, enrollmentId: `enr_${env!.id}`, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1' });
  return env!.id;
}

describe('collectUserLocalEnvActivity (real Postgres)', () => {
  it("given grant rows the subject requested — signed, completed, refused — should export them as stored, oldest first, and nothing another requester ran (even on the subject's own machine)", async () => {
    const subject = await seedSubject();
    const other = await seedSubject();
    const mine = await seedMachine(subject.drive.id, subject.user.id, 'my-mac');
    const theirs = await seedMachine(other.drive.id, other.user.id, 'their-box');
    await db.insert(driveEnvGrantAudit).values([
      { id: 'ga_done', envId: mine, grantId: 'g_done', userId: subject.user.id, sessionId: 's1', conversationId: 'c1', op: 'exec', argsHash: 'sha256:a', summary: "exec: sh -c 'git status' in /home/o/proj", verdict: 'completed', exitCode: 0, ts: at(0), resultAt: at(1) },
      { id: 'ga_refused', envId: mine, grantId: null, userId: subject.user.id, sessionId: 's1', conversationId: 'c1', op: 'fs_write', argsHash: 'sha256:b', summary: 'fs_write: /etc/hosts', verdict: 'refused:server_denied', ts: at(2), resultAt: at(2) },
      { id: 'ga_running', envId: theirs, grantId: 'g_run', userId: subject.user.id, sessionId: 's2', conversationId: 'c2', op: 'exec', argsHash: 'sha256:c', summary: "exec: sh -c 'sleep 30'", verdict: 'signed', challengeId: 'ch_9', approvalScope: '30d', ts: at(3) },
      // The other user's request on the SUBJECT's machine: the owner's audit, not the subject's Art 15 data.
      { id: 'ga_not_mine', envId: mine, grantId: 'g_other', userId: other.user.id, sessionId: 's3', conversationId: 'c3', op: 'exec', argsHash: 'sha256:d', summary: 'exec: whoami', verdict: 'completed', exitCode: 0, ts: at(4), resultAt: at(5) },
    ]);

    const rows = await collectUserLocalEnvActivity(db, subject.user.id);
    expect(rows.map((r) => r.id)).toEqual(['ga_done', 'ga_refused', 'ga_running']);
    expect(rows[0]).toEqual({ id: 'ga_done', envId: mine, grantId: 'g_done', sessionId: 's1', conversationId: 'c1', op: 'exec', argsHash: 'sha256:a', summary: "exec: sh -c 'git status' in /home/o/proj", verdict: 'completed', exitCode: 0, challengeId: null, approvalScope: null, ts: at(0), resultAt: at(1) });
    expect(rows[1]).toMatchObject({ grantId: null, verdict: 'refused:server_denied', op: 'fs_write' });
    expect(rows[2]).toMatchObject({ envId: theirs, verdict: 'signed', resultAt: null, challengeId: 'ch_9', approvalScope: '30d' });
    expect(Object.keys(rows[0]!)).not.toContain('userId');
  });

  it('given a subject with no activity, should export an empty list (never null)', async () => {
    const subject = await seedSubject();
    expect(await collectUserLocalEnvActivity(db, subject.user.id)).toEqual([]);
  });
});

describe('collectUserLocalEnvApprovals (real Postgres)', () => {
  it('should export a row the subject CLICKED, a row standing on a machine the subject OWNS, and say which ground applied; revoked and expired rows included; a stranger\'s approval on a stranger\'s machine never', async () => {
    const subject = await seedSubject();
    const other = await seedSubject();
    const mine = await seedMachine(subject.drive.id, subject.user.id, 'my-mac');
    const theirs = await seedMachine(other.drive.id, other.user.id, 'their-box');
    await db.insert(driveEnvApprovals).values([
      // I clicked, on my machine.
      { id: 'ch_both', envId: mine, userId: subject.user.id, op: 'exec', summary: "exec: sh -c 'git status' in /home/o/proj", scope: '30d', createdAt: at(0), expiresAt: at(30 * 86_400) },
      // I clicked, on THEIR machine — mine as the clicker.
      { id: 'ch_clicker', envId: theirs, userId: subject.user.id, op: 'fs_read', summary: 'fs_read: /etc/hosts', scope: 'until_revoked', createdAt: at(1), expiresAt: null, revokedAt: at(10), revokedBy: other.user.id, revokeAcknowledgedAt: at(11), revokeRemoved: 1 },
      // They clicked, on MY machine — mine as the owner. Expired.
      { id: 'ch_owner', envId: mine, userId: other.user.id, op: 'exec', summary: 'exec: whoami', scope: 'session', daemonEpoch: 'ep_1', createdAt: at(2), expiresAt: at(3) },
      // They clicked, on their machine — not mine on any ground.
      { id: 'ch_stranger', envId: theirs, userId: other.user.id, op: 'exec', summary: 'exec: ls', scope: '30d', createdAt: at(4), expiresAt: at(30 * 86_400) },
    ]);

    const rows = await collectUserLocalEnvApprovals(db, subject.user.id);
    expect(rows.map((r) => [r.id, r.subject])).toEqual([['ch_both', 'both'], ['ch_clicker', 'clicker'], ['ch_owner', 'owner']]);
    expect(rows[0]).toEqual({ id: 'ch_both', envId: mine, driveId: subject.drive.id, envName: 'my-mac', subject: 'both', op: 'exec', summary: "exec: sh -c 'git status' in /home/o/proj", scope: '30d', createdAt: at(0), expiresAt: at(30 * 86_400), revokedAt: null, revokeAcknowledgedAt: null, revokeRemoved: null });
    expect(rows[1]).toMatchObject({ envName: 'their-box', driveId: other.drive.id, revokedAt: at(10), revokeAcknowledgedAt: at(11), revokeRemoved: 1 });
    expect(rows[2]).toMatchObject({ scope: 'session', expiresAt: at(3) });
    // Neither the clicker's id nor the owner's id leaks past the `subject` label; nor the machine's epoch.
    expect(Object.keys(rows[0]!)).toEqual(expect.not.arrayContaining(['userId', 'ownerId', 'approvalUserId', 'daemonEpoch', 'revokedBy']));
  });

  it('given a subject with no approvals on any ground, should export an empty list (never null)', async () => {
    const subject = await seedSubject();
    expect(await collectUserLocalEnvApprovals(db, subject.user.id)).toEqual([]);
  });

  it('both categories land in collectAllUserData', async () => {
    const subject = await seedSubject();
    const mine = await seedMachine(subject.drive.id, subject.user.id, 'm');
    await db.insert(driveEnvGrantAudit).values({ id: 'ga_all', envId: mine, grantId: 'g_all', userId: subject.user.id, sessionId: 's', conversationId: 'c', op: 'exec', argsHash: 'h', summary: 'exec: ls', verdict: 'signed', ts: at(0) });
    await db.insert(driveEnvApprovals).values({ id: 'ch_all', envId: mine, userId: subject.user.id, op: 'exec', summary: 'exec: ls', scope: '30d', createdAt: at(0), expiresAt: at(60) });
    const all = await collectAllUserData(db, subject.user.id);
    expect(all?.localEnvironmentActivity.map((r) => r.id)).toEqual(['ga_all']);
    expect(all?.localEnvironmentApprovals.map((r) => r.id)).toEqual(['ch_all']);
  });
});
