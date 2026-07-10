/**
 * Cross-actor rehearsal of the #890 Phase 2 leaf-8 backfill against the REAL
 * chainer and SIEM delivery workers, wire-connected on scratch Postgres.
 *
 * The scripts-side rehearsal (scripts/__tests__/backfill-audit-db.integration.test.ts)
 * proves the script alone: plant/parity/verify/freeze. THIS suite proves the
 * choreography the runbook prescribes, with every actor real:
 *
 *   1. Chainer exclusion is real: while the backfill's advisory lock is held,
 *      processAuditChainer() no-ops 'lock_busy' (behavioral pin that the
 *      script's CHAINER_ADVISORY_LOCK_KEY is the chainer's own key).
 *   2. Runbook order — processor stopped, web still emitting: events buffer
 *      in security_audit_ingest, SIEM seeds cursors from the legacy watermark
 *      and defers the security source (awaiting_backfill, no error).
 *   3. The REAL script plants the legacy rows (anchor-committed-last); the
 *      chainer's next run drains the buffered ingest rows and links the
 *      emission era onto the BACKFILLED legacy head with chain_seq continuing
 *      after the legacy range (setval proof — no collision), and the full
 *      genesis→head era-aware verification passes.
 *   4. SIEM's deferral releases: exactly the undelivered legacy rows then the
 *      chainer rows deliver, exactly once, cursor continuity intact.
 *   5. Violated order (chainer ran first): the script ABORTS
 *      unlinked_emission_era and plants nothing — the leaf-7 flagged case.
 *
 * TZ is pinned to UTC (before any Date is created): production containers run
 * UTC, and the SIEM preflight's raw-pg timestamp parsing is only aligned with
 * drizzle's UTC-wall-clock storage convention when local time IS UTC.
 *
 * Requires a running scratch Postgres (never the app DB):
 *   docker run --rm -d --name pagespace-admin-smoke -p 55432:5432 \
 *     -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=pagespace_admin postgres:16
 *   ADMIN_DATABASE_URL=postgresql://admin:admin@localhost:55432/pagespace_admin \
 *     bunx vitest run src/workers/__tests__/audit-backfill-flip.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import { migrateAdminDb } from '@pagespace/db/migrate-admin';
import { provisionAdminLoginUsers } from '@pagespace/db/provision-admin-users';
import { createAdminAuditDbClient, type AdminAuditDbClient } from '@pagespace/db/admin-eraser-db';
import { verifySecurityAuditChain } from '@pagespace/lib/audit/security-audit-chain-verifier';
import { computeSecurityEventHash, type AuditEvent } from '@pagespace/lib/audit/security-audit';
import { computeEmissionHash } from '@pagespace/lib/audit/emission-hash';
import { computeLogHash } from '@pagespace/lib/monitoring/activity-logger';

const { deliveredBatches, mockDeliver } = vi.hoisted(() => {
  // Before anything else in this module touches a Date: see header.
  process.env.TZ = 'UTC';
  const deliveredBatches: { id: string; source: string }[][] = [];
  const mockDeliver = vi.fn(
    async (_config: unknown, entries: { id: string; source: string }[]) => {
      deliveredBatches.push(entries.map((e) => ({ id: e.id, source: e.source })));
      return {
        success: true,
        entriesDelivered: entries.length,
        webhookStatus: 200,
        responseHash: 'a'.repeat(64),
        ackReceivedAt: new Date(),
      };
    }
  );
  return { deliveredBatches, mockDeliver };
});

vi.mock('../../services/siem-adapter', async () => {
  const actual = await vi.importActual<typeof import('../../services/siem-adapter')>(
    '../../services/siem-adapter'
  );
  return {
    ...actual,
    loadSiemConfig: () => ({
      enabled: true,
      type: 'webhook' as const,
      webhook: {
        url: 'https://siem.example.com/ingest',
        secret: 'integration-secret',
        batchSize: 100,
        retryAttempts: 0,
      },
    }),
    validateSiemConfig: () => ({ valid: true, errors: [] }),
    deliverToSiemWithRetry: mockDeliver,
  };
});

import { processSiemDelivery, resetSiemModeBannerForTests } from '../siem-delivery-worker';
import { processAuditChainer } from '../audit-chainer-worker';
import { CURSOR_INIT_SENTINEL } from '../../services/siem-sources';
import {
  runAuditBackfill,
  CHAINER_ADVISORY_LOCK_KEY,
  SIEM_CURSOR_INIT_SENTINEL,
  type PoolLike,
} from '../../../../../scripts/backfill-audit-db';

interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}
interface PgPool extends PoolLike {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}
// @ts-expect-error -- pg has no bundled types; runtime cast below handles type safety
import pg from 'pg';
const { Pool } = pg as unknown as { Pool: new (config: Record<string, unknown>) => PgPool };

const url = process.env.ADMIN_DATABASE_URL;
const MAIN_DB_NAME = 'pagespace_main_bf_flip_it';

const PASSWORDS = {
  ADMIN_APP_PASSWORD: 'appsecretbfflip1',
  ADMIN_PROCESSOR_PASSWORD: 'procsecretbfflip1',
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

function mainDbUrl(): string {
  const parsed = new URL(url as string);
  parsed.pathname = `/${MAIN_DB_NAME}`;
  return parsed.toString();
}

// --- fixtures ---------------------------------------------------------------

const T = (s: number) => new Date(Date.UTC(2026, 1, 1, 0, 0, s));

interface LegacyRow {
  id: string;
  event: AuditEvent;
  timestamp: Date;
  previousHash: string;
  eventHash: string;
}

function buildLegacyChain(count: number): LegacyRow[] {
  const rows: LegacyRow[] = [];
  let prev = 'genesis';
  for (let i = 1; i <= count; i++) {
    const event: AuditEvent = {
      eventType: 'auth.login.success',
      userId: `user-${i}`,
      sessionId: `sess-${i}`,
      serviceId: 'web',
      resourceType: 'user',
      resourceId: `u-${i}`,
      ipAddress: '10.0.0.9',
      userAgent: 'it-agent',
      geoLocation: 'EU/Berlin',
      details: { legacy: i },
      riskScore: 0.5, // exactly representable in float4
    };
    const timestamp = T(i);
    const eventHash = computeSecurityEventHash(event, prev, timestamp);
    rows.push({ id: `r${i}`, event, timestamp, previousHash: prev, eventHash });
    prev = eventHash;
  }
  return rows;
}

async function insertLegacySecurityRows(pool: PgPool, rows: LegacyRow[]): Promise<void> {
  for (const [idx, r] of rows.entries()) {
    await pool.query(
      `INSERT INTO security_audit_log
         (id, timestamp, event_type, user_id, session_id, service_id, resource_type,
          resource_id, ip_address, ip_bidx, user_agent, geo_location, details, risk_score,
          anomaly_flags, chain_seq, previous_hash, event_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18)`,
      [
        r.id,
        r.timestamp,
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
        idx + 1,
        r.previousHash,
        r.eventHash,
      ]
    );
  }
}

interface ActivityRow {
  id: string;
  timestamp: Date;
  previousLogHash: string;
  logHash: string;
}

function buildActivityChain(count: number): ActivityRow[] {
  const rows: ActivityRow[] = [];
  let prev = 'act-seed';
  for (let i = 0; i < count; i++) {
    const timestamp = T(i);
    const logHash = computeLogHash(
      {
        id: `a${i}`,
        timestamp,
        operation: 'page.update',
        resourceType: 'page',
        resourceId: `p-${i}`,
        driveId: 'd1',
        pageId: `p-${i}`,
      },
      prev
    );
    rows.push({ id: `a${i}`, timestamp, previousLogHash: prev, logHash });
    prev = logHash;
  }
  return rows;
}

async function insertActivityRows(pool: PgPool, rows: ActivityRow[]): Promise<void> {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO activity_logs (id, timestamp, "userId", "actorEmail", "actorDisplayName",
         operation, "resourceType", "resourceId", "driveId", "pageId", "previousLogHash", "logHash")
       VALUES ($1, $2, 'u1', 'user@example.com', NULL, 'page.update', 'page', $3, 'd1', $3, $4, $5)`,
      [r.id, r.timestamp, `p-${r.id.slice(1)}`, r.previousLogHash, r.logHash]
    );
  }
}

async function setCursor(
  pool: PgPool,
  source: string,
  lastDeliveredId: string,
  lastDeliveredAt: Date,
  deliveryCount: number
): Promise<void> {
  await pool.query(
    `INSERT INTO siem_delivery_cursors (id, "lastDeliveredId", "lastDeliveredAt", "deliveryCount", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO UPDATE SET
       "lastDeliveredId" = $2, "lastDeliveredAt" = $3, "deliveryCount" = $4, "updatedAt" = NOW()`,
    [source, lastDeliveredId, lastDeliveredAt, deliveryCount]
  );
}

async function readCursor(pool: PgPool, source: string) {
  const r = await pool.query(
    'SELECT "lastDeliveredId", "deliveryCount", "lastError" FROM siem_delivery_cursors WHERE id = $1',
    [source]
  );
  const row = r.rows[0];
  if (!row) return undefined;
  return {
    lastDeliveredId: row.lastDeliveredId as string,
    deliveryCount: Number(row.deliveryCount),
    lastError: (row.lastError as string | null) ?? null,
  };
}

async function seedIngestRows(
  appPool: PgPool,
  rows: Array<{ id: string; event: AuditEvent; timestamp: Date; emittedAt: Date }>
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
      ]
    );
  }
}

// --- harness ------------------------------------------------------------

// Real main-plane shapes where it matters to the backfill: security_audit_log
// carries chain_seq and ip_bidx, timestamps are `timestamp` WITHOUT time zone
// (drizzle stores UTC wall clock; TZ=UTC keeps every reader aligned).
const MAIN_TABLES_DDL = `
  CREATE TABLE activity_logs (
    id text PRIMARY KEY,
    timestamp timestamp NOT NULL,
    "userId" text,
    "actorEmail" text NOT NULL,
    "actorDisplayName" text,
    "isAiGenerated" boolean NOT NULL DEFAULT false,
    "aiProvider" text,
    "aiModel" text,
    "aiConversationId" text,
    operation text NOT NULL,
    "resourceType" text NOT NULL,
    "resourceId" text NOT NULL,
    "resourceTitle" text,
    "driveId" text,
    "pageId" text,
    metadata jsonb,
    "contentSnapshot" text,
    "previousValues" jsonb,
    "newValues" jsonb,
    "previousLogHash" text,
    "logHash" text
  );
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
    "updatedAt" timestamp NOT NULL DEFAULT now(),
    CONSTRAINT cursor_pair_check CHECK (("lastDeliveredId" IS NULL) = ("lastDeliveredAt" IS NULL))
  );
`;
// siem_delivery_receipts deliberately ABSENT on main: misroutes must explode.

describe.skipIf(!url)('leaf-8 backfill flip with real chainer + SIEM workers (wire-connected)', () => {
  let adminOwner: PgPool;
  let mainOwner: PgPool;
  let appPool: PgPool;
  let procPool: PgPool;
  let adminClient: AdminAuditDbClient;

  const workerDeps = () => ({
    mainPool: mainOwner,
    adminPool: procPool,
    env: { ADMIN_DATABASE_URL: url },
  });

  const backfillDeps = () => ({
    main: mainOwner,
    adminPool: adminOwner,
    adminDb: adminClient.db,
    batchSize: 2,
    log: () => {},
  });

  async function resetBothStores(): Promise<void> {
    await Promise.all([appPool?.end(), procPool?.end(), adminClient?.end()]);
    await adminOwner.query('DROP SCHEMA IF EXISTS public CASCADE');
    await adminOwner.query('DROP SCHEMA IF EXISTS drizzle_admin CASCADE');
    await adminOwner.query('CREATE SCHEMA public');
    for (const role of ALL_ROLES) {
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
    process.chdir(path.resolve(__dirname, '../../../../../packages/db'));
    try {
      await migrateAdminDb({ ADMIN_DATABASE_URL: url });
    } finally {
      process.chdir(previousCwd);
    }
    const result = await provisionAdminLoginUsers({ ADMIN_DATABASE_URL: url, ...PASSWORDS });
    expect(result.provisioned).toEqual(['admin_app_user', 'admin_processor_user']);

    // Fresh pools/clients per reset — cached schema OIDs go stale otherwise.
    appPool = new Pool(loginConfig('admin_app_user', PASSWORDS.ADMIN_APP_PASSWORD));
    procPool = new Pool(loginConfig('admin_processor_user', PASSWORDS.ADMIN_PROCESSOR_PASSWORD));
    adminClient = createAdminAuditDbClient({ connectionString: url as string });

    await mainOwner.query(
      'DROP TABLE IF EXISTS activity_logs, security_audit_log, siem_delivery_cursors, siem_delivery_receipts'
    );
    await mainOwner.query(MAIN_TABLES_DDL);
  }

  beforeAll(async () => {
    adminOwner = new Pool({ connectionString: url, max: 4 });
    await adminOwner.query(`CREATE DATABASE ${MAIN_DB_NAME}`).catch((err: unknown) => {
      if ((err as { code?: string }).code !== '42P04') throw err;
    });
    mainOwner = new Pool({ connectionString: mainDbUrl(), max: 4 });
  });

  afterAll(async () => {
    await Promise.all([
      adminClient?.end(),
      adminOwner?.end(),
      mainOwner?.end(),
      appPool?.end(),
      procPool?.end(),
    ]);
  });

  beforeEach(() => {
    deliveredBatches.length = 0;
    mockDeliver.mockClear();
    resetSiemModeBannerForTests();
  });

  it('pins the SIEM cursor sentinel the script duplicates (cross-package drift guard)', () => {
    expect(SIEM_CURSOR_INIT_SENTINEL).toBe(CURSOR_INIT_SENTINEL);
  });

  describe('runbook order: processor stopped → backfill → chainer starts → SIEM releases', () => {
    const legacy = buildLegacyChain(5); // r1..r5; r1..r3 shipped pre-flip
    const activity = buildActivityChain(2); // a0 shipped, a1 pending

    beforeAll(async () => {
      await resetBothStores();
      await insertLegacySecurityRows(mainOwner, legacy);
      await insertActivityRows(mainOwner, activity);
      await setCursor(mainOwner, 'security_audit_log', 'r3', legacy[2].timestamp, 3);
      await setCursor(mainOwner, 'activity_logs', 'a0', activity[0].timestamp, 1);

      // "Web still up while the processor is stopped": e6/e7 buffer in ingest.
      await seedIngestRows(appPool, [
        {
          id: 'e6',
          event: { eventType: 'data.read', userId: 'user-6', serviceId: 'web', resourceType: 'page', resourceId: 'p-6', details: { era: 'chainer', n: 6 } },
          timestamp: T(6),
          emittedAt: T(6),
        },
        {
          id: 'e7',
          event: { eventType: 'data.read', userId: 'user-7', serviceId: 'web', resourceType: 'page', resourceId: 'p-7', details: { era: 'chainer', n: 7 } },
          timestamp: T(7),
          emittedAt: T(7),
        },
      ]);
    });

    it("holds the chainer's own advisory lock: a concurrent chainer run no-ops 'lock_busy'", async () => {
      const holder = await adminOwner.connect();
      try {
        await holder.query('SELECT pg_advisory_lock(hashtext($1))', [CHAINER_ADVISORY_LOCK_KEY]);
        const run = await processAuditChainer({ pool: procPool });
        expect(run).toMatchObject({ outcome: 'lock_busy', drained: 0 });
      } finally {
        await holder
          .query('SELECT pg_advisory_unlock(hashtext($1))', [CHAINER_ADVISORY_LOCK_KEY])
          .catch(() => undefined);
        holder.release();
      }
    });

    it('pre-backfill: SIEM seeds cursors, defers security (no error), activity keeps flowing', async () => {
      await processSiemDelivery(workerDeps()); // run 1: seeding only
      expect(mockDeliver).not.toHaveBeenCalled();

      await processSiemDelivery(workerDeps()); // run 2: activity ships, security deferred
      expect(deliveredBatches).toHaveLength(1);
      expect(deliveredBatches[0].map((e) => `${e.source}:${e.id}`)).toEqual(['activity_logs:a1']);

      const sec = await readCursor(procPool, 'security_audit_log');
      expect(sec).toMatchObject({ lastDeliveredId: 'r3', deliveryCount: 3, lastError: null });
    });

    it('the REAL script backfills; the chainer then links the eras with no seq collision', async () => {
      const summary = await runAuditBackfill({ ...backfillDeps(), dryRun: false });
      expect(summary.outcome).toBe('backfilled');
      expect(summary.planted).toBe(5);
      expect(summary.anchorRowId).toBe('r3'); // read from the SEEDED admin cursor
      expect(summary.anchorPlanted).toBe(true);
      expect(summary.journal[summary.journal.length - 1]).toBe('anchor:r3');
      expect(summary.parity).toEqual({ ok: true, failures: [] });
      expect(summary.verification?.isValid).toBe(true);
      expect(summary.verification?.totalEntries).toBe(5);

      // Processor starts: the chainer drains the buffered ingest rows…
      const chained = await processAuditChainer({ pool: procPool });
      expect(chained).toMatchObject({ outcome: 'chained', drained: 2 });
      expect(chained.verification?.valid).toBe(true);

      // …links the emission era onto the BACKFILLED legacy head…
      const boundary = await adminOwner.query(
        `SELECT previous_hash, chain_seq::int AS seq FROM security_audit_log WHERE id = 'e6'`
      );
      expect(boundary.rows[0].previous_hash).toBe(legacy[4].eventHash);

      // …with chain_seq continuing AFTER the legacy range (setval proof).
      expect(boundary.rows[0].seq).toBe(6);
      const e7 = await adminOwner.query(
        `SELECT chain_seq::int AS seq FROM security_audit_log WHERE id = 'e7'`
      );
      expect(e7.rows[0].seq).toBe(7);

      // Full dual-era genesis→head verification over the whole store.
      const verification = await verifySecurityAuditChain(
        { stopOnFirstBreak: true },
        { db: adminClient.db }
      );
      console.log('[flip rehearsal] dual-era genesis→head:', JSON.stringify(verification));
      expect(verification.isValid).toBe(true);
      expect(verification.totalEntries).toBe(7);
      expect(verification.invalidEntries).toBe(0);
    });

    it('SIEM releases the deferral: undelivered legacy then chainer rows, exactly once', async () => {
      await processSiemDelivery(workerDeps());

      expect(deliveredBatches).toHaveLength(1);
      expect(deliveredBatches[0].map((e) => `${e.source}:${e.id}`)).toEqual([
        'security_audit_log:r4',
        'security_audit_log:r5',
        'security_audit_log:e6',
        'security_audit_log:e7',
      ]);
      const sec = await readCursor(procPool, 'security_audit_log');
      expect(sec).toMatchObject({ lastDeliveredId: 'e7', deliveryCount: 7, lastError: null });
    });

    it('an idle rerun delivers nothing — no replays after the flip settles', async () => {
      await processSiemDelivery(workerDeps());
      expect(mockDeliver).not.toHaveBeenCalled();
      const sec = await readCursor(procPool, 'security_audit_log');
      expect(sec).toMatchObject({ lastDeliveredId: 'e7', deliveryCount: 7 });
    });

    it('a script rerun after the flip is idempotent (boundary already linked)', async () => {
      const summary = await runAuditBackfill({ ...backfillDeps(), dryRun: false });
      expect(summary.outcome).toBe('backfilled');
      expect(summary.precondition).toEqual({ ok: true, state: 'boundary_linked' });
      expect(summary.planted).toBe(0);
      expect(summary.parity?.ok).toBe(true);
      expect(summary.verification?.isValid).toBe(true);
      expect(summary.verification?.totalEntries).toBe(7);
    });
  });

  describe('violated order: the chainer ran before the backfill', () => {
    beforeAll(async () => {
      await resetBothStores();
      const legacy = buildLegacyChain(2);
      await insertLegacySecurityRows(mainOwner, legacy);
      await setCursor(mainOwner, 'security_audit_log', 'r1', legacy[0].timestamp, 1);

      await seedIngestRows(appPool, [
        {
          id: 'g1',
          event: { eventType: 'data.read', userId: 'user-g', resourceType: 'page', resourceId: 'p-g1' },
          timestamp: T(60),
          emittedAt: T(60),
        },
      ]);
      const chained = await processAuditChainer({ pool: procPool });
      expect(chained).toMatchObject({ outcome: 'chained', drained: 1 });
    });

    it('the script ABORTS unlinked_emission_era and plants nothing', async () => {
      const summary = await runAuditBackfill({ ...backfillDeps(), dryRun: false });
      expect(summary.outcome).toBe('aborted');
      expect(summary.precondition).toMatchObject({ ok: false, reason: 'unlinked_emission_era' });
      expect(summary.planted).toBe(0);

      const legacyPlanted = await adminOwner.query(
        'SELECT count(*)::int AS n FROM security_audit_log WHERE emission_hash IS NULL'
      );
      expect(legacyPlanted.rows[0].n).toBe(0);
      // The genesis-era chainer row is untouched — remediation is a human call.
      const emissionRows = await adminOwner.query(
        'SELECT count(*)::int AS n FROM security_audit_log WHERE emission_hash IS NOT NULL'
      );
      expect(emissionRows.rows[0].n).toBe(1);
    });
  });
});
