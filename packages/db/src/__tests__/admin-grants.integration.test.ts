/**
 * Zero-trust role grant-denial tests for the Admin PG (#890 Phase 1, leaf 4).
 *
 * Acceptance: the five NOLOGIN role templates exist after `db:migrate:admin`,
 * every allowed operation succeeds, every denied operation fails with a REAL
 * Postgres permission error (42501) — and DELETE/TRUNCATE are granted to
 * NOBODY on any trust-plane table.
 *
 * Requires a running scratch Postgres (never the app DB):
 *   docker run --rm -d --name pagespace-admin-smoke -p 55432:5432 \
 *     -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=pagespace_admin postgres:16
 *   ADMIN_DATABASE_URL=postgresql://admin:admin@localhost:55432/pagespace_admin \
 *     bunx vitest run --config vitest.integration.config.ts src/__tests__/admin-grants.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { migrateAdminDb } from '../migrate-admin';

const url = process.env.ADMIN_DATABASE_URL;

const ROLES = [
  'admin_app',
  'admin_chainer',
  'admin_gdpr_eraser',
  'admin_reader',
  'admin_siem',
  // Leaf 6: partition create-ahead maintenance — EXECUTE on
  // admin_ensure_partitions and nothing else.
  'admin_maintenance',
] as const;

const TABLES = [
  'security_audit_log',
  'siem_delivery_cursors',
  'siem_delivery_receipts',
] as const;

const PII_COLUMNS = [
  'user_id',
  'session_id',
  'ip_address',
  'ip_bidx',
  'user_agent',
  'geo_location',
] as const;

const CHAIN_COLUMNS = ['event_hash', 'previous_hash', 'chain_seq', 'event_type', 'details'] as const;

describe.skipIf(!url)('zero-trust roles on the Admin PG', () => {
  let pool: Pool;

  /** Run fn on a connection assumed into `role`, always resetting after. */
  async function asRole<T>(role: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      return await fn(client);
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  }

  /** Assert sql fails with insufficient_privilege (42501) — a real DB-level denial. */
  async function expectDenied(client: PoolClient, sql: string, params?: unknown[]): Promise<void> {
    await expect(client.query(sql, params)).rejects.toMatchObject({ code: '42501' });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 3 });
    // Fresh-DB guarantee on the SCRATCH db: drop schemas AND the cluster-level
    // roles so the migration's role creation is genuinely exercised.
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

    await migrateAdminDb({ ADMIN_DATABASE_URL: url });

    // Seed one chain row as superuser for UPDATE/DELETE-denial probes.
    await pool.query(
      `INSERT INTO security_audit_log (id, event_type, user_id, ip_address, previous_hash, event_hash)
       VALUES ('seed-row-1', 'auth.login', 'user-1', '203.0.113.7', 'GENESIS', 'hash-1')`,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('should create all six role templates as NOLOGIN', async () => {
    const { rows } = await pool.query(
      `SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [[...ROLES]],
    );
    expect(rows.map((r: { rolname: string }) => r.rolname)).toEqual([...ROLES].sort());
    expect(rows.every((r: { rolcanlogin: boolean }) => r.rolcanlogin === false)).toBe(true);
  });

  describe('admin_app (web identity)', () => {
    it('should INSERT into security_audit_log (incl. chain_seq sequence default)', async () => {
      await asRole('admin_app', async (client) => {
        const { rowCount } = await client.query(
          `INSERT INTO security_audit_log (id, event_type, previous_hash, event_hash)
           VALUES ('app-row-1', 'auth.login', 'hash-1', 'hash-2')`,
        );
        expect(rowCount).toBe(1);
      });
    });

    it('should SELECT the chain head (Phase 2 pre-chainer cutover)', async () => {
      await asRole('admin_app', async (client) => {
        const { rows } = await client.query(
          `SELECT event_hash FROM security_audit_log ORDER BY chain_seq DESC LIMIT 1`,
        );
        expect(rows).toHaveLength(1);
      });
    });

    it('should be DENIED UPDATE on security_audit_log', async () => {
      await asRole('admin_app', (client) =>
        expectDenied(client, `UPDATE security_audit_log SET event_type = 'tampered' WHERE id = 'seed-row-1'`),
      );
    });

    it('should be DENIED any access to the SIEM tables', async () => {
      await asRole('admin_app', async (client) => {
        await expectDenied(client, `SELECT 1 FROM siem_delivery_cursors`);
        await expectDenied(client, `SELECT 1 FROM siem_delivery_receipts`);
      });
    });
  });

  describe('admin_chainer (processor chain writer, staged for Phase 2)', () => {
    it('should SELECT and INSERT on security_audit_log', async () => {
      await asRole('admin_chainer', async (client) => {
        const head = await client.query(
          `SELECT event_hash FROM security_audit_log ORDER BY chain_seq DESC LIMIT 1`,
        );
        expect(head.rows).toHaveLength(1);
        const { rowCount } = await client.query(
          `INSERT INTO security_audit_log (id, event_type, previous_hash, event_hash)
           VALUES ('chainer-row-1', 'auth.login', 'hash-2', 'hash-3')`,
        );
        expect(rowCount).toBe(1);
      });
    });

    it('should be DENIED UPDATE on security_audit_log (chain history is immutable)', async () => {
      await asRole('admin_chainer', (client) =>
        expectDenied(client, `UPDATE security_audit_log SET previous_hash = 'rewritten' WHERE id = 'seed-row-1'`),
      );
    });
  });

  describe('admin_gdpr_eraser (Art 17, PII columns only)', () => {
    it('should UPDATE exactly the PII columns', async () => {
      await asRole('admin_gdpr_eraser', async (client) => {
        const { rowCount } = await client.query(
          `UPDATE security_audit_log
           SET user_id = NULL, session_id = NULL, ip_address = NULL,
               ip_bidx = NULL, user_agent = NULL, geo_location = NULL
           WHERE id = 'seed-row-1'`,
        );
        expect(rowCount).toBe(1);
      });
      // Erasure must not have touched the chain columns.
      const { rows } = await pool.query(
        `SELECT event_hash, previous_hash FROM security_audit_log WHERE id = 'seed-row-1'`,
      );
      expect(rows[0]).toEqual({ event_hash: 'hash-1', previous_hash: 'GENESIS' });
    });

    it.each([...CHAIN_COLUMNS])('should be DENIED UPDATE on chain/content column %s', async (column) => {
      const literal = column === 'chain_seq' ? '999999' : column === 'details' ? `'{}'::jsonb` : `'tampered'`;
      await asRole('admin_gdpr_eraser', (client) =>
        expectDenied(client, `UPDATE security_audit_log SET ${column} = ${literal} WHERE id = 'seed-row-1'`),
      );
    });

    it('should be DENIED INSERT on security_audit_log', async () => {
      await asRole('admin_gdpr_eraser', (client) =>
        expectDenied(
          client,
          `INSERT INTO security_audit_log (id, event_type, previous_hash, event_hash)
           VALUES ('eraser-row-1', 'auth.login', 'x', 'y')`,
        ),
      );
    });
  });

  describe('admin_reader (admin app / verification)', () => {
    it('should SELECT on all three tables and nothing more', async () => {
      await asRole('admin_reader', async (client) => {
        for (const table of TABLES) {
          await client.query(`SELECT 1 FROM ${table} LIMIT 1`);
        }
        await expectDenied(
          client,
          `INSERT INTO security_audit_log (id, event_type, previous_hash, event_hash)
           VALUES ('reader-row-1', 'auth.login', 'x', 'y')`,
        );
        await expectDenied(client, `UPDATE security_audit_log SET user_id = NULL WHERE id = 'seed-row-1'`);
      });
    });
  });

  describe('admin_siem (processor SIEM delivery)', () => {
    it('should upsert siem_delivery_cursors (worker uses INSERT … ON CONFLICT DO UPDATE)', async () => {
      await asRole('admin_siem', async (client) => {
        for (let i = 0; i < 2; i++) {
          await client.query(
            `INSERT INTO siem_delivery_cursors (id, "lastDeliveredId", "lastDeliveredAt", "deliveryCount", "updatedAt")
             VALUES ('security_audit', 'seed-row-1', NOW(), 1, NOW())
             ON CONFLICT (id) DO UPDATE SET
               "lastDeliveredId" = EXCLUDED."lastDeliveredId",
               "deliveryCount" = siem_delivery_cursors."deliveryCount" + 1,
               "updatedAt" = NOW()`,
          );
        }
        const { rows } = await client.query(
          `SELECT "deliveryCount" FROM siem_delivery_cursors WHERE id = 'security_audit'`,
        );
        expect(rows[0].deliveryCount).toBe(2);
      });
    });

    it('should INSERT receipts but be DENIED UPDATE on them (receipts are write-once)', async () => {
      await asRole('admin_siem', async (client) => {
        const { rowCount } = await client.query(
          `INSERT INTO siem_delivery_receipts
             ("receiptId", "deliveryId", "source", "firstEntryId", "lastEntryId",
              "firstEntryTimestamp", "lastEntryTimestamp", "entryCount", "deliveredAt")
           VALUES ('rcpt-1', 'dlv-1', 'security_audit', 'seed-row-1', 'seed-row-1', NOW(), NOW(), 1, NOW())`,
        );
        expect(rowCount).toBe(1);
        await expectDenied(client, `UPDATE siem_delivery_receipts SET "entryCount" = 0 WHERE "receiptId" = 'rcpt-1'`);
      });
    });

    it('should SELECT security_audit_log but never write it', async () => {
      await asRole('admin_siem', async (client) => {
        await client.query(`SELECT id FROM security_audit_log LIMIT 1`);
        await expectDenied(
          client,
          `INSERT INTO security_audit_log (id, event_type, previous_hash, event_hash)
           VALUES ('siem-row-1', 'auth.login', 'x', 'y')`,
        );
        await expectDenied(client, `UPDATE security_audit_log SET user_id = NULL WHERE id = 'seed-row-1'`);
      });
    });
  });

  describe('append-only invariant — DELETE/TRUNCATE granted to NOBODY', () => {
    it.each([...ROLES])('grant catalog: %s holds no DELETE or TRUNCATE on any trust-plane table', async (role) => {
      for (const table of TABLES) {
        const { rows } = await pool.query(
          `SELECT has_table_privilege($1, $2, 'DELETE') AS del,
                  has_table_privilege($1, $2, 'TRUNCATE') AS trunc`,
          [role, table],
        );
        expect({ role, table, ...rows[0] }).toEqual({ role, table, del: false, trunc: false });
      }
    });

    it.each([...ROLES])('live denial: %s cannot DELETE or TRUNCATE security_audit_log', async (role) => {
      await asRole(role, async (client) => {
        await expectDenied(client, `DELETE FROM security_audit_log WHERE id = 'seed-row-1'`);
        await expectDenied(client, `TRUNCATE security_audit_log`);
      });
    });

    it.each([...ROLES])(
      'partition immutability: %s cannot DROP a chain-table partition (incl. the DEFAULT safety net)',
      async (role) => {
        // Partitions are owned by the migration identity; no template role —
        // not even admin_maintenance, which CREATES partitions via the
        // SECURITY DEFINER function — may drop one. There is no drop path.
        await asRole(role, async (client) => {
          await expectDenied(client, `DROP TABLE security_audit_log_default`);
          await expectDenied(client, `DROP TABLE siem_delivery_receipts_default`);
        });
      },
    );

    it('PUBLIC holds no privilege at all on trust-plane tables', async () => {
      for (const table of TABLES) {
        const { rows } = await pool.query(
          `SELECT bool_or(has_table_privilege('public', $1::regclass::oid, priv)) AS any_priv
           FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS priv`,
          [table],
        );
        expect({ table, any_priv: rows[0].any_priv }).toEqual({ table, any_priv: false });
      }
    });
  });

  describe('re-runnability', () => {
    it('should apply cleanly on a fresh DB where the roles ALREADY exist at cluster level', async () => {
      // Roles are cluster-scoped: a re-provisioned database in the same
      // cluster re-runs the migration while the roles survive. Simulate that.
      await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
      await pool.query('DROP SCHEMA IF EXISTS drizzle_admin CASCADE');
      await pool.query('CREATE SCHEMA public');

      await migrateAdminDb({ ADMIN_DATABASE_URL: url });

      // Grants are back on the fresh tables.
      const { rows } = await pool.query(
        `SELECT has_table_privilege('admin_app', 'security_audit_log', 'INSERT') AS ins,
                has_table_privilege('admin_app', 'security_audit_log', 'DELETE') AS del`,
      );
      expect(rows[0]).toEqual({ ins: true, del: false });
    });
  });
});
