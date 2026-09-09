/**
 * `drive_env_approvals` — the server's approval MIRROR on REAL Postgres (GA
 * wave 3, leaf 5). What only the database can prove: the CHECK that an ack
 * cannot exist without a revoke decision, the first-stamp-wins revoke, the ack
 * that lands only on a revoked row, the owed-revoke predicate the hello
 * replays, and the owner-join listing that never shows a machine the user
 * merely used. Non-UTC session locally (America/Chicago).
 *
 * Runs in CI: ci.yml's unit and test:integration steps and the NAMED
 * security.yml `test:db` step.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { driveEnvLocal } from '@pagespace/db/schema/drive-env-local';
import { driveEnvApprovals } from '@pagespace/db/schema/drive-env-approvals';
import { createDbApprovalMirrorStore, type ApprovalMirrorStore } from '../approval-mirror-store';
import { createDbDriveEnvStore } from '../drive-envs-store';

const ownerId = createId();
const otherOwnerId = createId();
const driveId = createId();
const NOW = new Date('2026-09-09T12:00:00.000Z');
const LATER = new Date('2026-09-09T12:05:00.000Z');

let store: ApprovalMirrorStore;
let envId: string;
let otherEnvId: string;

async function seedLocalEnv(owner: string, name: string): Promise<string> {
  const id = createId();
  await db.insert(driveEnvs).values({ id, driveId, name, substrate: 'local', createdBy: owner, updatedAt: NOW });
  await db.insert(driveEnvLocal).values({ envId: id, ownerId: owner, label: `${name}-book`, enrollmentId: `enr_${id}`, serverPolicy: { ops: ['exec'], checkpoint: false }, updatedAt: NOW });
  return id;
}

const remember = (id: string, over: Partial<{ envId: string; userId: string; scope: 'session' | '30d' | 'until_revoked'; expiresAt: Date | null; createdAt: Date }> = {}) =>
  store.remember({ id, envId: over.envId ?? envId, userId: over.userId ?? ownerId, op: 'exec', summary: "exec: sh -c 'git status'", scope: over.scope ?? '30d', createdAt: over.createdAt ?? NOW, expiresAt: over.expiresAt === undefined ? new Date(NOW.getTime() + 30 * 86_400_000) : over.expiresAt });

beforeAll(async () => {
  store = await createDbApprovalMirrorStore();
  await db.insert(users).values([
    { id: ownerId, email: `mirror-owner-${ownerId}@test.local`, name: 'Owner', updatedAt: NOW },
    { id: otherOwnerId, email: `mirror-other-${otherOwnerId}@test.local`, name: 'Other', updatedAt: NOW },
  ]).onConflictDoNothing();
  await db.insert(drives).values({ id: driveId, name: 'Mirror Drive', slug: `mirror-drive-${driveId}`, ownerId, updatedAt: NOW }).onConflictDoNothing();
});

beforeEach(async () => {
  await db.delete(driveEnvs).where(eq(driveEnvs.driveId, driveId));
  envId = await seedLocalEnv(ownerId, `mine-${createId().slice(0, 6)}`);
  otherEnvId = await seedLocalEnv(otherOwnerId, `theirs-${createId().slice(0, 6)}`);
});

afterAll(async () => {
  await db.delete(driveEnvs).where(eq(driveEnvs.driveId, driveId));
  await db.delete(drives).where(eq(drives.id, driveId));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.delete(users).where(eq(users.id, otherOwnerId));
});

describe('remember — the click ran, the mirror records it', () => {
  it('writes the row once; a second remember for the same id is the first row, unchanged', async () => {
    const first = await remember('ch_1');
    expect(first).toMatchObject({ id: 'ch_1', envId, userId: ownerId, op: 'exec', scope: '30d', revokedAt: null, revokeAcknowledgedAt: null });
    expect(first.createdAt.getTime()).toBe(NOW.getTime());
    const again = await remember('ch_1', { scope: 'until_revoked' });
    expect(again.scope).toBe('30d');
  });

  it('a `once` scope cannot be stored (CHECK): the vocabulary is the durable set', async () => {
    await expect(db.insert(driveEnvApprovals).values({ id: 'ch_once', envId, userId: ownerId, op: 'exec', summary: 's', scope: 'once', createdAt: NOW })).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
  });
});

describe('the revoke owed to the machine', () => {
  it('markRevoked stamps once (the first decision stays); markAcknowledged lands ONLY on a revoked, unacknowledged row and records the machine\'s count', async () => {
    await remember('ch_1');
    expect(await store.markAcknowledged({ id: 'ch_1', removed: 2, now: LATER })).toBeNull();
    const revoked = await store.markRevoked({ id: 'ch_1', by: ownerId, now: LATER });
    expect(revoked).toMatchObject({ revokedAt: LATER, revokedBy: ownerId, revokeAcknowledgedAt: null });
    const again = await store.markRevoked({ id: 'ch_1', by: 'someone-else', now: new Date(LATER.getTime() + 1000) });
    expect(again).toMatchObject({ revokedAt: LATER, revokedBy: ownerId });
    const acked = await store.markAcknowledged({ id: 'ch_1', removed: 2, now: new Date(LATER.getTime() + 2000) });
    expect(acked).toMatchObject({ revokeRemoved: 2 });
    expect(acked!.revokeAcknowledgedAt!.getTime()).toBe(LATER.getTime() + 2000);
    expect(await store.markAcknowledged({ id: 'ch_1', removed: 9, now: LATER })).toBeNull();
    expect(await store.markRevoked({ id: 'ch_nope', by: ownerId, now: LATER })).toBeNull();
  });

  it('the CHECK refuses an ack without a revoke decision', async () => {
    await expect(db.insert(driveEnvApprovals).values({ id: 'ch_bad', envId, userId: ownerId, op: 'exec', summary: 's', scope: '30d', createdAt: NOW, revokeAcknowledgedAt: NOW })).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
  });

  it('listUnacknowledgedRevokes: exactly the rows revoked and not acked, this env only, oldest decision first — what the hello replays', async () => {
    await remember('ch_a');
    await remember('ch_b');
    await remember('ch_c');
    await remember('ch_theirs', { envId: otherEnvId, userId: otherOwnerId });
    await store.markRevoked({ id: 'ch_b', by: ownerId, now: LATER });
    await store.markRevoked({ id: 'ch_a', by: ownerId, now: new Date(LATER.getTime() + 1000) });
    await store.markRevoked({ id: 'ch_theirs', by: otherOwnerId, now: LATER });
    await store.markRevoked({ id: 'ch_c', by: ownerId, now: new Date(LATER.getTime() + 2000) });
    await store.markAcknowledged({ id: 'ch_c', removed: 1, now: new Date(LATER.getTime() + 3000) });
    expect((await store.listUnacknowledgedRevokes(envId)).map((row) => row.id)).toEqual(['ch_b', 'ch_a']);
  });
});

describe('the two listings', () => {
  it('listActiveForEnv: in force only — revoked and expired rows are out, until_revoked never expires; newest first', async () => {
    await remember('ch_live');
    await remember('ch_forever', { scope: 'until_revoked', expiresAt: null, createdAt: new Date(NOW.getTime() + 1000) });
    await remember('ch_expired', { expiresAt: new Date(NOW.getTime() - 1) });
    await remember('ch_revoked', { createdAt: new Date(NOW.getTime() + 2000) });
    await store.markRevoked({ id: 'ch_revoked', by: ownerId, now: LATER });
    expect((await store.listActiveForEnv({ envId, now: NOW, limit: 50 })).map((row) => row.id)).toEqual(['ch_forever', 'ch_live']);
  });

  it('listActiveForOwner: the envs the user OWNS, with the env\'s drive, name and label — an approval the user holds on someone else\'s machine is that owner\'s to see', async () => {
    await remember('ch_mine');
    // The owner clicked on the OTHER owner's machine: the row's userId is the owner, the env is not theirs.
    await remember('ch_on_theirs', { envId: otherEnvId, userId: ownerId });
    const mine = await store.listActiveForOwner({ ownerId, now: NOW, limit: 50 });
    expect(mine.map((row) => row.id)).toEqual(['ch_mine']);
    expect(mine[0]).toMatchObject({ driveId, envLabel: expect.stringContaining('-book') });
    expect((await store.listActiveForOwner({ ownerId: otherOwnerId, now: NOW, limit: 50 })).map((row) => row.id)).toEqual(['ch_on_theirs']);
  });

  it('deleting the env cascades its mirror rows away', async () => {
    await remember('ch_gone');
    await db.delete(driveEnvs).where(eq(driveEnvs.id, envId));
    expect(await store.findById('ch_gone')).toBeNull();
  });
});

describe('listLocalByOwner — the account page\'s machines read (drive-envs-store)', () => {
  it('lists every machine the user OWNS with its env row, and none they merely use', async () => {
    const envStore = await createDbDriveEnvStore();
    const mine = await envStore.listLocalByOwner(ownerId);
    expect(mine.map((row) => row.env.id)).toEqual([envId]);
    expect(mine[0]).toMatchObject({ env: { substrate: 'local', driveId }, local: { ownerId, envId } });
    expect((await envStore.listLocalByOwner(otherOwnerId)).map((row) => row.env.id)).toEqual([otherEnvId]);
    expect(await envStore.listLocalByOwner('nobody')).toEqual([]);
  });
});
