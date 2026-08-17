/**
 * `drive_boxes` Sprite reclaim trigger (0263) — against a REAL database.
 *
 * The sibling suite (`schema/__tests__/drive-boxes.test.ts`) asserts the
 * trigger's SQL TEXT, which proves the migration says the right thing and
 * nothing about what Postgres does with it. Presence is not function: a
 * trigger whose function was renamed out from under it, or one created
 * DISABLED, or a WHEN clause that quietly never matches, all pass a text
 * assertion and lose a live, billing microVM in production.
 *
 * So this deletes real rows and reads the outbox. The path it walks is the
 * expensive one: deleting the DRIVE, so the box row dies by referential
 * cascade rather than by a direct DELETE — which is how a permanent drive
 * delete and an Art. 17 erasure both reach it, and the case a per-delete-path
 * guard would have missed.
 *
 * Excluded from the default `vitest run` (no database there) — see
 * `vitest.config.ts`. Run with:
 *     bun run --filter '@pagespace/db' test:integration -- src/__tests__/drive-boxes-reclaim-trigger.integration.test.ts
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
      'drive-boxes-reclaim-trigger.integration.test.ts requires DATABASE_URL pointed at a ' +
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
    `INSERT INTO users (id, name, email) VALUES ($1, 'drive box probe', $2)`,
    [userId, `${suffix}@example.test`],
  );
  await client.query(
    `INSERT INTO drives (id, name, slug, "ownerId", "updatedAt")
     VALUES ($1, 'box probe drive', $2, $3, (now() at time zone 'utc'))`,
    [driveId, `box-probe-${suffix}`, userId],
  );
  return { userId, driveId };
}

describe('drive_boxes sprite reclaim trigger — live', () => {
  it('should be armed and ENABLED on drive_boxes', async () => {
    const { rows } = await client.query<{ tgname: string; proname: string; tgenabled: string }>(
      `SELECT t.tgname, p.proname, t.tgenabled
         FROM pg_trigger t
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'drive_boxes'::regclass AND NOT t.tgisinternal`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tgname).toBe('drive_boxes_sprite_reclaim');
    expect(rows[0].proname).toBe('drive_boxes_capture_sprite_reclaim');
    // 'O' = enabled for origin+local. A disabled trigger is silent data loss.
    expect(rows[0].tgenabled).toBe('O');
  });

  it('given a box with a live Sprite pointer, should MOVE it into the outbox when the drive cascade deletes it', async () => {
    const suffix = uniqueSuffix('boxrec');
    const sandboxId = `pgs-box-${suffix}`;
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await client.query(
        `INSERT INTO drive_boxes (id, "driveId", name, kind, "createdBy", "sandboxId", "spriteInstanceId", "updatedAt")
         VALUES ($1, $2, 'dev', 'dev', $3, $4, $5, (now() at time zone 'utc'))`,
        [`b-${suffix}`, driveId, userId, sandboxId, 'inst-1'],
      );

      // The cascade path, not a direct DELETE FROM drive_boxes: this is how a
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
    const suffix = uniqueSuffix('boxrec-torn');
    const sandboxId = `pgs-box-${suffix}`;
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await client.query(
        `INSERT INTO drive_boxes (id, "driveId", name, kind, "sandboxId", "spriteTornDownAt", "updatedAt")
         VALUES ($1, $2, 'staging', 'staging', $3, (now() at time zone 'utc'), (now() at time zone 'utc'))`,
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
   * The "sessions are history rows" claim, executed. `boxId` is `ON DELETE SET
   * NULL` precisely so that reclaiming a machine never destroys the
   * conversations that ran on it — and until this test, nothing proved the
   * database actually behaves that way rather than the docblock merely saying
   * so. A cascade here would silently delete user chat history as a side
   * effect of an admin deleting a box.
   */
  it('given a box-bound session, deleting the BOX should null the binding, KEEP the session, and still reclaim', async () => {
    const suffix = uniqueSuffix('boxsess');
    const sandboxId = `pgs-box-${suffix}`;
    const boxId = `b-${suffix}`;
    const workspaceId = `ws-${suffix}`;
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await client.query(
        `INSERT INTO drive_boxes (id, "driveId", name, kind, "sandboxId", "spriteInstanceId", "updatedAt")
         VALUES ($1, $2, 'dev', 'dev', $3, 'inst-1', (now() at time zone 'utc'))`,
        [boxId, driveId, sandboxId],
      );
      // A box-bound session: drive set, box set, and NO sprite pointer of its
      // own — it borrows the box's.
      await client.query(
        `INSERT INTO agent_workspaces (id, "ownerId", "driveId", "boxId", "updatedAt")
         VALUES ($1, $2, $3, $4, (now() at time zone 'utc'))`,
        [workspaceId, userId, driveId, boxId],
      );

      await client.query(`DELETE FROM drive_boxes WHERE id = $1`, [boxId]);

      const { rows: sessions } = await client.query<{ boxId: string | null; driveId: string | null }>(
        `SELECT "boxId", "driveId" FROM agent_workspaces WHERE id = $1`,
        [workspaceId],
      );
      // The session SURVIVES — this is the whole reason the FK is SET NULL.
      expect(sessions).toHaveLength(1);
      expect(sessions[0].boxId).toBeNull();
      // And it keeps its drive: nulling `driveId` too would silently convert it
      // into a global-assistant session, which is the failure mode that ruled
      // out a composite FK here.
      expect(sessions[0].driveId).toBe(driveId);

      // The box's Sprite is still reclaimed on the way out.
      const { rows: reclaims } = await client.query(
        `SELECT 1 FROM machine_sprite_reclaims WHERE "sandboxId" = $1`,
        [sandboxId],
      );
      expect(reclaims).toHaveLength(1);
    } finally {
      await client.query(`DELETE FROM machine_sprite_reclaims WHERE "sandboxId" = $1`, [sandboxId]);
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  /**
   * Both `drive_boxes` and `agent_workspaces` cascade from `drives`, and the
   * session additionally holds an `ON DELETE SET NULL` FK at the box. Deleting
   * the drive fires all three at once. This asserts they cooperate — the
   * pointer still reaches the outbox even though the row holding the binding
   * is itself being destroyed in the same statement.
   */
  it('given a drive holding a box AND a box-bound session, deleting the drive should still reclaim', async () => {
    const suffix = uniqueSuffix('boxcasc');
    const sandboxId = `pgs-box-${suffix}`;
    const boxId = `b-${suffix}`;
    const workspaceId = `ws-${suffix}`;
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await client.query(
        `INSERT INTO drive_boxes (id, "driveId", name, kind, "sandboxId", "spriteInstanceId", "updatedAt")
         VALUES ($1, $2, 'dev', 'dev', $3, 'inst-1', (now() at time zone 'utc'))`,
        [boxId, driveId, sandboxId],
      );
      await client.query(
        `INSERT INTO agent_workspaces (id, "ownerId", "driveId", "boxId", "updatedAt")
         VALUES ($1, $2, $3, $4, (now() at time zone 'utc'))`,
        [workspaceId, userId, driveId, boxId],
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
    const suffix = uniqueSuffix('boxrec-aba');
    const sandboxId = `pgs-box-${suffix}`;
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await client.query(
        `INSERT INTO machine_sprite_reclaims ("sandboxId", "spriteInstanceId") VALUES ($1, 'inst-old')`,
        [sandboxId],
      );
      await client.query(
        `INSERT INTO drive_boxes (id, "driveId", name, kind, "sandboxId", "spriteInstanceId", "updatedAt")
         VALUES ($1, $2, 'dev', 'dev', $3, 'inst-new', (now() at time zone 'utc'))`,
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

describe('drive_boxes CHECK constraints — live', () => {
  it('given a deploy box, should REFUSE a sprite pointer — this is what partitions the two outboxes', async () => {
    const suffix = uniqueSuffix('boxchk');
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await expect(
        client.query(
          `INSERT INTO drive_boxes (id, "driveId", name, kind, "sandboxId", "updatedAt")
           VALUES ($1, $2, 'prod', 'deploy', $3, (now() at time zone 'utc'))`,
          [`b-${suffix}`, driveId, `pgs-box-${suffix}`],
        ),
      ).rejects.toThrow(/drive_boxes_sprite_kind_check/);
    } finally {
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  it('given a box-bound session, should REFUSE a sprite pointer of its own', async () => {
    const suffix = uniqueSuffix('wschk');
    const boxId = `b-${suffix}`;
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await client.query(
        `INSERT INTO drive_boxes (id, "driveId", name, kind, "updatedAt")
         VALUES ($1, $2, 'dev', 'dev', (now() at time zone 'utc'))`,
        [boxId, driveId],
      );

      // A box session borrows the box's VM. Two rows claiming one Sprite is
      // the failure this CHECK exists to make impossible. NOT VALID does not
      // weaken this: new rows are fully checked from the moment it lands.
      await expect(
        client.query(
          `INSERT INTO agent_workspaces (id, "ownerId", "driveId", "boxId", "sandboxId", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, (now() at time zone 'utc'))`,
          [`ws-${suffix}`, userId, driveId, boxId, `pgs-ses-${suffix}`],
        ),
      ).rejects.toThrow(/agent_workspaces_box_no_sprite_check/);

      // The same row WITHOUT a pointer is accepted — the constraint refuses
      // the conflation, not the binding.
      await client.query(
        `INSERT INTO agent_workspaces (id, "ownerId", "driveId", "boxId", "updatedAt")
         VALUES ($1, $2, $3, $4, (now() at time zone 'utc'))`,
        [`ws-ok-${suffix}`, userId, driveId, boxId],
      );
    } finally {
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  it('given a box is drive-owned, should REFUSE a box-bound session with no drive', async () => {
    const suffix = uniqueSuffix('wsdrv');
    const boxId = `b-${suffix}`;
    const { userId, driveId } = await seedDrive(suffix);
    try {
      await client.query(
        `INSERT INTO drive_boxes (id, "driveId", name, kind, "updatedAt")
         VALUES ($1, $2, 'dev', 'dev', (now() at time zone 'utc'))`,
        [boxId, driveId],
      );

      // `driveId` is nullable for global-assistant sessions, but a box is
      // drive-owned, drive-paid and drive-shared: a user-scoped session
      // borrowing a drive's machine has no coherent access or billing answer,
      // and `decideAgentSessionAccess` reads `driveId` alone.
      await expect(
        client.query(
          `INSERT INTO agent_workspaces (id, "ownerId", "boxId", "updatedAt")
           VALUES ($1, $2, $3, (now() at time zone 'utc'))`,
          [`ws-${suffix}`, userId, boxId],
        ),
      ).rejects.toThrow(/agent_workspaces_box_needs_drive_check/);

      // A driveless session with NO box is still fine — that is the global
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

  it('given box names address, should REFUSE a duplicate name in one drive and ALLOW it across drives', async () => {
    const suffix = uniqueSuffix('boxname');
    const userId = `u-${suffix}`;
    try {
      await client.query(`INSERT INTO users (id, name, email) VALUES ($1, 'p', $2)`, [userId, `${suffix}@example.test`]);
      for (const n of [1, 2]) {
        await client.query(
          `INSERT INTO drives (id, name, slug, "ownerId", "updatedAt") VALUES ($1, 'p', $2, $3, (now() at time zone 'utc'))`,
          [`d${n}-${suffix}`, `box-name-${n}-${suffix}`, userId],
        );
        await client.query(
          `INSERT INTO drive_boxes (id, "driveId", name, kind, "updatedAt")
           VALUES ($1, $2, 'staging', 'staging', (now() at time zone 'utc'))`,
          [`b${n}-${suffix}`, `d${n}-${suffix}`],
        );
      }
      await expect(
        client.query(
          `INSERT INTO drive_boxes (id, "driveId", name, kind, "updatedAt")
           VALUES ($1, $2, 'staging', 'dev', (now() at time zone 'utc'))`,
          [`bdup-${suffix}`, `d1-${suffix}`],
        ),
      ).rejects.toThrow(/drive_boxes_drive_name_idx/);
    } finally {
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });
});
