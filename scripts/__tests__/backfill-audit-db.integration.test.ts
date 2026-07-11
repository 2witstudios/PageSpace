/**
 * Rehearsal integration for scripts/backfill-audit-db.ts (#890 Phase 2,
 * leaf 8) — the zero-loss capstone, wire-connected on scratch Postgres.
 *
 * Two REAL databases on one scratch server play the two planes:
 *   - the admin scratch DB (ADMIN_DATABASE_URL): migrated via migrateAdminDb
 *     through 0007 (partitioned chain tables, roles, emission column);
 *   - a sibling "main" DB holding the legacy security_audit_log (chain_seq
 *     bigserial, ip_bidx — the real main shape) with a REAL hash chain built
 *     by computeSecurityEventHash, plus siem_delivery_cursors.
 *
 * What this proves end to end:
 *   1. Dry-run plans and writes nothing.
 *   2. --apply plants every legacy row preserving id/chain_seq/hashes/NULLed
 *      PII, creates the historical monthly partitions (DEFAULT stays empty),
 *      aligns the chain sequence, commits the SIEM anchor row LAST, and the
 *      FULL genesis→head era-aware verification passes with row-count +
 *      head-hash parity.
 *   3. Reruns are idempotent (0 planted, no dupes) and converge new main
 *      tail rows (zero-loss).
 *   4. Precondition refusals: an emission era already chained from 'genesis'
 *      aborts (the leaf-7 unresolved case), a moved main head aborts, and
 *      break-glass aborts — all without planting a single row.
 *   5. A tampered admin row is caught by the in-run verification.
 *   6. --freeze re-proves parity + chain, then write-freezes the main table:
 *      INSERT/DELETE/TRUNCATE and non-PII UPDATE raise (owner included),
 *      while the GDPR pseudonymization UPDATE keeps working; a probe user's
 *      INSERT grant is revoked; the freeze refuses when the backfill has not
 *      run; rerunning the freeze is idempotent.
 *
 * Requires a running scratch Postgres (never the app DB):
 *   docker run --rm -d --name pagespace-admin-smoke -p 55432:5432 \
 *     -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=pagespace_admin postgres:16
 *   ADMIN_DATABASE_URL=postgresql://admin:admin@localhost:55432/pagespace_admin \
 *     bunx vitest run __tests__/backfill-audit-db.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { migrateAdminDb } from '@pagespace/db/migrate-admin';
import { createAdminAuditDbClient, type AdminAuditDbClient } from '@pagespace/db/admin-eraser-db';
import { computeSecurityEventHash, type AuditEvent } from '@pagespace/lib/audit/security-audit';
import { computeEmissionHash } from '@pagespace/lib/audit/emission-hash';
import { computeChainHash } from '@pagespace/lib/audit/chain-step';
import {
  runAuditBackfill,
  freezeLegacySecurityAuditLog,
  type PoolLike,
} from '../backfill-audit-db';

interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}
interface PgPool extends PoolLike {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}
// pg is not hoisted to the repo root (scripts/ has no package.json), so
// resolve it through @pagespace/db's module context — the same physical
// driver the db package itself uses.
import { createRequire } from 'node:module';
const requireFromTest = createRequire(import.meta.url);
const requireFromDb = createRequire(requireFromTest.resolve('@pagespace/db/db'));
const { Pool } = requireFromDb('pg') as unknown as {
  Pool: new (config: Record<string, unknown>) => PgPool;
};

const url = process.env.ADMIN_DATABASE_URL;
const MAIN_DB_NAME = 'pagespace_main_backfill_it';
const PROBE_ROLE = 'main_backfill_probe';

const ADMIN_ROLES = [
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

function mainDbUrl(): string {
  const parsed = new URL(url as string);
  parsed.pathname = `/${MAIN_DB_NAME}`;
  return parsed.toString();
}

// Real main-plane shape: chain_seq bigserial, ip_bidx, timestamp WITHOUT tz.
const MAIN_TABLES_DDL = `
  CREATE TABLE security_audit_log (
    id text PRIMARY KEY,
    event_type text NOT NULL,
    user_id text,
    session_id text,
    service_id text,
    resource_type text,
    resource_id text,
    ip_address text,
    ip_bidx text,
    user_agent text,
    geo_location text,
    details jsonb,
    risk_score real,
    anomaly_flags text[],
    timestamp timestamp DEFAULT now() NOT NULL,
    chain_seq bigserial NOT NULL,
    previous_hash text NOT NULL,
    event_hash text NOT NULL
  );
  CREATE TABLE siem_delivery_cursors (
    id text PRIMARY KEY,
    "lastDeliveredId" text,
    "lastDeliveredAt" timestamp,
    "deliveryCount" integer NOT NULL DEFAULT 0,
    "lastError" text,
    "lastErrorAt" timestamp,
    "updatedAt" timestamp NOT NULL DEFAULT now()
  );
`;

// --- fixtures ---------------------------------------------------------------

// Local-time Dates: the main column is timestamp WITHOUT time zone, so the pg
// driver round-trips local wall-clock — hashes recompute byte-identically.
const T = (month: number, s: number) => new Date(2026, month - 1, 1, 0, 0, s);

interface LegacyRow {
  id: string;
  event: AuditEvent;
  timestamp: Date;
  previousHash: string;
  eventHash: string;
}

function buildLegacyChain(timestamps: Date[]): LegacyRow[] {
  const rows: LegacyRow[] = [];
  let prev = 'genesis';
  timestamps.forEach((timestamp, idx) => {
    const i = idx + 1;
    const event: AuditEvent = {
      eventType: 'auth.login.success',
      userId: `user-${i}`,
      sessionId: `sess-${i}`,
      serviceId: 'web',
      resourceType: 'user',
      resourceId: `u-${i}`,
      ipAddress: '10.1.2.3',
      userAgent: 'rehearsal-agent',
      geoLocation: 'EU/Berlin',
      details: { legacy: i },
      // Exactly representable in float4 — read back from `real` must hash identically.
      riskScore: 0.5,
    };
    const eventHash = computeSecurityEventHash(event, prev, timestamp);
    rows.push({ id: `r${i}`, event, timestamp, previousHash: prev, eventHash });
    prev = eventHash;
  });
  return rows;
}

async function insertMainRows(pool: PgPool, rows: LegacyRow[], seqBase = 0): Promise<void> {
  for (const [idx, r] of rows.entries()) {
    await pool.query(
      `INSERT INTO security_audit_log
         (id, event_type, user_id, session_id, service_id, resource_type, resource_id,
          ip_address, ip_bidx, user_agent, geo_location, details, risk_score,
          anomaly_flags, timestamp, chain_seq, previous_hash, event_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18)`,
      [
        r.id,
        r.event.eventType,
        r.event.userId ?? null,
        r.event.sessionId ?? null,
        r.event.serviceId ?? null,
        r.event.resourceType ?? null,
        r.event.resourceId ?? null,
        r.event.ipAddress ?? null,
        `bidx-${r.id}`,
        r.event.userAgent ?? null,
        r.event.geoLocation ?? null,
        r.event.details ? JSON.stringify(r.event.details) : null,
        r.event.riskScore ?? null,
        r.event.anomalyFlags ?? null,
        // UTC-rendered, exactly as drizzle wrote production rows (its
        // timestamp mapToDriverValue is toISOString; reads assume +0000).
        // Raw pg Date params would store LOCAL wall clock and break hashes.
        r.timestamp.toISOString(),
        seqBase + idx + 1,
        r.previousHash,
        r.eventHash,
      ]
    );
  }
}

describe.skipIf(!url)('backfill-audit-db rehearsal (wire-connected)', () => {
  let adminOwner: PgPool;
  let mainOwner: PgPool;
  let adminClient: AdminAuditDbClient;

  async function resetBothStores(): Promise<void> {
    // Recreate the drizzle client per reset: sessions opened before a schema
    // reset cache the dropped public schema's OID and stop seeing tables.
    await adminClient?.end();
    await adminOwner.query('DROP SCHEMA IF EXISTS public CASCADE');
    await adminOwner.query('DROP SCHEMA IF EXISTS drizzle_admin CASCADE');
    await adminOwner.query('CREATE SCHEMA public');
    for (const role of ADMIN_ROLES) {
      await adminOwner.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
            DROP OWNED BY ${role};
            DROP ROLE ${role};
          END IF;
        END $$;
      `);
    }
    const previousCwd = process.cwd();
    process.chdir(path.resolve(__dirname, '../../packages/db'));
    try {
      await migrateAdminDb({ ADMIN_DATABASE_URL: url });
    } finally {
      process.chdir(previousCwd);
    }
    adminClient = createAdminAuditDbClient({ connectionString: url as string });

    await mainOwner.query(
      'DROP TABLE IF EXISTS security_audit_log, siem_delivery_cursors CASCADE'
    );
    await mainOwner.query('DROP FUNCTION IF EXISTS security_audit_log_freeze_guard() CASCADE');
    await mainOwner.query(MAIN_TABLES_DDL);
  }

  const backfillDeps = (overrides: Record<string, unknown> = {}) => ({
    main: mainOwner,
    adminPool: adminOwner,
    adminDb: adminClient.db,
    batchSize: 2, // small on purpose — exercises multi-batch commits
    log: () => {},
    ...overrides,
  });

  beforeAll(async () => {
    adminOwner = new Pool({ connectionString: url, max: 4 });
    await adminOwner.query(`CREATE DATABASE ${MAIN_DB_NAME}`).catch((err: unknown) => {
      if ((err as { code?: string }).code !== '42P04') throw err; // already exists
    });
    mainOwner = new Pool({ connectionString: mainDbUrl(), max: 4 });
  });

  afterAll(async () => {
    await mainOwner
      ?.query(`DROP OWNED BY ${PROBE_ROLE}; DROP ROLE IF EXISTS ${PROBE_ROLE}`)
      .catch(() => undefined);
    await Promise.all([adminClient?.end(), adminOwner?.end(), mainOwner?.end()]);
  });

  describe('plant → verify → converge (the rehearsal proper)', () => {
    // r1..r3 in January 2026, r4..r7 in February — two historical months.
    const legacy = buildLegacyChain([T(1, 1), T(1, 2), T(1, 3), T(2, 4), T(2, 5), T(2, 6), T(2, 7)]);

    beforeAll(async () => {
      await resetBothStores();
      await insertMainRows(mainOwner, legacy);
      // SIEM shipped r1..r3 pre-flip; the admin cursor does not exist yet, so
      // the MAIN watermark is the anchor the future seed will copy.
      await mainOwner.query(
        `INSERT INTO siem_delivery_cursors (id, "lastDeliveredId", "lastDeliveredAt", "deliveryCount")
         VALUES ('security_audit_log', 'r3', $1, 3)`,
        [legacy[2].timestamp]
      );
      // A pre-backfill GDPR erasure already nulled r2's PII in main — the
      // copy must carry the nulls verbatim and still verify (hash excludes PII).
      await mainOwner.query(
        `UPDATE security_audit_log
         SET ip_address = NULL, ip_bidx = NULL, user_agent = NULL, geo_location = NULL, session_id = NULL
         WHERE id = 'r2'`
      );
    });

    it('dry-run plans without writing a single row', async () => {
      const summary = await runAuditBackfill({ ...backfillDeps(), dryRun: true });
      expect(summary.outcome).toBe('planned');
      expect(summary.precondition).toEqual({ ok: true, state: 'pre_chainer' });
      expect(summary.anchorRowId).toBe('r3');
      const count = await adminOwner.query('SELECT count(*)::int AS n FROM security_audit_log');
      expect(count.rows[0].n).toBe(0);
    });

    it('--apply plants everything, seq-aligned, anchor last, genesis→head GREEN with parity', async () => {
      const summary = await runAuditBackfill({ ...backfillDeps(), dryRun: false });

      expect(summary.outcome).toBe('backfilled');
      expect(summary.planted).toBe(7);
      expect(summary.anchorRowId).toBe('r3');
      expect(summary.anchorPlanted).toBe(true);
      expect(summary.parity).toEqual({ ok: true, failures: [] });

      // THE core proof: the whole admin chain verifies genesis→head.
      expect(summary.verification?.isValid).toBe(true);
      expect(summary.verification?.totalEntries).toBe(7);
      expect(summary.verification?.entriesVerified).toBe(7);
      expect(summary.verification?.invalidEntries).toBe(0);
      console.log('[rehearsal] genesis→head verification:', JSON.stringify(summary.verification));

      // Anchor-committed-last, after every batch AND the sequence alignment.
      const journal = summary.journal;
      expect(journal[journal.length - 1]).toBe('anchor:r3');
      expect(journal.indexOf('setval:7')).toBeGreaterThan(-1);
      expect(journal.indexOf('setval:7')).toBeLessThan(journal.indexOf('anchor:r3'));
      for (const entry of journal.filter((j) => j.startsWith('plant:'))) {
        expect(journal.indexOf(entry)).toBeLessThan(journal.indexOf('setval:7'));
      }

      // Historical partitions created; the DEFAULT partition stayed empty.
      expect(summary.partitionsCreated).toEqual(
        expect.arrayContaining(['security_audit_log_p2026_01', 'security_audit_log_p2026_02'])
      );
      const inDefault = await adminOwner.query(
        'SELECT count(*)::int AS n FROM security_audit_log_default'
      );
      expect(inDefault.rows[0].n).toBe(0);

      // Row-for-row equality of everything the chain covers + PII columns —
      // including r2's pre-erasure NULLs carried verbatim.
      const adminRows = await adminOwner.query(
        `SELECT id, chain_seq::int AS seq, previous_hash, event_hash, emission_hash,
                ip_address, ip_bidx, user_agent, geo_location, session_id
         FROM security_audit_log ORDER BY chain_seq`
      );
      expect(adminRows.rows.map((r) => `${r.id}:${r.seq}`)).toEqual(
        legacy.map((r, i) => `${r.id}:${i + 1}`)
      );
      for (const [i, row] of adminRows.rows.entries()) {
        expect(row.previous_hash).toBe(legacy[i].previousHash);
        expect(row.event_hash).toBe(legacy[i].eventHash);
        expect(row.emission_hash).toBeNull(); // the legacy-era marker
      }
      const erased = adminRows.rows.find((r) => r.id === 'r2');
      expect(erased).toMatchObject({
        ip_address: null,
        ip_bidx: null,
        user_agent: null,
        geo_location: null,
        session_id: null,
      });

      // Head-hash parity, asserted independently of the summary.
      const mainHead = await mainOwner.query(
        'SELECT event_hash FROM security_audit_log ORDER BY chain_seq DESC LIMIT 1'
      );
      const adminHead = await adminOwner.query(
        'SELECT event_hash FROM security_audit_log ORDER BY chain_seq DESC LIMIT 1'
      );
      expect(adminHead.rows[0].event_hash).toBe(mainHead.rows[0].event_hash);

      // Sequence aligned: the chainer's next chain_seq exceeds the legacy range.
      const next = await adminOwner.query(
        `SELECT nextval('security_audit_log_chain_seq_seq')::int AS v`
      );
      expect(next.rows[0].v).toBeGreaterThan(7);
    });

    it('rerun is idempotent: nothing re-planted, no dupes, still GREEN', async () => {
      const summary = await runAuditBackfill({ ...backfillDeps(), dryRun: false });
      expect(summary.outcome).toBe('backfilled');
      expect(summary.planted).toBe(0);
      expect(summary.parity?.ok).toBe(true);
      expect(summary.verification?.isValid).toBe(true);
      const count = await adminOwner.query('SELECT count(*)::int AS n FROM security_audit_log');
      expect(count.rows[0].n).toBe(7);
    });

    it('converges a main tail row appended after the first run (zero-loss)', async () => {
      const [r8] = buildLegacyChain([T(2, 8)]).map((row) => ({
        ...row,
        id: 'r8',
        previousHash: legacy[6].eventHash,
        eventHash: computeSecurityEventHash(row.event, legacy[6].eventHash, row.timestamp),
      }));
      await insertMainRows(mainOwner, [r8], 7);

      const summary = await runAuditBackfill({ ...backfillDeps(), dryRun: false });
      expect(summary.outcome).toBe('backfilled');
      expect(summary.planted).toBe(1);
      expect(summary.parity?.ok).toBe(true);
      expect(summary.verification?.isValid).toBe(true);
      expect(summary.verification?.totalEntries).toBe(8);
    });

    it('detects an admin-side tamper during the rerun verification', async () => {
      await adminOwner.query(
        `UPDATE security_audit_log SET event_hash = 'tampered' WHERE id = 'r5'`
      );
      const summary = await runAuditBackfill({ ...backfillDeps(), dryRun: false });
      expect(summary.verification?.isValid).toBe(false);
      expect(summary.verification?.breakPoint?.entryId).toBe('r5');
      // repair for the freeze block below
      await adminOwner.query(`UPDATE security_audit_log SET event_hash = $1 WHERE id = 'r5'`, [
        legacy[4].eventHash,
      ]);
      const repaired = await runAuditBackfill({ ...backfillDeps(), dryRun: false });
      expect(repaired.verification?.isValid).toBe(true);
    });

    describe('--freeze (same seeded state, after verification)', () => {
      it('re-proves parity + chain, then freezes', async () => {
        // a probe user with an explicit INSERT grant, to prove the revoke
        await mainOwner.query(`
          DO $$ BEGIN
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PROBE_ROLE}') THEN
              CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD 'probesecret1';
            END IF;
          END $$;
        `);
        await mainOwner.query(`GRANT INSERT, DELETE ON security_audit_log TO ${PROBE_ROLE}`);

        const result = await freezeLegacySecurityAuditLog({
          main: mainOwner,
          admin: adminOwner,
          adminDb: adminClient.db,
        });
        expect(result.outcome).toBe('frozen');
        expect(result.parity?.ok).toBe(true);
        expect(result.verification?.isValid).toBe(true);
      });

      it('blocks INSERT, DELETE, TRUNCATE, and non-PII UPDATE — for the OWNER too', async () => {
        await expect(
          mainOwner.query(
            `INSERT INTO security_audit_log (id, event_type, timestamp, chain_seq, previous_hash, event_hash)
             VALUES ('frozen-probe', 'auth.login.success', now(), 999, 'x', 'y')`
          )
        ).rejects.toThrow(/write-frozen/);
        await expect(
          mainOwner.query(`DELETE FROM security_audit_log WHERE id = 'r1'`)
        ).rejects.toThrow(/write-frozen/);
        await expect(mainOwner.query('TRUNCATE security_audit_log')).rejects.toThrow(
          /write-frozen/
        );
        await expect(
          mainOwner.query(`UPDATE security_audit_log SET event_hash = 'evil' WHERE id = 'r1'`)
        ).rejects.toThrow(/write-frozen/);
        await expect(
          mainOwner.query(`UPDATE security_audit_log SET details = '{}'::jsonb WHERE id = 'r1'`)
        ).rejects.toThrow(/write-frozen/);
      });

      it('revoked the probe user\'s write grants (grant-denial)', async () => {
        const grants = await mainOwner.query(
          `SELECT privilege_type FROM information_schema.role_table_grants
           WHERE table_name = 'security_audit_log' AND grantee = '${PROBE_ROLE}'
             AND privilege_type IN ('INSERT', 'DELETE', 'TRUNCATE')`
        );
        expect(grants.rows).toEqual([]);

        const probePool = new Pool({
          connectionString: (() => {
            const parsed = new URL(mainDbUrl());
            parsed.username = PROBE_ROLE;
            parsed.password = 'probesecret1';
            return parsed.toString();
          })(),
          max: 1,
        });
        try {
          await expect(
            probePool.query(
              `INSERT INTO security_audit_log (id, event_type, timestamp, chain_seq, previous_hash, event_hash)
               VALUES ('probe-row', 'auth.login.success', now(), 998, 'x', 'y')`
            )
          ).rejects.toThrow(/permission denied|write-frozen/);
        } finally {
          await probePool.end();
        }
      });

      it('keeps the GDPR pseudonymization UPDATE working (Art 17 outlives the freeze)', async () => {
        const result = await mainOwner.query(
          `UPDATE security_audit_log
           SET ip_address = NULL, ip_bidx = NULL, user_agent = NULL, geo_location = NULL, session_id = NULL
           WHERE user_id = 'user-4'`
        );
        expect(result.rowCount).toBe(1);
        const chainCols = await mainOwner.query(
          `SELECT previous_hash, event_hash FROM security_audit_log WHERE user_id = 'user-4'`
        );
        expect(chainCols.rows[0].event_hash).toBe(legacy[3].eventHash);
      });

      it('is idempotent — freezing again succeeds and changes nothing', async () => {
        const result = await freezeLegacySecurityAuditLog({
          main: mainOwner,
          admin: adminOwner,
          adminDb: adminClient.db,
        });
        expect(result.outcome).toBe('frozen');
      });
    });
  });

  describe('refusal paths (fresh stores each)', () => {
    it("aborts on an emission era already chained from 'genesis' — the chainer-ran-first state", async () => {
      await resetBothStores();
      const legacy = buildLegacyChain([T(2, 1), T(2, 2)]);
      await insertMainRows(mainOwner, legacy);

      // Simulate the chainer having run before backfill: one emission-era row
      // hanging off 'genesis' in the admin store.
      const event: AuditEvent = { eventType: 'data.read', userId: 'user-g', resourceType: 'page', resourceId: 'p-g' };
      const ts = T(7, 1);
      const emission = computeEmissionHash(event, ts);
      await adminOwner.query(
        `INSERT INTO security_audit_log
           (id, event_type, user_id, resource_type, resource_id, timestamp, emission_hash, previous_hash, event_hash)
         VALUES ('g1', $1, 'user-g', 'page', 'p-g', $2, $3, 'genesis', $4)`,
        [event.eventType, ts.toISOString(), emission, computeChainHash(emission, 'genesis')]
      );

      const summary = await runAuditBackfill({ ...backfillDeps(), dryRun: false });
      expect(summary.outcome).toBe('aborted');
      expect(summary.precondition).toMatchObject({ ok: false, reason: 'unlinked_emission_era' });
      const planted = await adminOwner.query(
        'SELECT count(*)::int AS n FROM security_audit_log WHERE emission_hash IS NULL'
      );
      expect(planted.rows[0].n).toBe(0);
    });

    it('aborts on a main head that moved past the frozen era boundary', async () => {
      await resetBothStores();
      const legacy = buildLegacyChain([T(2, 1), T(2, 2)]);
      await insertMainRows(mainOwner, legacy);

      // The boundary linked onto head r2… then main grew r3 (break-glass).
      const event: AuditEvent = { eventType: 'data.read', userId: 'user-g', resourceType: 'page', resourceId: 'p-g' };
      const ts = T(7, 1);
      const emission = computeEmissionHash(event, ts);
      await adminOwner.query(
        `INSERT INTO security_audit_log
           (id, event_type, user_id, resource_type, resource_id, timestamp, chain_seq, emission_hash, previous_hash, event_hash)
         VALUES ('g1', $1, 'user-g', 'page', 'p-g', $2, 3, $3, $4, $5)`,
        [event.eventType, ts.toISOString(), emission, legacy[1].eventHash, computeChainHash(emission, legacy[1].eventHash)]
      );
      const tail = buildLegacyChain([T(2, 3)]).map((row) => ({
        ...row,
        id: 'r3',
        previousHash: legacy[1].eventHash,
        eventHash: computeSecurityEventHash(row.event, legacy[1].eventHash, row.timestamp),
      }));
      await insertMainRows(mainOwner, tail, 2);

      const summary = await runAuditBackfill({ ...backfillDeps(), dryRun: false });
      expect(summary.outcome).toBe('aborted');
      expect(summary.precondition).toMatchObject({ ok: false, reason: 'boundary_mismatch' });
    });

    it('aborts when break-glass is armed, and the freeze refuses too', async () => {
      await resetBothStores();
      await insertMainRows(mainOwner, buildLegacyChain([T(2, 1)]));

      const summary = await runAuditBackfill({
        ...backfillDeps({ breakGlassArmed: true }),
        dryRun: false,
      });
      expect(summary.outcome).toBe('aborted');
      expect(summary.precondition).toMatchObject({ ok: false, reason: 'break_glass_armed' });

      const freeze = await freezeLegacySecurityAuditLog({
        main: mainOwner,
        admin: adminOwner,
        adminDb: adminClient.db,
        breakGlassArmed: true,
      });
      expect(freeze.outcome).toBe('refused');
    });

    it('the freeze refuses when the backfill has not run (main rows, empty admin)', async () => {
      await resetBothStores();
      await insertMainRows(mainOwner, buildLegacyChain([T(2, 1), T(2, 2)]));

      const result = await freezeLegacySecurityAuditLog({
        main: mainOwner,
        admin: adminOwner,
        adminDb: adminClient.db,
      });
      expect(result.outcome).toBe('refused');
      expect(result.refusals.join(' ')).toMatch(/backfill/i);

      // …and the table is still writable (no partial freeze).
      const insert = await mainOwner.query(
        `INSERT INTO security_audit_log (id, event_type, timestamp, chain_seq, previous_hash, event_hash)
         VALUES ('still-writable', 'auth.login.success', now(), 99, 'x', 'y')`
      );
      expect(insert.rowCount).toBe(1);
    });
  });
});
