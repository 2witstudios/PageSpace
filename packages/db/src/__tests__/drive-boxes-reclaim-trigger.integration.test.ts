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

describe('drive_boxes sprite reclaim trigger — live', () => {
  const url = process.env.DATABASE_URL;
  let client: Client;

  beforeAll(async () => {
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

  /** A drive + owner to hang boxes off, torn down with the caller's `finally`. */
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
    const suffix = `boxrec-${process.pid}-${process.hrtime.bigint()}`;
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
    const suffix = `boxrec-torn-${process.pid}-${process.hrtime.bigint()}`;
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

  it('given a reused sandbox NAME now holds a newer VM, should chase the live instance rather than keep the stale one', async () => {
    const suffix = `boxrec-aba-${process.pid}-${process.hrtime.bigint()}`;
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
  const url = process.env.DATABASE_URL;
  let client: Client;

  beforeAll(async () => {
    if (!url) throw new Error('drive-boxes-reclaim-trigger.integration.test.ts requires DATABASE_URL.');
    client = new Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it('given a deploy box, should REFUSE a sprite pointer — this is what partitions the two outboxes', async () => {
    const suffix = `boxchk-${process.pid}-${process.hrtime.bigint()}`;
    const userId = `u-${suffix}`;
    const driveId = `d-${suffix}`;
    try {
      await client.query(`INSERT INTO users (id, name, email) VALUES ($1, 'p', $2)`, [userId, `${suffix}@example.test`]);
      await client.query(
        `INSERT INTO drives (id, name, slug, "ownerId", "updatedAt") VALUES ($1, 'p', $2, $3, (now() at time zone 'utc'))`,
        [driveId, `box-chk-${suffix}`, userId],
      );
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
    const suffix = `wschk-${process.pid}-${process.hrtime.bigint()}`;
    const userId = `u-${suffix}`;
    const driveId = `d-${suffix}`;
    const boxId = `b-${suffix}`;
    try {
      await client.query(`INSERT INTO users (id, name, email) VALUES ($1, 'p', $2)`, [userId, `${suffix}@example.test`]);
      await client.query(
        `INSERT INTO drives (id, name, slug, "ownerId", "updatedAt") VALUES ($1, 'p', $2, $3, (now() at time zone 'utc'))`,
        [driveId, `ws-chk-${suffix}`, userId],
      );
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

  it('given box names address, should REFUSE a duplicate name in one drive and ALLOW it across drives', async () => {
    const suffix = `boxname-${process.pid}-${process.hrtime.bigint()}`;
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
