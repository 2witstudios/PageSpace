/**
 * `drive_envs` Sprite reclaim trigger (0263) — against a REAL database.
 *
 * The sibling suite (`schema/__tests__/drive-boxes.test.ts`) asserts the
 * trigger's SQL TEXT, which proves the migration says the right thing and
 * nothing about what Postgres does with it. Presence is not function: a
 * trigger whose function was renamed out from under it, or one created
 * DISABLED, or a WHEN clause that quietly never matches, all pass a text
 * assertion and lose a live, billing microVM in production.
 *
 * So this deletes real rows and reads the outbox. The path it walks is the
 * expensive one: deleting the DRIVE, so the env row dies by referential
 * cascade rather than by a direct DELETE — which is how a permanent drive
 * delete and an Art. 17 erasure both reach it, and the case a per-delete-path
 * guard would have missed.
 *
 * Excluded from the default `vitest run` (no database there) — see
 * `vitest.config.ts`. Run with:
 *     bun run --filter '@pagespace/db' test:integration -- src/__tests__/drive-envs-reclaim-trigger.integration.test.ts
 * It fails loudly rather than skipping when DATABASE_URL is absent: a silently
 * skipped reclaim test has already hidden a real failure in this repo once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

let client: Client;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'drive-envs-reclaim-trigger.integration.test.ts requires DATABASE_URL pointed at a ' +
        'migrated database. It is not skippable: this trigger is the last pointer to a ' +
        'billing VM whose row is disappearing, and a silent skip proves nothing.',
    );
  }
  client = new Client({ connectionString: url });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
});

/**
 * A unique suffix per test. `process.hrtime.bigint()` rather than a counter so
 * two files running against the same database cannot collide on ids.
 */
function uniqueSuffix(label: string): string {
  return `${label}-${process.pid}-${process.hrtime.bigint()}`;
}

/**
 * A drive + owner to hang boxes off. Every caller deletes the USER in its
 * `finally`, which cascades to the drive, its boxes and its sessions — so a
 * failing assertion still cleans up after itself.
 */
async function seedDrive(suffix: string): Promise<{ userId: string; driveId: string }> {
  const userId = `u-${suffix}`;
  const driveId = `d-${suffix}`;
  await client.query(
    `INSERT INTO users (id, name, email) VALUES ($1, 'drive env probe', $2)`,
    [userId, `${suffix}@example.test`],
  );
  await client.query(
    `INSERT INTO drives (id, name, slug, "ownerId", "updatedAt")
     VALUES ($1, 'env probe drive', $2, $3, (now() at time zone 'utc'))`,
    [driveId, `env-probe-${suffix}`, userId],
  );
  return { userId, driveId };
}

describe('drive_envs sprite reclaim trigger — live', () => {
  it('should be armed and ENABLED on drive_envs', async () => {
    // Filtered by NAME rather than asserting the table has exactly one trigger:
    // Phase 2 may well add another, and this test is about THIS trigger being
    // alive, not about the table staying single-triggered forever.
    const { rows } = await client.query<{ tgname: string; proname: string; tgenabled: string }>(
      `SELECT t.tgname, p.proname, t.tgenabled
         FROM pg_trigger t
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'drive_envs'::regclass
          AND NOT t.tgisinternal
          AND t.tgname = 'drive_envs_sprite_reclaim'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].proname).toBe('drive_envs_capture_sprite_reclaim');
    // 'O' = enabled for origin+local. A disabled trigger is silent data loss.
    expect(rows[0].tgenabled).toBe('O');
  });

  /**
   * The two-stage rule, asserted against the DATABASE rather than against the
   * migration's text. `convalidated` is the only authority on whether a
   * constraint was scanned; a regex over the SQL file proves the file says a
   * word, and would keep passing if the statements were reordered.
   */
  it('should ship the populated-table CHECKs NOT VALID and the new-table CHECK VALID', async () => {
    const { rows } = await client.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN (
          'agent_workspaces_env_no_sprite_check',
          'agent_workspaces_env_needs_drive_check'
        )
        ORDER BY conname`,
    );
    const validated = new Map(rows.map((r) => [r.conname, r.convalidated]));
    expect([...validated.keys()].sort()).toEqual([
      'agent_workspaces_env_needs_drive_check',
      'agent_workspaces_env_no_sprite_check',
    ]);
    // `agent_workspaces` is populated — stage 2 (`VALIDATE CONSTRAINT`) is a
    // separate release. If either of these flips to true inside THIS release,
    // the two-stage rule was broken.
    expect(validated.get('agent_workspaces_env_no_sprite_check')).toBe(false);
    expect(validated.get('agent_workspaces_env_needs_drive_check')).toBe(false);
  });

  it('given an env with a live Sprite pointer, should MOVE it into the outbox when the drive cascade deletes it', async () => {
    const suffix = uniqueSuffix('envrec');
    const sandboxId = `pgs-env-${suffix}`;
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await client.query(
        `INSERT INTO drive_envs (id, "driveId", name, "createdBy", "sandboxId", "spriteInstanceId", "updatedAt")
         VALUES ($1, $2, 'dev', $3, $4, $5, (now() at time zone 'utc'))`,
        [`b-${suffix}`, driveId, userId, sandboxId, 'inst-1'],
      );

      // The cascade path, not a direct DELETE FROM drive_envs: this is how a
      // permanent drive delete and an account erasure both reach the row.
      await client.query(`DELETE FROM drives WHERE id = $1`, [driveId]);

      const { rows } = await client.query<{ sandboxId: string; spriteInstanceId: string | null }>(
        `SELECT "sandboxId", "spriteInstanceId" FROM machine_sprite_reclaims WHERE "sandboxId" = $1`,
        [sandboxId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].spriteInstanceId).toBe('inst-1');
    } finally {
      await client.query(`DELETE FROM machine_sprite_reclaims WHERE "sandboxId" = $1`, [sandboxId]);
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  it('given a Sprite already CONFIRMED destroyed, should enqueue nothing', async () => {
    const suffix = uniqueSuffix('envrec-torn');
    const sandboxId = `pgs-env-${suffix}`;
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await client.query(
        `INSERT INTO drive_envs (id, "driveId", name, "sandboxId", "spriteTornDownAt", "updatedAt")
         VALUES ($1, $2, 'staging', $3, (now() at time zone 'utc'), (now() at time zone 'utc'))`,
        [`b-${suffix}`, driveId, sandboxId],
      );
      await client.query(`DELETE FROM drives WHERE id = $1`, [driveId]);

      const { rows } = await client.query(
        `SELECT 1 FROM machine_sprite_reclaims WHERE "sandboxId" = $1`,
        [sandboxId],
      );
      // A row here would have the orphan cron chase a name whose VM is gone,
      // forever — the outbox retries a failed kill indefinitely by design.
      expect(rows).toHaveLength(0);
    } finally {
      await client.query(`DELETE FROM machine_sprite_reclaims WHERE "sandboxId" = $1`, [sandboxId]);
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  /**
   * An env OWNS its sessions. This walks the whole ownership chain in one
   * delete and asserts BOTH halves of it: what a cascade is supposed to take,
   * and — more importantly — what it must not reach.
   *
   * `envId` used to be `ON DELETE SET NULL`, on the reasoning that a session
   * had to outlive its env "so its conversations stay readable". That was
   * false: `conversations` has carried no session column since 0256, and a
   * pane's `targetId` is polymorphic with no FK, so a conversation is not
   * reachable from a session at all. The false premise bought a real defect —
   * a nulled binding is indistinguishable from a never-provisioned session, so
   * reopening it would provision a fresh empty Sprite instead of returning to
   * the shared filesystem.
   */
  it('given an env-bound session, deleting the ENV should take the session, its nodes and its shells — but NOT the conversation', async () => {
    const suffix = uniqueSuffix('envsess');
    const sandboxId = `pgs-env-${suffix}`;
    const envId = `b-${suffix}`;
    const workspaceId = `ws-${suffix}`;
    const conversationId = `conv-${suffix}`;
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await client.query(
        `INSERT INTO drive_envs (id, "driveId", name, "sandboxId", "spriteInstanceId", "updatedAt")
         VALUES ($1, $2, 'dev', $3, 'inst-1', (now() at time zone 'utc'))`,
        [envId, driveId, sandboxId],
      );
      // An env-bound session: drive set, env set, and NO sprite pointer of its
      // own — it borrows the env's.
      await client.query(
        `INSERT INTO agent_workspaces (id, "ownerId", "driveId", "envId", "updatedAt")
         VALUES ($1, $2, $3, $4, (now() at time zone 'utc'))`,
        [workspaceId, userId, driveId, envId],
      );
      // A pane tree (root node) and a shell — the two things that cascade from
      // a session row and therefore die with the env.
      await client.query(
        `INSERT INTO agent_workspace_nodes (id, "rootId", "parentId", position, "nodeType", axis, "createdAt", "updatedAt")
         VALUES ($1, $2, NULL, 0, 'root', 'row', (now() at time zone 'utc'), (now() at time zone 'utc'))`,
        [`${workspaceId}-root`, workspaceId],
      );
      await client.query(
        `INSERT INTO agent_workspace_shells (id, "workspaceId", "ownerId", name, "agentType", "updatedAt")
         VALUES ($1, $2, $3, 'sh', 'shell', (now() at time zone 'utc'))`,
        [`sh-${suffix}`, workspaceId, userId],
      );
      // A conversation owned by the same user. It is NOT attached to the
      // session — that is the whole point — so it must be untouched.
      await client.query(
        `INSERT INTO conversations (id, "userId", type, "contextId", "updatedAt")
         VALUES ($1, $2, 'drive', $3, (now() at time zone 'utc'))`,
        [conversationId, userId, driveId],
      );

      await client.query(`DELETE FROM drive_envs WHERE id = $1`, [envId]);

      // The session and everything that hangs off it are GONE.
      for (const [table, column, id] of [
        ['agent_workspaces', 'id', workspaceId],
        ['agent_workspace_nodes', '"rootId"', workspaceId],
        ['agent_workspace_shells', '"workspaceId"', workspaceId],
      ] as const) {
        const { rows } = await client.query(
          `SELECT 1 FROM ${table} WHERE ${column} = $1`,
          [id],
        );
        expect(rows, `${table} should have cascaded away with the env`).toHaveLength(0);
      }

      // The CONVERSATION survives. Nothing links it to the session, so a
      // cascade cannot reach it — this is the assertion that would catch
      // someone "helpfully" adding a session FK to `conversations` later.
      const { rows: convs } = await client.query(
        `SELECT 1 FROM conversations WHERE id = $1`,
        [conversationId],
      );
      expect(convs, 'chat history must outlive the env').toHaveLength(1);

      // And the env's Sprite is still reclaimed on the way out.
      const { rows: reclaims } = await client.query(
        `SELECT 1 FROM machine_sprite_reclaims WHERE "sandboxId" = $1`,
        [sandboxId],
      );
      expect(reclaims).toHaveLength(1);
    } finally {
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await client.query(`DELETE FROM machine_sprite_reclaims WHERE "sandboxId" = $1`, [sandboxId]);
    }
  });

  /**
   * Both `drive_envs` and `agent_workspaces` cascade from `drives`, and the
   * session additionally cascades from the env. Deleting the drive fires all
   * three at once, by two different routes into the same session row. This asserts they cooperate — the
   * pointer still reaches the outbox even though the row holding the binding
   * is itself being destroyed in the same statement.
   */
  it('given a drive holding an env AND a env-bound session, deleting the drive should still reclaim', async () => {
    const suffix = uniqueSuffix('envcasc');
    const sandboxId = `pgs-env-${suffix}`;
    const envId = `b-${suffix}`;
    const workspaceId = `ws-${suffix}`;
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await client.query(
        `INSERT INTO drive_envs (id, "driveId", name, "sandboxId", "spriteInstanceId", "updatedAt")
         VALUES ($1, $2, 'dev', $3, 'inst-1', (now() at time zone 'utc'))`,
        [envId, driveId, sandboxId],
      );
      await client.query(
        `INSERT INTO agent_workspaces (id, "ownerId", "driveId", "envId", "updatedAt")
         VALUES ($1, $2, $3, $4, (now() at time zone 'utc'))`,
        [workspaceId, userId, driveId, envId],
      );

      await client.query(`DELETE FROM drives WHERE id = $1`, [driveId]);

      const { rows } = await client.query<{ spriteInstanceId: string | null }>(
        `SELECT "spriteInstanceId" FROM machine_sprite_reclaims WHERE "sandboxId" = $1`,
        [sandboxId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].spriteInstanceId).toBe('inst-1');

      // Both rows went with the drive; only the FK-less outbox survives.
      const { rows: left } = await client.query(
        `SELECT 1 FROM agent_workspaces WHERE id = $1`,
        [workspaceId],
      );
      expect(left).toHaveLength(0);
    } finally {
      await client.query(`DELETE FROM machine_sprite_reclaims WHERE "sandboxId" = $1`, [sandboxId]);
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  it('given a reused sandbox NAME now holds a newer VM, should chase the live instance rather than keep the stale one', async () => {
    const suffix = uniqueSuffix('envrec-aba');
    const sandboxId = `pgs-env-${suffix}`;
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await client.query(
        `INSERT INTO machine_sprite_reclaims ("sandboxId", "spriteInstanceId") VALUES ($1, 'inst-old')`,
        [sandboxId],
      );
      await client.query(
        `INSERT INTO drive_envs (id, "driveId", name, "sandboxId", "spriteInstanceId", "updatedAt")
         VALUES ($1, $2, 'dev', $3, 'inst-new', (now() at time zone 'utc'))`,
        [`b-${suffix}`, driveId, sandboxId],
      );
      await client.query(`DELETE FROM drives WHERE id = $1`, [driveId]);

      const { rows } = await client.query<{ spriteInstanceId: string | null }>(
        `SELECT "spriteInstanceId" FROM machine_sprite_reclaims WHERE "sandboxId" = $1`,
        [sandboxId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].spriteInstanceId).toBe('inst-new');
    } finally {
      await client.query(`DELETE FROM machine_sprite_reclaims WHERE "sandboxId" = $1`, [sandboxId]);
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });
});

describe('drive_envs CHECK constraints — live', () => {
  it('given an env-bound session, should REFUSE a sprite pointer of its own', async () => {
    const suffix = uniqueSuffix('wschk');
    const envId = `b-${suffix}`;
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await client.query(
        `INSERT INTO drive_envs (id, "driveId", name, "updatedAt")
         VALUES ($1, $2, 'dev', (now() at time zone 'utc'))`,
        [envId, driveId],
      );

      // An env session borrows the env's VM. Two rows claiming one Sprite is
      // the failure this CHECK exists to make impossible. NOT VALID does not
      // weaken this: new rows are fully checked from the moment it lands.
      //
      // All THREE pointer columns, not just `sandboxId` — each is independently
      // enough to make two rows claim one VM (`sandboxId` addresses it,
      // `spriteKey` re-derives it, `spriteInstanceId` is what every teardown
      // CAS keys on), so each has to be refused on its own.
      for (const column of ['sandboxId', 'spriteKey', 'spriteInstanceId']) {
        await expect(
          client.query(
            `INSERT INTO agent_workspaces (id, "ownerId", "driveId", "envId", "${column}", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, (now() at time zone 'utc'))`,
            [`ws-${column}-${suffix}`, userId, driveId, envId, `pgs-ses-${suffix}`],
          ),
        ).rejects.toThrow(/agent_workspaces_env_no_sprite_check/);
      }

      // The positive case: an UNBOUND session may hold
      // every pointer. Flipping this predicate's `OR` to `AND` would reject
      // every ordinary ephemeral session, and only this case notices.
      await client.query(
        `INSERT INTO agent_workspaces (id, "ownerId", "driveId", "sandboxId", "spriteKey", "spriteInstanceId", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'inst-1', (now() at time zone 'utc'))`,
        [`ws-free-${suffix}`, userId, driveId, `pgs-ses-free-${suffix}`, `key-${suffix}`],
      );

      // The same row WITHOUT a pointer is accepted — the constraint refuses
      // the conflation, not the binding.
      await client.query(
        `INSERT INTO agent_workspaces (id, "ownerId", "driveId", "envId", "updatedAt")
         VALUES ($1, $2, $3, $4, (now() at time zone 'utc'))`,
        [`ws-ok-${suffix}`, userId, driveId, envId],
      );
    } finally {
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
      // The unbound session above holds a live pointer, so deleting the user
      // cascades into the session table's own reclaim trigger.
      await client.query(`DELETE FROM machine_sprite_reclaims WHERE "sandboxId" = $1`, [`pgs-ses-free-${suffix}`]);
    }
  });

  it('given an env is drive-owned, should REFUSE a env-bound session with no drive', async () => {
    const suffix = uniqueSuffix('wsdrv');
    const envId = `b-${suffix}`;
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await client.query(
        `INSERT INTO drive_envs (id, "driveId", name, "updatedAt")
         VALUES ($1, $2, 'dev', (now() at time zone 'utc'))`,
        [envId, driveId],
      );

      // `driveId` is nullable for global-assistant sessions, but an env is
      // drive-owned, drive-paid and drive-shared: a user-scoped session
      // borrowing a drive's machine has no coherent access or billing answer,
      // and `decideAgentSessionAccess` reads `driveId` alone.
      await expect(
        client.query(
          `INSERT INTO agent_workspaces (id, "ownerId", "envId", "updatedAt")
           VALUES ($1, $2, $3, (now() at time zone 'utc'))`,
          [`ws-${suffix}`, userId, envId],
        ),
      ).rejects.toThrow(/agent_workspaces_env_needs_drive_check/);

      // A driveless session with NO env is still fine — that is the global
      // assistant, and this constraint must not have broken it.
      await client.query(
        `INSERT INTO agent_workspaces (id, "ownerId", "updatedAt")
         VALUES ($1, $2, (now() at time zone 'utc'))`,
        [`ws-global-${suffix}`, userId],
      );
    } finally {
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  it('given env names address, should REFUSE a duplicate name in one drive and ALLOW it across drives', async () => {
    const suffix = uniqueSuffix('envname');
    const userId = `u-${suffix}`;
    try {
      await client.query(`INSERT INTO users (id, name, email) VALUES ($1, 'p', $2)`, [userId, `${suffix}@example.test`]);
      for (const n of [1, 2]) {
        await client.query(
          `INSERT INTO drives (id, name, slug, "ownerId", "updatedAt") VALUES ($1, 'p', $2, $3, (now() at time zone 'utc'))`,
          [`d${n}-${suffix}`, `env-name-${n}-${suffix}`, userId],
        );
        await client.query(
          `INSERT INTO drive_envs (id, "driveId", name, "updatedAt")
           VALUES ($1, $2, 'staging', (now() at time zone 'utc'))`,
          [`b${n}-${suffix}`, `d${n}-${suffix}`],
        );
      }
      await expect(
        client.query(
          `INSERT INTO drive_envs (id, "driveId", name, "updatedAt")
           VALUES ($1, $2, 'staging', (now() at time zone 'utc'))`,
          [`bdup-${suffix}`, `d1-${suffix}`],
        ),
      ).rejects.toThrow(/drive_envs_drive_name_idx/);
    } finally {
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });
});
