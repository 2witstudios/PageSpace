/**
 * `published_apps` hosting reclaim trigger (0265) — against a REAL database.
 *
 * The trigger is the only thing standing between a deleted row and a Fly app
 * that bills forever with nothing in our database pointing at it. Its SQL text
 * is readable in the migration; text is not behaviour. A trigger created
 * DISABLED, or one whose function was renamed out from under it, reads
 * perfectly and loses a billing resource in production — which is exactly what
 * happened to the Sprites equivalent before `machine_sprite_reclaims` existed.
 *
 * What this suite is really guarding is the RE-KEYING. `published_apps` used to
 * hang off `pages`; it now hangs off `drive_envs`, so every cascade that
 * reaches it arrives by a different route than the one the trigger was written
 * for. So the tests here delete an ENV and delete a DRIVE — never the hosting
 * row directly — because those are the paths a real unpublish-by-deletion takes
 * and the ones a per-delete-path guard would have missed.
 *
 * Excluded from the default `vitest run` (no database there) — see
 * `vitest.config.ts`. Run with:
 *     bun run --filter '@pagespace/db' test:integration -- src/__tests__/app-hosting-reclaim-trigger.integration.test.ts
 * It fails loudly rather than skipping when DATABASE_URL is absent: a silently
 * skipped reclaim test proves nothing about a pointer that has to survive.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

let client: Client;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'app-hosting-reclaim-trigger.integration.test.ts requires DATABASE_URL pointed at a ' +
        'migrated database. It is not skippable: this trigger is the last pointer to a ' +
        'billing Fly app whose row is disappearing, and a silent skip proves nothing.',
    );
  }
  client = new Client({ connectionString: url });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
});

/** A unique suffix per test, so two files against one database cannot collide on ids. */
function uniqueSuffix(label: string): string {
  return `${label}-${process.pid}-${process.hrtime.bigint()}`;
}

/**
 * An owner, a drive and an environment to publish. Every caller deletes the
 * USER in its `finally`, which cascades to the drive, its envs and their
 * hosting rows — so a failing assertion still cleans up after itself.
 */
async function seedEnv(suffix: string): Promise<{ userId: string; driveId: string; envId: string }> {
  const userId = `u-${suffix}`;
  const driveId = `d-${suffix}`;
  const envId = `e-${suffix}`;
  await client.query(
    `INSERT INTO users (id, name, email) VALUES ($1, 'app hosting probe', $2)`,
    [userId, `${suffix}@example.test`],
  );
  await client.query(
    `INSERT INTO drives (id, name, slug, "ownerId", "updatedAt")
     VALUES ($1, 'app hosting probe drive', $2, $3, (now() at time zone 'utc'))`,
    [driveId, `app-hosting-probe-${suffix}`, userId],
  );
  await client.query(
    `INSERT INTO drive_envs (id, "driveId", name, "createdBy", "updatedAt")
     VALUES ($1, $2, 'prod', $3, (now() at time zone 'utc'))`,
    [envId, driveId, userId],
  );
  return { userId, driveId, envId };
}

async function seedPublishedApp(
  suffix: string,
  { envId, driveId, userId, machineId = null }:
    { envId: string; driveId: string; userId: string; machineId?: string | null },
): Promise<{ appId: string; flyAppName: string }> {
  const appId = `pa-${suffix}`;
  const flyAppName = `pgs-app-${suffix}`;
  await client.query(
    `INSERT INTO published_apps
       (id, "envId", "driveId", "ownerId", "flyAppName", "networkName", subdomain, status, "machineId")
     VALUES ($1, $2, $3, $4, $5, 'published-apps', $6, 'provisioning', $7)`,
    [appId, envId, driveId, userId, flyAppName, `sub-${suffix}`, machineId],
  );
  return { appId, flyAppName };
}

describe('published_apps hosting reclaim trigger — live', () => {
  it('should be armed and ENABLED on published_apps', async () => {
    const { rows } = await client.query<{ tgname: string; proname: string; tgenabled: string }>(
      `SELECT t.tgname, p.proname, t.tgenabled
         FROM pg_trigger t
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'published_apps'::regclass
          AND NOT t.tgisinternal
          AND t.tgname = 'published_apps_hosting_reclaim'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].proname).toBe('published_apps_capture_hosting_reclaim');
    // 'O' = enabled for origin+local. A disabled trigger is silent data loss.
    expect(rows[0].tgenabled).toBe('O');
  });

  it('given a published env, deleting the ENV should rescue the Fly app name into the outbox', async () => {
    const suffix = uniqueSuffix('apprec-env');
    const { userId, driveId, envId } = await seedEnv(suffix);
    const { appId, flyAppName } = await seedPublishedApp(suffix, {
      envId,
      driveId,
      userId,
      machineId: 'm-1',
    });
    try {
      // The cascade the re-keying introduced: `published_apps` hangs off
      // `drive_envs` now, so deleting an env is the ordinary way a hosting row
      // dies — and the row carries the ONLY handle that can destroy the Fly app.
      await client.query(`DELETE FROM drive_envs WHERE id = $1`, [envId]);

      const { rows } = await client.query<{ publishedAppId: string | null; machineId: string | null }>(
        `SELECT "publishedAppId", "machineId" FROM app_hosting_reclaims WHERE "flyAppName" = $1`,
        [flyAppName],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].publishedAppId).toBe(appId);
      // The identity guard: destroy the app at this name only if it is still
      // the one we meant.
      expect(rows[0].machineId).toBe('m-1');
    } finally {
      await client.query(`DELETE FROM app_hosting_reclaims WHERE "flyAppName" = $1`, [flyAppName]);
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  it('given a drive delete cascading through the env, should still rescue the name', async () => {
    const suffix = uniqueSuffix('apprec-drive');
    const { userId, driveId, envId } = await seedEnv(suffix);
    const { flyAppName } = await seedPublishedApp(suffix, { envId, driveId, userId });
    try {
      // Two cascades deep — drives → drive_envs → published_apps — which is how
      // a permanent drive delete and an Art. 17 erasure both reach the row.
      // Postgres fires row-level triggers for cascade-deleted rows exactly as
      // for a direct DELETE, which is the property the single trigger relies on.
      await client.query(`DELETE FROM drives WHERE id = $1`, [driveId]);

      const { rows } = await client.query<{ machineId: string | null }>(
        `SELECT "machineId" FROM app_hosting_reclaims WHERE "flyAppName" = $1`,
        [flyAppName],
      );
      expect(rows).toHaveLength(1);
      // No machine ever existed, so the destroy is unambiguous.
      expect(rows[0].machineId).toBeNull();
    } finally {
      await client.query(`DELETE FROM app_hosting_reclaims WHERE "flyAppName" = $1`, [flyAppName]);
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  it('given the same Fly app name enqueued twice, should chase the machine that is actually live', async () => {
    const suffix = uniqueSuffix('apprec-conflict');
    const flyAppName = `pgs-app-${suffix}`;
    const first = await seedEnv(`${suffix}-a`);
    const second = await seedEnv(`${suffix}-b`);
    try {
      await client.query(
        `INSERT INTO published_apps
           (id, "envId", "driveId", "ownerId", "flyAppName", "networkName", subdomain, status, "machineId")
         VALUES ($1, $2, $3, $4, $5, 'published-apps', $6, 'provisioning', 'm-old')`,
        [`pa-${suffix}-a`, first.envId, first.driveId, first.userId, flyAppName, `sub-${suffix}-a`],
      );
      await client.query(`DELETE FROM drive_envs WHERE id = $1`, [first.envId]);

      // A second row takes the same name (the reclaim is name-keyed, so the
      // outbox has exactly one slot for it) and dies with a NEWER machine.
      await client.query(
        `INSERT INTO published_apps
           (id, "envId", "driveId", "ownerId", "flyAppName", "networkName", subdomain, status, "machineId")
         VALUES ($1, $2, $3, $4, $5, 'published-apps', $6, 'provisioning', 'm-new')`,
        [`pa-${suffix}-b`, second.envId, second.driveId, second.userId, flyAppName, `sub-${suffix}-b`],
      );
      await client.query(`DELETE FROM drive_envs WHERE id = $1`, [second.envId]);

      const { rows } = await client.query<{ publishedAppId: string | null; machineId: string | null }>(
        `SELECT "publishedAppId", "machineId" FROM app_hosting_reclaims WHERE "flyAppName" = $1`,
        [flyAppName],
      );
      expect(rows).toHaveLength(1);
      // Keeping the stale machine would have the drain cron protect a VM that
      // no longer exists and skip the one that does.
      expect(rows[0].publishedAppId).toBe(`pa-${suffix}-b`);
      expect(rows[0].machineId).toBe('m-new');
    } finally {
      await client.query(`DELETE FROM app_hosting_reclaims WHERE "flyAppName" = $1`, [flyAppName]);
      await client.query(`DELETE FROM users WHERE id = ANY($1)`, [[first.userId, second.userId]]);
    }
  });

  it('given an env is deleted, its hosting row should go with it — and unpublishing should NOT touch the env', async () => {
    const suffix = uniqueSuffix('apprec-oneway');
    const { userId, driveId, envId } = await seedEnv(suffix);
    const { appId, flyAppName } = await seedPublishedApp(suffix, { envId, driveId, userId });
    try {
      // Unpublish: the hosting row dies, the environment does not. The serving
      // tier is an artifact built FROM an env, never the env itself, so this
      // direction must leave the env — its Sprite, its sessions, its contents —
      // completely intact and re-publishable.
      await client.query(`DELETE FROM published_apps WHERE id = $1`, [appId]);

      const envRows = await client.query(`SELECT 1 FROM drive_envs WHERE id = $1`, [envId]);
      expect(envRows.rows).toHaveLength(1);
      // Even on this clean path the name is rescued: the drain cron's kill is
      // idempotent, so a redundant entry simply confirms the death — and it
      // covers a teardown that only THOUGHT it succeeded.
      const reclaims = await client.query(
        `SELECT 1 FROM app_hosting_reclaims WHERE "flyAppName" = $1`,
        [flyAppName],
      );
      expect(reclaims.rows).toHaveLength(1);
    } finally {
      await client.query(`DELETE FROM app_hosting_reclaims WHERE "flyAppName" = $1`, [flyAppName]);
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });
});
