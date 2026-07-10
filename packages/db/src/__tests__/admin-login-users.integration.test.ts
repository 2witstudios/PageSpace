/**
 * LOGIN-user grant-denial tests for the Admin PG (#890 Phase 2, leaf 0 — gate).
 *
 * The Phase 1 grants suite proved the NOLOGIN role TEMPLATES; this suite
 * proves the actual per-service LOGIN users that db:provision:admin-users
 * creates — connecting AS each user over the wire (not SET ROLE), so the
 * probes exercise the same identity path a deployed service uses.
 *
 * Acceptance (leaf 0): admin_app_user can INSERT+SELECT security_audit_log
 * and is DENIED UPDATE/DELETE with a real 42501; processor/reader users get
 * exactly their templates' privileges; re-provisioning rotates passwords.
 *
 * Requires a running scratch Postgres (never the app DB):
 *   docker run --rm -d --name pagespace-admin-smoke -p 55432:5432 \
 *     -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=pagespace_admin postgres:16
 *   ADMIN_DATABASE_URL=postgresql://admin:admin@localhost:55432/pagespace_admin \
 *     bunx vitest run --config vitest.integration.config.ts src/__tests__/admin-login-users.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { migrateAdminDb } from '../migrate-admin';
import { provisionAdminLoginUsers } from '../provision-admin-users';
import { ADMIN_LOGIN_USERS } from '../admin-login-users';

const url = process.env.ADMIN_DATABASE_URL;

const PASSWORDS = {
  ADMIN_APP_PASSWORD: 'app-secret-integration-1',
  ADMIN_PROCESSOR_PASSWORD: 'processor-secret-integration-1',
  ADMIN_READER_PASSWORD: 'reader-secret-integration-1',
  ADMIN_ERASER_PASSWORD: 'eraser-secret-integration-1',
} as const;

const TEMPLATE_ROLES = [
  'admin_app',
  'admin_chainer',
  'admin_gdpr_eraser',
  'admin_reader',
  'admin_siem',
  'admin_maintenance',
] as const;

/** Connection config for a login user against the same scratch server/db. */
function loginConfig(user: string, password: string) {
  const parsed = new URL(url as string);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    database: parsed.pathname.slice(1),
    user,
    password,
    max: 2,
  };
}

/** Run fn on a pool connected AS the given login user, always cleaning up. */
async function asLoginUser<T>(
  user: string,
  password: string,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = new Pool(loginConfig(user, password));
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

describe.skipIf(!url)('per-service Admin PG LOGIN users (db:provision:admin-users)', () => {
  let owner: Pool;

  beforeAll(async () => {
    owner = new Pool({ connectionString: url, max: 3 });
    // Fresh-DB guarantee on the SCRATCH db (same reset as the grants suite),
    // including the LOGIN users so provisioning is genuinely exercised.
    await owner.query('DROP SCHEMA IF EXISTS public CASCADE');
    await owner.query('DROP SCHEMA IF EXISTS drizzle_admin CASCADE');
    await owner.query('CREATE SCHEMA public');
    for (const role of [...TEMPLATE_ROLES, ...ADMIN_LOGIN_USERS.map((u) => u.user)]) {
      await owner.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
            DROP OWNED BY ${role};
            DROP ROLE ${role};
          END IF;
        END $$;
      `);
    }

    await migrateAdminDb({ ADMIN_DATABASE_URL: url });
    const result = await provisionAdminLoginUsers({ ADMIN_DATABASE_URL: url, ...PASSWORDS });
    expect(result.provisioned).toEqual([
      'admin_app_user',
      'admin_processor_user',
      'admin_reader_user',
      'admin_gdpr_eraser_user',
    ]);

    // Seed one chain row as owner for UPDATE/DELETE-denial probes.
    await owner.query(
      `INSERT INTO security_audit_log (id, event_type, user_id, ip_address, previous_hash, event_hash)
       VALUES ('seed-row-1', 'auth.login', 'user-1', '203.0.113.7', 'GENESIS', 'hash-1')`,
    );
  });

  afterAll(async () => {
    await owner.end();
  });

  it('should create the four login users as LOGIN with least-privilege attributes', async () => {
    const { rows } = await owner.query(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit
       FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [ADMIN_LOGIN_USERS.map((u) => u.user)],
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.rolcanlogin).toBe(true);
      expect(row.rolsuper).toBe(false);
      expect(row.rolcreatedb).toBe(false);
      expect(row.rolcreaterole).toBe(false);
      expect(row.rolreplication).toBe(false);
      expect(row.rolbypassrls).toBe(false);
      expect(row.rolinherit).toBe(true);
    }
  });

  it('should attach each login user to exactly its template roles', async () => {
    const { rows } = await owner.query(`
      SELECT member.rolname AS member, granted.rolname AS granted
      FROM pg_auth_members m
      JOIN pg_roles member ON member.oid = m.member
      JOIN pg_roles granted ON granted.oid = m.roleid
      WHERE member.rolname LIKE 'admin_%_user'
      ORDER BY member.rolname, granted.rolname
    `);
    const memberships = rows.map((r: { member: string; granted: string }) => `${r.member}→${r.granted}`);
    expect(memberships).toEqual([
      'admin_app_user→admin_app',
      'admin_gdpr_eraser_user→admin_gdpr_eraser',
      'admin_processor_user→admin_chainer',
      'admin_processor_user→admin_siem',
      'admin_reader_user→admin_reader',
    ]);
  });

  describe('admin_app_user (web identity, connected over the wire)', () => {
    it('should be DENIED INSERT on security_audit_log + the chain_seq sequence (0008 — post-cutover the app writes ONLY the ingest queue) yet still SELECT the chain head', async () => {
      await asLoginUser('admin_app_user', PASSWORDS.ADMIN_APP_PASSWORD, async (pool) => {
        await expect(
          pool.query(
            `INSERT INTO security_audit_log (id, event_type, previous_hash, event_hash)
             VALUES ('login-app-row-1', 'auth.login', 'hash-1', 'hash-app-1')`,
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          pool.query(`SELECT nextval('security_audit_log_chain_seq_seq')`),
        ).rejects.toMatchObject({ code: '42501' });

        const head = await pool.query(
          'SELECT event_hash FROM security_audit_log ORDER BY chain_seq DESC LIMIT 1',
        );
        expect(head.rows[0].event_hash).toBe('hash-1');
      });
    });

    it('should still INSERT into security_audit_ingest (the one write the app keeps)', async () => {
      await asLoginUser('admin_app_user', PASSWORDS.ADMIN_APP_PASSWORD, async (pool) => {
        const { rowCount } = await pool.query(
          `INSERT INTO security_audit_ingest (id, event_type, emission_hash)
           VALUES ('login-app-ingest-1', 'auth.login', 'em-login-app-1')`,
        );
        expect(rowCount).toBe(1);
      });
    });

    it('should be DENIED UPDATE and DELETE on security_audit_log (42501)', async () => {
      await asLoginUser('admin_app_user', PASSWORDS.ADMIN_APP_PASSWORD, async (pool) => {
        await expect(
          pool.query(`UPDATE security_audit_log SET event_hash = 'tampered' WHERE id = 'seed-row-1'`),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          pool.query(`DELETE FROM security_audit_log WHERE id = 'seed-row-1'`),
        ).rejects.toMatchObject({ code: '42501' });
      });
    });

    it('should be DENIED TRUNCATE and any SIEM-table write (42501)', async () => {
      await asLoginUser('admin_app_user', PASSWORDS.ADMIN_APP_PASSWORD, async (pool) => {
        await expect(pool.query('TRUNCATE security_audit_log')).rejects.toMatchObject({
          code: '42501',
        });
        await expect(
          pool.query(`INSERT INTO siem_delivery_cursors (id) VALUES ('c-app')`),
        ).rejects.toMatchObject({ code: '42501' });
      });
    });
  });

  describe('admin_processor_user (chainer + SIEM identity)', () => {
    it('should SELECT+INSERT security_audit_log (chainer) and be DENIED UPDATE/DELETE', async () => {
      await asLoginUser('admin_processor_user', PASSWORDS.ADMIN_PROCESSOR_PASSWORD, async (pool) => {
        const { rowCount } = await pool.query(
          `INSERT INTO security_audit_log (id, event_type, previous_hash, event_hash)
           VALUES ('login-proc-row-1', 'auth.login', 'hash-1', 'hash-proc-1')`,
        );
        expect(rowCount).toBe(1);
        await expect(
          pool.query(`UPDATE security_audit_log SET event_hash = 'x' WHERE id = 'seed-row-1'`),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          pool.query(`DELETE FROM security_audit_log WHERE id = 'seed-row-1'`),
        ).rejects.toMatchObject({ code: '42501' });
      });
    });

    it('should upsert siem_delivery_cursors and INSERT (write-once) siem_delivery_receipts', async () => {
      await asLoginUser('admin_processor_user', PASSWORDS.ADMIN_PROCESSOR_PASSWORD, async (pool) => {
        await pool.query(
          `INSERT INTO siem_delivery_cursors (id, "deliveryCount") VALUES ('c-proc', 1)
           ON CONFLICT (id) DO UPDATE SET "deliveryCount" = siem_delivery_cursors."deliveryCount" + 1`,
        );
        const receipts = await pool.query(
          `INSERT INTO siem_delivery_receipts
             ("receiptId", "deliveryId", source, "firstEntryId", "lastEntryId",
              "firstEntryTimestamp", "lastEntryTimestamp", "entryCount", "deliveredAt")
           VALUES ('r-proc', 'd-1', 'security_audit_log', 'seed-row-1', 'seed-row-1',
                   now(), now(), 1, now())
           RETURNING "receiptId"`,
        );
        expect(receipts.rowCount).toBe(1);
        await expect(
          pool.query(`DELETE FROM siem_delivery_cursors WHERE id = 'c-proc'`),
        ).rejects.toMatchObject({ code: '42501' });
      });
    });
  });

  describe('admin_reader_user (admin app identity)', () => {
    it('should SELECT all three trust-plane tables', async () => {
      await asLoginUser('admin_reader_user', PASSWORDS.ADMIN_READER_PASSWORD, async (pool) => {
        for (const table of ['security_audit_log', 'siem_delivery_cursors', 'siem_delivery_receipts']) {
          const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
          expect(rows[0].n).toBeGreaterThanOrEqual(0);
        }
      });
    });

    it('should be DENIED INSERT/UPDATE/DELETE everywhere (42501)', async () => {
      await asLoginUser('admin_reader_user', PASSWORDS.ADMIN_READER_PASSWORD, async (pool) => {
        await expect(
          pool.query(
            `INSERT INTO security_audit_log (id, event_type, previous_hash, event_hash)
             VALUES ('login-reader-row', 'auth.login', 'x', 'y')`,
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          pool.query(`UPDATE siem_delivery_cursors SET "deliveryCount" = 99 WHERE id = 'c-proc'`),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          pool.query(`DELETE FROM security_audit_log WHERE id = 'seed-row-1'`),
        ).rejects.toMatchObject({ code: '42501' });
      });
    });
  });

  describe('admin_gdpr_eraser_user (Art 17 erasure identity, connected over the wire)', () => {
    it('should UPDATE exactly the 6 PII columns and leave chain columns untouched', async () => {
      await asLoginUser('admin_gdpr_eraser_user', PASSWORDS.ADMIN_ERASER_PASSWORD, async (pool) => {
        const { rowCount } = await pool.query(
          `UPDATE security_audit_log
           SET user_id = NULL, session_id = NULL, ip_address = NULL,
               ip_bidx = NULL, user_agent = NULL, geo_location = NULL
           WHERE id = 'seed-row-1'`,
        );
        expect(rowCount).toBe(1);
      });
      const { rows } = await owner.query(
        `SELECT ip_address, event_hash, previous_hash FROM security_audit_log WHERE id = 'seed-row-1'`,
      );
      expect(rows[0]).toEqual({ ip_address: null, event_hash: 'hash-1', previous_hash: 'GENESIS' });
    });

    it.each(['event_hash', 'previous_hash', 'event_type', 'details'])(
      'should be DENIED UPDATE on hash/content column %s (42501)',
      async (column) => {
        const literal = column === 'details' ? `'{}'::jsonb` : `'tampered'`;
        await asLoginUser('admin_gdpr_eraser_user', PASSWORDS.ADMIN_ERASER_PASSWORD, async (pool) => {
          await expect(
            pool.query(`UPDATE security_audit_log SET ${column} = ${literal} WHERE id = 'seed-row-1'`),
          ).rejects.toMatchObject({ code: '42501' });
        });
      },
    );

    it('should be DENIED INSERT, DELETE and TRUNCATE on security_audit_log (42501)', async () => {
      await asLoginUser('admin_gdpr_eraser_user', PASSWORDS.ADMIN_ERASER_PASSWORD, async (pool) => {
        await expect(
          pool.query(
            `INSERT INTO security_audit_log (id, event_type, previous_hash, event_hash)
             VALUES ('login-eraser-row', 'auth.login', 'x', 'y')`,
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          pool.query(`DELETE FROM security_audit_log WHERE id = 'seed-row-1'`),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(pool.query('TRUNCATE security_audit_log')).rejects.toMatchObject({
          code: '42501',
        });
      });
    });

    it('should hold NOTHING on the ingest queue or SIEM tables (42501)', async () => {
      await asLoginUser('admin_gdpr_eraser_user', PASSWORDS.ADMIN_ERASER_PASSWORD, async (pool) => {
        await expect(pool.query('SELECT 1 FROM security_audit_ingest')).rejects.toMatchObject({
          code: '42501',
        });
        await expect(
          pool.query(`INSERT INTO siem_delivery_cursors (id) VALUES ('c-eraser')`),
        ).rejects.toMatchObject({ code: '42501' });
      });
    });
  });

  describe('idempotency + rotation', () => {
    it('given a re-run with a changed password, should rotate it (old fails auth, new connects)', async () => {
      const rotated = 'app-secret-integration-ROTATED';
      const result = await provisionAdminLoginUsers({
        ADMIN_DATABASE_URL: url,
        ...PASSWORDS,
        ADMIN_APP_PASSWORD: rotated,
      });
      expect(result.provisioned).toContain('admin_app_user');

      await expect(
        asLoginUser('admin_app_user', PASSWORDS.ADMIN_APP_PASSWORD, (pool) => pool.query('SELECT 1')),
      ).rejects.toMatchObject({ code: '28P01' }); // invalid_password

      await asLoginUser('admin_app_user', rotated, async (pool) => {
        const { rows } = await pool.query('SELECT 1 AS ok');
        expect(rows[0].ok).toBe(1);
      });

      // Restore for any later probes.
      await provisionAdminLoginUsers({ ADMIN_DATABASE_URL: url, ...PASSWORDS });
    });

    it('given a partial env, should provision only the present users and report the skipped ones', async () => {
      const result = await provisionAdminLoginUsers({
        ADMIN_DATABASE_URL: url,
        ADMIN_APP_PASSWORD: PASSWORDS.ADMIN_APP_PASSWORD,
      });
      expect(result.provisioned).toEqual(['admin_app_user']);
      expect(result.skipped).toEqual([
        'admin_processor_user',
        'admin_reader_user',
        'admin_gdpr_eraser_user',
      ]);
    });

    it('given ADMIN_DATABASE_URL_MIGRATE, should provision through it (owner path preference)', async () => {
      const result = await provisionAdminLoginUsers({
        ADMIN_DATABASE_URL: 'postgresql://admin_app_user:wrong@nowhere:1/never-used',
        ADMIN_DATABASE_URL_MIGRATE: url,
        ADMIN_READER_PASSWORD: PASSWORDS.ADMIN_READER_PASSWORD,
      });
      expect(result.provisioned).toEqual(['admin_reader_user']);
    });
  });
});
