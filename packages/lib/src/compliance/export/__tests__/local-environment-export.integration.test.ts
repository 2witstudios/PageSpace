/**
 * Local Environments epic (M1 · t05) — the Art 15 collector for the machines a
 * subject enrolled, run against a real database.
 *
 * `drive_env_local` is the subject's OWN device: a label they chose, their
 * machine's public key and fingerprint, when it enrolled and was last seen.
 * That is personal data in the plain sense, so it is a first-class export
 * category (`localEnvironments`) selected by `ownerId` — not an appendix to the
 * drive (which is organisation-owned and excluded) and not silently absent.
 * The coverage guard (`gdpr-export-coverage.test.ts`) is what forced the
 * decision to be written down; this test is what proves the collector reads
 * the table it claims to.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { driveEnvLocal } from '@pagespace/db/schema/drive-env-local';
import { factories } from '@pagespace/db/test/factories';
import { collectUserLocalEnvironments, collectAllUserData } from '../gdpr-export';

const createdUsers: string[] = [];
const createdDrives: string[] = [];

afterAll(async () => {
  if (createdDrives.length) await db.delete(drives).where(inArray(drives.id, createdDrives)).catch(() => {});
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers)).catch(() => {});
});

async function seedSubject() {
  const user = await factories.createUser();
  const drive = await factories.createDrive(user.id);
  createdUsers.push(user.id);
  createdDrives.push(drive.id);
  return { user, drive };
}

describe('collectUserLocalEnvironments (real Postgres)', () => {
  it("given a subject who enrolled a machine, should export that machine's facts joined with its env name and drive — and nothing of anyone else's", async () => {
    const subject = await seedSubject();
    const other = await seedSubject();
    const [mine] = await db.insert(driveEnvs).values({ driveId: subject.drive.id, name: 'my-mac', substrate: 'local' }).returning();
    const [theirs] = await db.insert(driveEnvs).values({ driveId: other.drive.id, name: 'their-box', substrate: 'local' }).returning();
    const [sprite] = await db.insert(driveEnvs).values({ driveId: subject.drive.id, name: 'cloud', sandboxId: 'pgs-env-1' }).returning();
    void sprite;
    await db.insert(driveEnvLocal).values({ envId: mine!.id, ownerId: subject.user.id, label: 'jono-macstudio', enrollmentId: `enr_${mine!.id}`, machinePublicKey: 'MCowBQYDK2VwAyEA', machineKeyFingerprint: 'sha256:abc', serverKeyId: 'k1', capabilities: { shell: true, pty: false, fs: true, checkpoint: false } });
    await db.insert(driveEnvLocal).values({ envId: theirs!.id, ownerId: other.user.id, label: 'not-mine', enrollmentId: `enr_${theirs!.id}`, machinePublicKey: 'pk2', machineKeyFingerprint: 'fp2', serverKeyId: 'k1' });

    const rows = await collectUserLocalEnvironments(db, subject.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      envId: mine!.id,
      driveId: subject.drive.id,
      envName: 'my-mac',
      label: 'jono-macstudio',
      machinePublicKey: 'MCowBQYDK2VwAyEA',
      machineKeyFingerprint: 'sha256:abc',
      serverKeyId: 'k1',
      bindPolicy: 'owner',
      capabilities: { shell: true, pty: false, fs: true, checkpoint: false },
      revokedAt: null,
    });
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    // Another subject's machine never appears, even in a drive the subject can see.
    expect(rows.map((r) => r.envId)).not.toContain(theirs!.id);
  });

  it('given a revoked enrollment, should still export it (revocation is a fact about the subject\'s machine, not a reason to hide it)', async () => {
    const subject = await seedSubject();
    const [env] = await db.insert(driveEnvs).values({ driveId: subject.drive.id, name: 'old-laptop', substrate: 'local' }).returning();
    const revokedAt = new Date('2026-09-01T00:00:00.000Z');
    await db.insert(driveEnvLocal).values({ envId: env!.id, ownerId: subject.user.id, label: 'old', enrollmentId: `enr_${env!.id}`, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1', revokedAt });
    const rows = await collectUserLocalEnvironments(db, subject.user.id);
    expect(rows.map((r) => r.label)).toContain('old');
    expect(rows.find((r) => r.label === 'old')?.revokedAt?.toISOString()).toBe(revokedAt.toISOString());
  });

  it('given a subject with no machines, should export an empty list (never null)', async () => {
    const subject = await seedSubject();
    expect(await collectUserLocalEnvironments(db, subject.user.id)).toEqual([]);
  });

  it('should land in collectAllUserData under localEnvironments', async () => {
    const subject = await seedSubject();
    const [env] = await db.insert(driveEnvs).values({ driveId: subject.drive.id, name: 'm', substrate: 'local' }).returning();
    await db.insert(driveEnvLocal).values({ envId: env!.id, ownerId: subject.user.id, label: 'all', enrollmentId: `enr_${env!.id}`, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1' });
    const all = await collectAllUserData(db, subject.user.id);
    expect(all?.localEnvironments.map((r) => r.label)).toEqual(['all']);
    await db.delete(driveEnvs).where(eq(driveEnvs.id, env!.id));
  });
});
