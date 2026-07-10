/**
 * Full drain-cycle integration for the audit chainer (#890 Phase 2, leaf 2).
 *
 * Runs the REAL worker (processAuditChainer, no mocks) connected AS the
 * processor's provisioned LOGIN user (admin_processor_user → admin_chainer +
 * admin_siem templates), proving least-privilege sufficiency of the grant
 * matrix end to end: emission rows enter as admin_app_user (INSERT-only),
 * the chainer drains (SELECT+DELETE on the queue — the only trust-plane
 * DELETE), appends (INSERT + chain_seq sequence USAGE), and verify-on-append
 * re-reads (SELECT) — all over the wire, no SET ROLE, no owner shortcuts.
 *
 * Requires a running scratch Postgres (never the app DB):
 *   docker run --rm -d --name pagespace-admin-smoke -p 55432:5432 \
 *     -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=pagespace_admin postgres:16
 *   ADMIN_DATABASE_URL=postgresql://admin:admin@localhost:55432/pagespace_admin \
 *     bunx vitest run src/workers/__tests__/audit-chainer-worker.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { migrateAdminDb } from '@pagespace/db/migrate-admin';
import { provisionAdminLoginUsers } from '@pagespace/db/provision-admin-users';
import { computeEmissionHash } from '@pagespace/lib/audit/emission-hash';
import {
  computeChainHash,
  GENESIS_PREVIOUS_HASH,
} from '@pagespace/lib/audit/chain-step';
import type { AuditEvent } from '@pagespace/lib/audit/security-audit';
import { processAuditChainer } from '../audit-chainer-worker';

// Minimal pg surface (this workspace ships no @types/pg — see ../../db.ts).
interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}
interface PgPool {
  connect(): Promise<PgClient>;
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}
// @ts-expect-error -- pg has no bundled types; runtime cast below handles type safety
import pg from 'pg';
const { Pool } = pg as unknown as {
  Pool: new (config: Record<string, unknown>) => PgPool;
};

const url = process.env.ADMIN_DATABASE_URL;

const PASSWORDS = {
  ADMIN_APP_PASSWORD: 'appsecretchainer1',
  ADMIN_PROCESSOR_PASSWORD: 'procsecretchainer1',
} as const;

const ALL_ROLES = [
  'admin_app',
  'admin_chainer',
  'admin_gdpr_eraser',
  'admin_reader',
  'admin_siem',
  'admin_maintenance',
  'admin_app_user',
  'admin_processor_user',
  'admin_reader_user',
] as const;

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

/** Seed one emission-shaped ingest row AS admin_app_user (the real write identity). */
async function seedIngestRows(
  appPool: PgPool,
  rows: Array<{ id: string; event: AuditEvent; timestamp: Date; emittedAt: Date }>,
): Promise<void> {
  for (const { id, event, timestamp, emittedAt } of rows) {
    await appPool.query(
      `INSERT INTO security_audit_ingest
         (id, event_type, user_id, session_id, service_id, resource_type, resource_id,
          ip_address, ip_bidx, user_agent, geo_location, details, risk_score,
          anomaly_flags, timestamp, emission_hash, emitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17)`,
      [
        id,
        event.eventType,
        event.userId ?? null,
        event.sessionId ?? null,
        event.serviceId ?? null,
        event.resourceType ?? null,
        event.resourceId ?? null,
        event.ipAddress ?? null,
        null,
        event.userAgent ?? null,
        event.geoLocation ?? null,
        event.details ? JSON.stringify(event.details) : null,
        event.riskScore ?? null,
        event.anomalyFlags ?? null,
        timestamp,
        computeEmissionHash(event, timestamp),
        emittedAt,
      ],
    );
  }
}

describe.skipIf(!url)('audit chainer drain cycle as admin_processor_user (wire-connected)', () => {
  let owner: PgPool;
  let appPool: PgPool;
  let procPool: PgPool;

  beforeAll(async () => {
    owner = new Pool({ connectionString: url, max: 3 });
    // Fresh-DB guarantee on the SCRATCH db — same reset as the db package's
    // admin integration suites, including LOGIN users so provisioning runs.
    await owner.query('DROP SCHEMA IF EXISTS public CASCADE');
    await owner.query('DROP SCHEMA IF EXISTS drizzle_admin CASCADE');
    await owner.query('CREATE SCHEMA public');
    for (const role of ALL_ROLES) {
      await owner.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
            DROP OWNED BY ${role};
            DROP ROLE ${role};
          END IF;
        END $$;
      `);
    }

    // migrateAdminDb resolves its migrations folder relative to CWD
    // (packages/db convention) — hop there for the migration call only.
    const previousCwd = process.cwd();
    process.chdir(path.resolve(__dirname, '../../../../../packages/db'));
    try {
      await migrateAdminDb({ ADMIN_DATABASE_URL: url });
    } finally {
      process.chdir(previousCwd);
    }

    const result = await provisionAdminLoginUsers({ ADMIN_DATABASE_URL: url, ...PASSWORDS });
    expect(result.provisioned).toEqual(['admin_app_user', 'admin_processor_user']);

    appPool = new Pool(loginConfig('admin_app_user', PASSWORDS.ADMIN_APP_PASSWORD));
    procPool = new Pool(loginConfig('admin_processor_user', PASSWORDS.ADMIN_PROCESSOR_PASSWORD));
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), appPool?.end(), procPool?.end()]);
  });

  const t = (i: number) => new Date(Date.UTC(2026, 1, 1, 0, 0, i));

  it('given seeded emission rows, should chain from genesis, empty the queue, and verify on append', async () => {
    await seedIngestRows(
      appPool,
      Array.from({ length: 5 }, (_, i) => ({
        id: `drain-a-${i}`,
        event: {
          eventType: 'auth.login.success',
          userId: `user-${i}`,
          serviceId: 'web',
          details: { probe: 'chainer-integration', i },
        } as AuditEvent,
        timestamp: t(i),
        emittedAt: t(i),
      })),
    );

    const result = await processAuditChainer({ pool: procPool });

    expect(result.outcome).toBe('chained');
    expect(result.drained).toBe(5);
    expect(result.verification).toEqual({ valid: true, verified: 5 });

    const chained = await owner.query(
      `SELECT id, previous_hash, event_hash, emission_hash, chain_seq
       FROM security_audit_log ORDER BY chain_seq ASC`,
    );
    expect(chained.rows).toHaveLength(5);
    expect(chained.rows.map((r) => r.id)).toEqual([0, 1, 2, 3, 4].map((i) => `drain-a-${i}`));
    expect(chained.rows[0].previous_hash).toBe(GENESIS_PREVIOUS_HASH);
    for (let i = 0; i < chained.rows.length; i++) {
      const row = chained.rows[i];
      if (i > 0) {
        expect(row.previous_hash).toBe(chained.rows[i - 1].event_hash);
      }
      // Recompute from STORAGE — the chain must be verifiable without any
      // in-memory state from the run that wrote it.
      expect(row.event_hash).toBe(
        computeChainHash(row.emission_hash as string, row.previous_hash as string),
      );
    }
    expect(result.newHead).toBe(chained.rows[4].event_hash);

    const remaining = await owner.query('SELECT count(*)::int AS n FROM security_audit_ingest');
    expect(remaining.rows[0].n).toBe(0);
  });

  it('given an empty queue, a rerun should be idle and leave the head untouched', async () => {
    const headBefore = await owner.query(
      'SELECT event_hash FROM security_audit_log ORDER BY chain_seq DESC LIMIT 1',
    );

    const result = await processAuditChainer({ pool: procPool });

    expect(result).toEqual({ outcome: 'idle', drained: 0 });
    const headAfter = await owner.query(
      'SELECT event_hash FROM security_audit_log ORDER BY chain_seq DESC LIMIT 1',
    );
    expect(headAfter.rows[0].event_hash).toBe(headBefore.rows[0].event_hash);
  });

  it('given later rows drained across TWO batches (batchSize=1), should link every batch to the live head', async () => {
    const headBefore = (
      await owner.query('SELECT event_hash FROM security_audit_log ORDER BY chain_seq DESC LIMIT 1')
    ).rows[0].event_hash as string;

    await seedIngestRows(
      appPool,
      [10, 11].map((i) => ({
        id: `drain-b-${i}`,
        event: { eventType: 'data.read', userId: 'user-b', resourceType: 'page', resourceId: `p-${i}` } as AuditEvent,
        timestamp: t(i),
        emittedAt: t(i),
      })),
    );

    const first = await processAuditChainer({ pool: procPool, batchSize: 1 });
    const second = await processAuditChainer({ pool: procPool, batchSize: 1 });
    expect(first).toMatchObject({ outcome: 'chained', drained: 1 });
    expect(second).toMatchObject({ outcome: 'chained', drained: 1 });
    expect(first.verification?.valid).toBe(true);
    expect(second.verification?.valid).toBe(true);

    const tail = await owner.query(
      `SELECT id, previous_hash, event_hash FROM security_audit_log ORDER BY chain_seq DESC LIMIT 2`,
    );
    // Newest first: drain-b-11 links to drain-b-10, which links to the old head.
    expect(tail.rows[0].id).toBe('drain-b-11');
    expect(tail.rows[0].previous_hash).toBe(tail.rows[1].event_hash);
    expect(tail.rows[1].id).toBe('drain-b-10');
    expect(tail.rows[1].previous_hash).toBe(headBefore);
  });

  it('given the advisory lock held by another session, should no-op and leave the queue intact', async () => {
    const blocker = await owner.connect();
    try {
      await blocker.query("SELECT pg_advisory_lock(hashtext('audit-chainer'))");

      await seedIngestRows(appPool, [
        {
          id: 'drain-c-0',
          event: { eventType: 'auth.logout', userId: 'user-c' } as AuditEvent,
          timestamp: t(20),
          emittedAt: t(20),
        },
      ]);

      const blocked = await processAuditChainer({ pool: procPool });
      expect(blocked).toEqual({ outcome: 'lock_busy', drained: 0 });

      const queued = await owner.query('SELECT count(*)::int AS n FROM security_audit_ingest');
      expect(queued.rows[0].n).toBe(1);

      await blocker.query("SELECT pg_advisory_unlock(hashtext('audit-chainer'))");
    } finally {
      blocker.release();
    }

    const afterUnlock = await processAuditChainer({ pool: procPool });
    expect(afterUnlock).toMatchObject({ outcome: 'chained', drained: 1 });
    expect(afterUnlock.verification?.valid).toBe(true);
  });

  it('given the drain grant matrix, admin_processor_user still cannot UPDATE/DELETE the chain or INSERT into the queue (42501)', async () => {
    // Least-privilege boundary: the chainer identity's DELETE exists ONLY on
    // the queue; the chain stays append-only even for its single writer.
    await expect(
      procPool.query(`UPDATE security_audit_log SET event_hash = 'tampered' WHERE id = 'drain-a-0'`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      procPool.query(`DELETE FROM security_audit_log WHERE id = 'drain-a-0'`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      procPool.query(
        `INSERT INTO security_audit_ingest (id, event_type, emission_hash) VALUES ('x', 'auth.logout', 'h')`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
