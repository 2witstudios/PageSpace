/**
 * Local Environments epic — the substrate CHECK and the sibling's
 * cascade, proven against a REAL Postgres (a schema test cannot see whether
 * the constraint actually refuses a row).
 *
 * Run with a migrated test database:
 *   DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test \
 *   bun run --filter '@pagespace/db' test:integration -- drive-env-local
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { factories } from '../test/factories';
import { db } from '../db';
import { users } from '../schema/auth';
import { drives } from '../schema/core';
import { driveEnvs } from '../schema/drive-envs';
import { driveEnvLocal } from '../schema/drive-env-local';

/** drizzle 0.45 wraps driver errors; the Postgres SQLSTATE lives on `.cause`. */
function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const CHECK_VIOLATION = '23514';

describe('drive_envs.substrate + drive_env_local (real Postgres)', () => {
  const createdUsers: string[] = [];
  const createdDrives: string[] = [];

  async function seed() {
    const user = await factories.createUser();
    const drive = await factories.createDrive(user.id);
    createdUsers.push(user.id);
    createdDrives.push(drive.id);
    return { user, drive };
  }

  afterEach(async () => {
    for (const id of createdDrives.splice(0)) await db.delete(drives).where(eq(drives.id, id)).catch(() => {});
    for (const id of createdUsers.splice(0)) await db.delete(users).where(eq(users.id, id)).catch(() => {});
  });

  it('given an env inserted without a substrate, should default to sprite (existing rows and callers are unchanged)', async () => {
    const { drive } = await seed();
    const [env] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'default-env' }).returning();
    expect(env?.substrate).toBe('sprite');
  });

  it('given a sprite env, should still accept a Sprite pointer (the existing path is untouched)', async () => {
    const { drive } = await seed();
    const [env] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'sprite-env', sandboxId: 'sprite-abc', spriteKey: 'k' }).returning();
    expect(env?.sandboxId).toBe('sprite-abc');
  });

  it('given a local env with NULL Sprite columns, should insert', async () => {
    const { drive } = await seed();
    const [env] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'local-env', substrate: 'local' }).returning();
    expect(env?.substrate).toBe('local');
    expect(env?.sandboxId).toBeNull();
  });

  it.each([
    ['sandboxId', { sandboxId: 'sprite-abc' }],
    ['spriteKey', { spriteKey: 'k' }],
    ['spriteInstanceId', { spriteInstanceId: 'inst' }],
  ])('given a local env with a %s, should REJECT with check_violation 23514 (invariant 9: a local row can never carry a Sprite pointer)', async (_col, pointer) => {
    const { drive } = await seed();
    let code: string | undefined;
    try {
      await db.insert(driveEnvs).values({ driveId: drive.id, name: `bad-${_col}`, substrate: 'local', ...pointer });
    } catch (error) {
      code = pgCode(error);
    }
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('given a local env, UPDATING it to carry a Sprite pointer should also be refused', async () => {
    const { drive } = await seed();
    const [env] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'local-upd', substrate: 'local' }).returning();
    let code: string | undefined;
    try {
      await db.update(driveEnvs).set({ sandboxId: 'sprite-abc' }).where(eq(driveEnvs.id, env!.id));
    } catch (error) {
      code = pgCode(error);
    }
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('given a substrate outside the closed set, should be refused', async () => {
    const { drive } = await seed();
    let code: string | undefined;
    try {
      await db.insert(driveEnvs).values({ driveId: drive.id, name: 'weird', substrate: 'modal' as never });
    } catch (error) {
      code = pgCode(error);
    }
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('given a local env, should be structurally OUTSIDE the live-sprite predicate every cron keys off', async () => {
    const { drive } = await seed();
    const [env] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'invisible', substrate: 'local' }).returning();
    const rows = await db
      .select({ id: driveEnvs.id })
      .from(driveEnvs)
      .where(sql`${driveEnvs.id} = ${env!.id} AND ${driveEnvs.sandboxId} IS NOT NULL AND ${driveEnvs.spriteTornDownAt} IS NULL`);
    expect(rows).toEqual([]);
  });

  it('given a drive_env_local row, deleting its env should cascade the sibling', async () => {
    const { user, drive } = await seed();
    const [env] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'with-sibling', substrate: 'local' }).returning();
    await db.insert(driveEnvLocal).values({
      envId: env!.id,
      ownerId: user.id,
      label: 'jono-macstudio',
      enrollmentId: `enr_${env!.id}`,
      machinePublicKey: 'MCowBQYDK2VwAyEA',
      machineKeyFingerprint: 'sha256:abc',
      serverKeyId: 'k1',
    });
    expect((await db.select().from(driveEnvLocal).where(eq(driveEnvLocal.envId, env!.id))).length).toBe(1);
    await db.delete(driveEnvs).where(eq(driveEnvs.id, env!.id));
    expect((await db.select().from(driveEnvLocal).where(eq(driveEnvLocal.envId, env!.id))).length).toBe(0);
  });

  it('given a SPRITE env, inserting a drive_env_local sibling for it should be REFUSED (foreign_key_violation 23503) — local metadata can never attach to a Sprite env', async () => {
    const { user, drive } = await seed();
    const [env] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'sprite-parent' }).returning();
    let code: string | undefined;
    try {
      await db.insert(driveEnvLocal).values({ envId: env!.id, ownerId: user.id, label: 'm', enrollmentId: `enr_sp_${env!.id}`, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1' });
    } catch (error) {
      code = pgCode(error);
    }
    expect(code).toBe('23503');
  });

  it("given a local env WITH a sibling, flipping the parent to 'sprite' should be REFUSED (23503) — the composite FK holds both write directions", async () => {
    const { user, drive } = await seed();
    const [env] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'flip', substrate: 'local' }).returning();
    await db.insert(driveEnvLocal).values({ envId: env!.id, ownerId: user.id, label: 'm', enrollmentId: `enr_flip_${env!.id}`, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1' });
    let code: string | undefined;
    try {
      await db.update(driveEnvs).set({ substrate: 'sprite' }).where(eq(driveEnvs.id, env!.id));
    } catch (error) {
      code = pgCode(error);
    }
    expect(code).toBe('23503');
  });

  it("given a local env whose sibling was deleted, flipping the parent to 'sprite' should then succeed (the invariant is about the pair, not the column)", async () => {
    const { user, drive } = await seed();
    const [env] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'flip-ok', substrate: 'local' }).returning();
    await db.insert(driveEnvLocal).values({ envId: env!.id, ownerId: user.id, label: 'm', enrollmentId: `enr_flipok_${env!.id}`, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1' });
    await db.delete(driveEnvLocal).where(eq(driveEnvLocal.envId, env!.id));
    const [updated] = await db.update(driveEnvs).set({ substrate: 'sprite' }).where(eq(driveEnvs.id, env!.id)).returning();
    expect(updated?.substrate).toBe('sprite');
  });

  it("given a sibling inserted with substrate 'sprite' explicitly, should be refused by the sibling's own CHECK (23514)", async () => {
    const { user, drive } = await seed();
    const [env] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'sib-check', substrate: 'local' }).returning();
    let code: string | undefined;
    try {
      await db.insert(driveEnvLocal).values({ envId: env!.id, ownerId: user.id, substrate: 'sprite' as never, label: 'm', enrollmentId: `enr_sc_${env!.id}`, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1' });
    } catch (error) {
      code = pgCode(error);
    }
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("given a sibling owned by a user, DELETING that user should cascade the sibling (Art 17: the machine's identity facts go with the subject) while the drive env row survives as a dead local env", async () => {
    const { user, drive } = await seed();
    const machineOwner = await factories.createUser();
    const [env] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'owned', substrate: 'local' }).returning();
    await db.insert(driveEnvLocal).values({ envId: env!.id, ownerId: machineOwner.id, label: 'm', enrollmentId: `enr_own_${env!.id}`, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1' });
    await db.delete(users).where(eq(users.id, machineOwner.id));
    expect((await db.select().from(driveEnvLocal).where(eq(driveEnvLocal.envId, env!.id))).length).toBe(0);
    expect((await db.select().from(driveEnvs).where(eq(driveEnvs.id, env!.id))).length).toBe(1);
    void user;
  });

  it('given a sibling row, should default bindPolicy to owner and serverPolicy to deny-by-default', async () => {
    const { user, drive } = await seed();
    const [env] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'defaults', substrate: 'local' }).returning();
    const [row] = await db.insert(driveEnvLocal).values({ envId: env!.id, ownerId: user.id, label: 'm', enrollmentId: `enr2_${env!.id}`, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1' }).returning();
    expect(row?.bindPolicy).toBe('owner');
    expect(row?.serverPolicy).toEqual({ ops: [], checkpoint: false });
    expect(row?.revokedAt).toBeNull();
  });

  it('given a bindPolicy outside the closed set, should be refused', async () => {
    const { user, drive } = await seed();
    const [env] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'badpolicy', substrate: 'local' }).returning();
    let code: string | undefined;
    try {
      await db.insert(driveEnvLocal).values({ envId: env!.id, ownerId: user.id, label: 'm', enrollmentId: `enr3_${env!.id}`, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1', bindPolicy: 'everyone' as never });
    } catch (error) {
      code = pgCode(error);
    }
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('given two siblings with the same enrollmentId, should refuse the second (unique_violation 23505)', async () => {
    const { user, drive } = await seed();
    const [a] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'a', substrate: 'local' }).returning();
    const [b] = await db.insert(driveEnvs).values({ driveId: drive.id, name: 'b', substrate: 'local' }).returning();
    await db.insert(driveEnvLocal).values({ envId: a!.id, ownerId: user.id, label: 'm', enrollmentId: 'enr_dup', machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1' });
    let code: string | undefined;
    try {
      await db.insert(driveEnvLocal).values({ envId: b!.id, ownerId: user.id, label: 'm', enrollmentId: 'enr_dup', machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1' });
    } catch (error) {
      code = pgCode(error);
    }
    expect(code).toBe('23505');
  });
});
