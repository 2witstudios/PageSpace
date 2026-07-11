/**
 * Partition-behavior integration tests for the Admin PG (#890 Phase 1, leaf 6).
 *
 * Acceptance: a fresh `db:migrate:admin` yields monthly RANGE-partitioned
 * chain tables with seeded partitions (current + 3 ahead + a DEFAULT safety
 * net); inserts route to the correct partition; the chain-head query stays
 * index-fast (EXPLAIN-asserted); `admin_ensure_partitions` is idempotent and
 * executable by admin_maintenance only; a DB that already holds rows from the
 * pre-partitioning migrations upgrades losslessly with a continuing
 * chain_seq sequence.
 *
 * Requires a running scratch Postgres (never the app DB):
 *   docker run --rm -d --name pagespace-admin-smoke -p 55432:5432 \
 *     -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=pagespace_admin postgres:16
 *   ADMIN_DATABASE_URL=postgresql://admin:admin@localhost:55432/pagespace_admin \
 *     bunx vitest run --config vitest.integration.config.ts src/__tests__/admin-partition.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import {
  migrateAdminDb,
  ADMIN_MIGRATIONS_FOLDER,
  ADMIN_MIGRATIONS_SCHEMA,
  ADMIN_MIGRATIONS_TABLE,
} from '../migrate-admin';
import { runMigrations } from '../migration-runner';

const url = process.env.ADMIN_DATABASE_URL;

const ROLES = [
  'admin_app',
  'admin_chainer',
  'admin_gdpr_eraser',
  'admin_reader',
  'admin_siem',
  'admin_maintenance',
] as const;

const PARTITIONED_PARENTS = ['security_audit_log', 'siem_delivery_receipts'] as const;

/** First day of the month `offset` months from now, in UTC (matches the scratch container's TZ). */
function monthStartUtc(offset: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

/** Mid-month timestamp `offset` months from now — safely inside one partition. */
function midMonthUtc(offset: number): Date {
  const start = monthStartUtc(offset);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 15, 12));
}

/** Partition name for the month `offset` months from now, e.g. security_audit_log_p2026_07. */
function partitionName(parent: string, offset: number): string {
  const start = monthStartUtc(offset);
  const y = start.getUTCFullYear();
  const m = String(start.getUTCMonth() + 1).padStart(2, '0');
  return `${parent}_p${y}_${m}`;
}

async function resetScratchDb(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS drizzle_admin CASCADE');
  await pool.query('CREATE SCHEMA public');
  for (const role of ROLES) {
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
          DROP OWNED BY ${role};
          DROP ROLE ${role};
        END IF;
      END $$;
    `);
  }
}

async function listPartitions(pool: Pool, parent: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT c.relname FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class pc ON pc.oid = i.inhparent
     WHERE pc.relname = $1 ORDER BY c.relname`,
    [parent],
  );
  return rows.map((r: { relname: string }) => r.relname);
}

describe.skipIf(!url)('monthly partitioning on a fresh Admin PG', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 3 });
    await resetScratchDb(pool);
    await migrateAdminDb({ ADMIN_DATABASE_URL: url });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('should create both chain tables as RANGE-partitioned parents; cursors stay plain', async () => {
    const { rows } = await pool.query(
      `SELECT c.relname, c.relkind, p.partstrat
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_partitioned_table p ON p.partrelid = c.oid
       WHERE n.nspname = 'public'
         AND c.relname IN ('security_audit_log', 'siem_delivery_receipts', 'siem_delivery_cursors')
       ORDER BY c.relname`,
    );
    expect(rows).toEqual([
      { relname: 'security_audit_log', relkind: 'p', partstrat: 'r' },
      { relname: 'siem_delivery_cursors', relkind: 'r', partstrat: null },
      { relname: 'siem_delivery_receipts', relkind: 'p', partstrat: 'r' },
    ]);
  });

  it('should seed current + 3 future monthly partitions and a DEFAULT for both parents', async () => {
    for (const parent of PARTITIONED_PARENTS) {
      const partitions = await listPartitions(pool, parent);
      const expected = [
        `${parent}_default`,
        partitionName(parent, 0),
        partitionName(parent, 1),
        partitionName(parent, 2),
        partitionName(parent, 3),
      ].sort();
      expect(partitions).toEqual(expected);
    }
  });

  it('should include the partition key in each primary key (partitioned-PK requirement)', async () => {
    const pk = async (table: string) => {
      const { rows } = await pool.query(
        `SELECT a.attname FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
         WHERE c.relname = $1 AND i.indisprimary
         ORDER BY array_position(i.indkey, a.attnum)`,
        [table],
      );
      return rows.map((r: { attname: string }) => r.attname);
    };
    expect(await pk('security_audit_log')).toEqual(['id', 'timestamp']);
    expect(await pk('siem_delivery_receipts')).toEqual(['receiptId', 'deliveredAt']);
  });

  it('should route audit inserts spanning three months into their monthly partitions', async () => {
    for (const [i, offset] of [0, 1, 2].entries()) {
      await pool.query(
        `INSERT INTO security_audit_log (id, event_type, "timestamp", previous_hash, event_hash)
         VALUES ($1, 'auth.login.success', $2, $3, $4)`,
        [`span-row-${i}`, midMonthUtc(offset), i === 0 ? 'GENESIS' : `hash-${i}`, `hash-${i + 1}`],
      );
    }
    const { rows } = await pool.query(
      `SELECT id, tableoid::regclass::text AS partition FROM security_audit_log
       WHERE id LIKE 'span-row-%' ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: 'span-row-0', partition: partitionName('security_audit_log', 0) },
      { id: 'span-row-1', partition: partitionName('security_audit_log', 1) },
      { id: 'span-row-2', partition: partitionName('security_audit_log', 2) },
    ]);
  });

  it('should land a far-future insert in the DEFAULT partition (safety net)', async () => {
    await pool.query(
      `INSERT INTO security_audit_log (id, event_type, "timestamp", previous_hash, event_hash)
       VALUES ('far-future-row', 'auth.login.success', $1, 'hash-x', 'hash-y')`,
      [midMonthUtc(24)],
    );
    const { rows } = await pool.query(
      `SELECT tableoid::regclass::text AS partition FROM security_audit_log WHERE id = 'far-future-row'`,
    );
    expect(rows[0].partition).toBe('security_audit_log_default');
  });

  it('should route receipts by deliveredAt and keep the (deliveryId, source, deliveredAt) dup guard', async () => {
    const deliveredAt = midMonthUtc(0);
    const insertReceipt = (receiptId: string) =>
      pool.query(
        `INSERT INTO siem_delivery_receipts
           ("receiptId", "deliveryId", "source", "firstEntryId", "lastEntryId",
            "firstEntryTimestamp", "lastEntryTimestamp", "entryCount", "deliveredAt")
         VALUES ($1, 'dlv-1', 'security_audit', 'e-1', 'e-2', $2, $2, 2, $2)`,
        [receiptId, deliveredAt],
      );

    await insertReceipt('rcpt-part-1');
    const { rows } = await pool.query(
      `SELECT tableoid::regclass::text AS partition FROM siem_delivery_receipts WHERE "receiptId" = 'rcpt-part-1'`,
    );
    expect(rows[0].partition).toBe(partitionName('siem_delivery_receipts', 0));

    // Same (deliveryId, source, deliveredAt) under a fresh PK → unique_violation.
    await expect(insertReceipt('rcpt-part-2')).rejects.toMatchObject({ code: '23505' });
  });

  it('should answer the chain-head query with an index scan — no seq scan on any partition', async () => {
    // Give every partition realistic volume — on near-empty partitions the
    // planner legitimately prefers seq scans, which would make this assertion
    // meaningless rather than strict.
    for (const offset of [0, 1, 2, 3, 24]) {
      await pool.query(
        `INSERT INTO security_audit_log (id, event_type, "timestamp", previous_hash, event_hash)
         SELECT 'bulk-' || $2 || '-' || g, 'auth.login.success',
                $1::timestamp + make_interval(mins => g), 'bulk-prev', 'bulk-hash'
         FROM generate_series(1, 300) g`,
        [midMonthUtc(offset), offset],
      );
    }
    await pool.query('ANALYZE security_audit_log');

    const { rows } = await pool.query(
      `EXPLAIN SELECT event_hash, chain_seq FROM security_audit_log ORDER BY chain_seq DESC LIMIT 1`,
    );
    const plan = rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/Index Scan Backward using \S*chain_seq\S*/);
    expect(plan).not.toContain('Seq Scan');
  });

  it('should make admin_ensure_partitions idempotent (rerun creates nothing) and extendable', async () => {
    const first = await pool.query('SELECT admin_ensure_partitions(3) AS created');
    expect(first.rows[0].created).toBe(0); // migration already seeded these

    const before = await listPartitions(pool, 'security_audit_log');
    const rerun = await pool.query('SELECT admin_ensure_partitions(3) AS created');
    expect(rerun.rows[0].created).toBe(0);
    expect(await listPartitions(pool, 'security_audit_log')).toEqual(before);

    // Create-ahead: extending the horizon creates exactly month +4 and +5 per parent.
    const extended = await pool.query('SELECT admin_ensure_partitions(5) AS created');
    expect(extended.rows[0].created).toBe(4);
    expect(await listPartitions(pool, 'security_audit_log')).toContain(
      partitionName('security_audit_log', 5),
    );
  });

  it('should reject a nonsensical horizon instead of looping forever', async () => {
    await expect(pool.query('SELECT admin_ensure_partitions(-1)')).rejects.toMatchObject({
      code: 'P0001',
    });
    await expect(pool.query('SELECT admin_ensure_partitions(1000)')).rejects.toMatchObject({
      code: 'P0001',
    });
  });

  it('should let admin_maintenance execute the function but hold no table access', async () => {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE admin_maintenance');
      const { rows } = await client.query('SELECT admin_ensure_partitions(3) AS created');
      expect(rows[0].created).toBe(0);
      await expect(client.query('SELECT 1 FROM security_audit_log')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('should deny EXECUTE on the function to every other role', async () => {
    for (const role of ROLES.filter((r) => r !== 'admin_maintenance')) {
      const client = await pool.connect();
      try {
        await client.query(`SET ROLE ${role}`);
        await expect(client.query('SELECT admin_ensure_partitions(3)')).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    }
  });
});

describe.skipIf(!url)('upgrade path — partitioning a DB that already holds chain rows', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 3 });
    await resetScratchDb(pool);

    // Replay history: apply ONLY the pre-partitioning migrations (0000 + 0001),
    // then write rows the way the pre-leaf-6 schema did.
    const migrations = readMigrationFiles({ migrationsFolder: ADMIN_MIGRATIONS_FOLDER });
    await runMigrations(drizzle(pool), migrations.slice(0, 2), {
      migrationsSchema: ADMIN_MIGRATIONS_SCHEMA,
      migrationsTable: ADMIN_MIGRATIONS_TABLE,
    });

    for (const [i, offset] of [-2, -1, 0].entries()) {
      await pool.query(
        `INSERT INTO security_audit_log (id, event_type, "timestamp", previous_hash, event_hash)
         VALUES ($1, 'auth.login.success', $2, $3, $4)`,
        [`legacy-row-${i}`, midMonthUtc(offset), i === 0 ? 'GENESIS' : `legacy-hash-${i}`, `legacy-hash-${i + 1}`],
      );
    }
    await pool.query(
      `INSERT INTO siem_delivery_receipts
         ("receiptId", "deliveryId", "source", "firstEntryId", "lastEntryId",
          "firstEntryTimestamp", "lastEntryTimestamp", "entryCount", "deliveredAt")
       VALUES ('legacy-rcpt', 'dlv-legacy', 'security_audit', 'e-1', 'e-2', $1, $1, 2, $1)`,
      [midMonthUtc(-1)],
    );

    // Now the partitioning migration (0002) runs against a table WITH data.
    await migrateAdminDb({ ADMIN_DATABASE_URL: url });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('should preserve every legacy row and route it to its historical monthly partition', async () => {
    const { rows } = await pool.query(
      `SELECT id, tableoid::regclass::text AS partition FROM security_audit_log
       WHERE id LIKE 'legacy-row-%' ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: 'legacy-row-0', partition: partitionName('security_audit_log', -2) },
      { id: 'legacy-row-1', partition: partitionName('security_audit_log', -1) },
      { id: 'legacy-row-2', partition: partitionName('security_audit_log', 0) },
    ]);

    const receipt = await pool.query(
      `SELECT tableoid::regclass::text AS partition FROM siem_delivery_receipts WHERE "receiptId" = 'legacy-rcpt'`,
    );
    expect(receipt.rows[0].partition).toBe(partitionName('siem_delivery_receipts', -1));
  });

  it('should keep chain_seq values and continue the surviving sequence without a gap reset', async () => {
    const legacy = await pool.query(
      `SELECT chain_seq FROM security_audit_log WHERE id LIKE 'legacy-row-%' ORDER BY chain_seq`,
    );
    expect(legacy.rows.map((r: { chain_seq: string }) => Number(r.chain_seq))).toEqual([1, 2, 3]);

    await pool.query(
      `INSERT INTO security_audit_log (id, event_type, previous_hash, event_hash)
       VALUES ('post-upgrade-row', 'auth.login.success', 'legacy-hash-3', 'legacy-hash-4')`,
    );
    const next = await pool.query(
      `SELECT chain_seq FROM security_audit_log WHERE id = 'post-upgrade-row'`,
    );
    expect(Number(next.rows[0].chain_seq)).toBe(4);
  });

  it('should hold the leaf-4 grant matrix on the re-created parents (as amended by the 0008 revoke — admin_app no longer INSERTs the chain)', async () => {
    const { rows } = await pool.query(
      `SELECT has_table_privilege('admin_app', 'security_audit_log', 'INSERT') AS app_ins,
              has_table_privilege('admin_app', 'security_audit_log', 'DELETE') AS app_del,
              has_table_privilege('admin_siem', 'siem_delivery_receipts', 'INSERT') AS siem_ins,
              has_table_privilege('admin_siem', 'siem_delivery_receipts', 'UPDATE') AS siem_upd`,
    );
    expect(rows[0]).toEqual({ app_ins: false, app_del: false, siem_ins: true, siem_upd: false });
  });
});

describe.skipIf(!url)('DEFAULT-partition poisoning containment (0003 hardening)', () => {
  // Reproduces the REVIEW 2026-07-10 MINOR finding: a row for month M sitting
  // in the DEFAULT partition makes CREATE TABLE ... FOR VALUES for month M
  // fail ("updated partition constraint for default partition would be
  // violated"). Pre-0003 that single failure rolled back EVERY month in the
  // call; hardened, month M fails alone, the others are created, and the
  // failure is reported via WARNING.
  let pool: Pool;
  const POISONED_OFFSET = 4; // first month beyond the migration-seeded horizon (0..3)

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 3 });
    await resetScratchDb(pool);
    await migrateAdminDb({ ADMIN_DATABASE_URL: url });

    // Poison: a security_audit_log row for month +4 has no monthly partition
    // yet, so it lands in DEFAULT — exactly what a >horizon cron outage causes.
    await pool.query(
      `INSERT INTO security_audit_log (id, event_type, "timestamp", previous_hash, event_hash)
       VALUES ('poison-row', 'auth.login.success', $1, 'GENESIS', 'poison-hash')`,
      [midMonthUtc(POISONED_OFFSET)],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('should have the poison row sitting in the DEFAULT partition', async () => {
    const { rows } = await pool.query(
      `SELECT tableoid::regclass::text AS partition FROM security_audit_log WHERE id = 'poison-row'`,
    );
    expect(rows[0].partition).toBe('security_audit_log_default');
  });

  it('should create every unpoisoned month, skip ONLY the poisoned one, and WARN with its name', async () => {
    const client = await pool.connect();
    const warnings: string[] = [];
    client.on('notice', (msg) => {
      if (msg.message) warnings.push(msg.message);
    });
    try {
      // Horizon 6: for security_audit_log months +4 (poisoned), +5, +6;
      // for siem_delivery_receipts (unpoisoned) months +4, +5, +6.
      const { rows } = await client.query('SELECT admin_ensure_partitions(6) AS created');
      expect(rows[0].created).toBe(5); // 2 + 3 — everything except the poisoned month
    } finally {
      client.release();
    }

    const auditPartitions = await listPartitions(pool, 'security_audit_log');
    expect(auditPartitions).not.toContain(partitionName('security_audit_log', POISONED_OFFSET));
    expect(auditPartitions).toContain(partitionName('security_audit_log', 5));
    expect(auditPartitions).toContain(partitionName('security_audit_log', 6));

    const receiptPartitions = await listPartitions(pool, 'siem_delivery_receipts');
    for (const offset of [4, 5, 6]) {
      expect(receiptPartitions).toContain(partitionName('siem_delivery_receipts', offset));
    }

    expect(
      warnings.some((w) => w.includes(partitionName('security_audit_log', POISONED_OFFSET))),
    ).toBe(true);
  });

  it('should create the poisoned month after ops repair (move rows out of DEFAULT, rerun)', async () => {
    // The documented repair: move the stranded rows out of DEFAULT, create the
    // month, put them back. Runs as the migrate identity (table owner) — no
    // zero-trust role holds DELETE, by design.
    const { rows: moved } = await pool.query(
      `DELETE FROM security_audit_log WHERE id = 'poison-row'
       RETURNING id, event_type, "timestamp", previous_hash, event_hash`,
    );
    expect(moved).toHaveLength(1);

    const { rows } = await pool.query('SELECT admin_ensure_partitions(6) AS created');
    expect(rows[0].created).toBe(1); // exactly the previously poisoned month

    const row = moved[0];
    await pool.query(
      `INSERT INTO security_audit_log (id, event_type, "timestamp", previous_hash, event_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.id, row.event_type, row.timestamp, row.previous_hash, row.event_hash],
    );
    const { rows: routed } = await pool.query(
      `SELECT tableoid::regclass::text AS partition FROM security_audit_log WHERE id = 'poison-row'`,
    );
    expect(routed[0].partition).toBe(partitionName('security_audit_log', POISONED_OFFSET));

    // Fully healed: a rerun has nothing left to create.
    const rerun = await pool.query('SELECT admin_ensure_partitions(6) AS created');
    expect(rerun.rows[0].created).toBe(0);
  });
});
