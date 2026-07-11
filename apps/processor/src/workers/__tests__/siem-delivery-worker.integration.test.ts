/**
 * Cursor-continuity integration for the SIEM delivery worker across the
 * #890 Phase 2 store flip (leaf 7), wire-connected on scratch Postgres.
 *
 * Two REAL databases on one scratch server play the two planes:
 *   - the admin scratch DB (ADMIN_DATABASE_URL): migrated via migrateAdminDb,
 *     login users provisioned, worker connects AS admin_processor_user
 *     (admin_chainer + admin_siem) — grants proven over the wire;
 *   - a sibling "main" DB holding the LEGACY tables (activity_logs,
 *     security_audit_log, siem_delivery_cursors) with real hash chains.
 *
 * What this proves end to end:
 *   1. First dedicated run SEEDS the admin cursors from the legacy watermark
 *      (exact tuple copy, nothing delivered, legacy cursors untouched).
 *   2. After the backfill plants legacy rows (original ids/timestamps/hashes,
 *      NULL emission_hash, chain_seq preserved) and the chainer appends
 *      new-era rows on top, delivery resumes EXACTLY ONCE: undelivered
 *      legacy rows then chainer rows, chain-preflight passing across the
 *      era boundary — including a pseudonymized row (PII nulled, hash
 *      intact). No replay of already-shipped rows, no gap.
 *   3. An idle rerun re-delivers nothing.
 *   4. Pre-backfill, a seeded cursor whose anchor is still missing from the
 *      admin store DEFERS the security source (no error, cursor pinned)
 *      while activity_logs keeps delivering from main.
 *
 * The receipts table is deliberately NOT created on the main scratch DB: any
 * matrix-violating receipt write fails loudly instead of passing silently.
 *
 * Requires a running scratch Postgres (never the app DB):
 *   docker run --rm -d --name pagespace-admin-smoke -p 55432:5432 \
 *     -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=pagespace_admin postgres:16
 *   ADMIN_DATABASE_URL=postgresql://admin:admin@localhost:55432/pagespace_admin \
 *     bunx vitest run src/workers/__tests__/siem-delivery-worker.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import { migrateAdminDb } from '@pagespace/db/migrate-admin';
import { provisionAdminLoginUsers } from '@pagespace/db/provision-admin-users';
import { computeSecurityEventHash, type AuditEvent } from '@pagespace/lib/audit/security-audit';
import { computeEmissionHash } from '@pagespace/lib/audit/emission-hash';
import { computeLogHash } from '@pagespace/lib/monitoring/activity-logger';

// SIEM adapter: real config/validation types, but delivery is captured
// in-memory — this suite proves DB wiring, not webhook transport (the
// pipeline e2e covers that).
const { deliveredBatches, mockDeliver } = vi.hoisted(() => {
  const deliveredBatches: { id: string; source: string; timestamp: Date }[][] = [];
  const mockDeliver = vi.fn(async (_config: unknown, entries: { id: string; source: string; timestamp: Date }[]) => {
    deliveredBatches.push(entries.map((e) => ({ id: e.id, source: e.source, timestamp: e.timestamp })));
    return {
      success: true,
      entriesDelivered: entries.length,
      webhookStatus: 200,
      responseHash: 'a'.repeat(64),
      ackReceivedAt: new Date(),
    };
  });
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
const MAIN_DB_NAME = 'pagespace_main_siem_it';

const PASSWORDS = {
  ADMIN_APP_PASSWORD: 'appsecretsiemit1',
  ADMIN_PROCESSOR_PASSWORD: 'procsecretsiemit1',
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
      // Exactly representable in float4 — the recompute reads risk_score back
      // from a `real` column and the hash must be byte-identical.
      riskScore: 0.5,
    };
    const timestamp = T(i);
    const eventHash = computeSecurityEventHash(event, prev, timestamp);
    rows.push({ id: `r${i}`, event, timestamp, previousHash: prev, eventHash });
    prev = eventHash;
  }
  return rows;
}

async function insertLegacySecurityRows(pool: PgPool, rows: LegacyRow[], opts: { chainSeqBase?: number } = {}): Promise<void> {
  for (const [idx, r] of rows.entries()) {
    const cols = `id, timestamp, event_type, user_id, session_id, service_id, resource_type,
       resource_id, ip_address, user_agent, geo_location, details, risk_score,
       anomaly_flags, previous_hash, event_hash`;
    const chainSeqCol = opts.chainSeqBase !== undefined ? ', chain_seq' : '';
    const chainSeqParam = opts.chainSeqBase !== undefined ? ', $17' : '';
    const params: unknown[] = [
      r.id,
      r.timestamp,
      r.event.eventType,
      r.event.userId ?? null,
      r.event.sessionId ?? null,
      r.event.serviceId ?? null,
      r.event.resourceType ?? null,
      r.event.resourceId ?? null,
      r.event.ipAddress ?? null,
      r.event.userAgent ?? null,
      r.event.geoLocation ?? null,
      r.event.details ? JSON.stringify(r.event.details) : null,
      r.event.riskScore ?? null,
      r.event.anomalyFlags ?? null,
      r.previousHash,
      r.eventHash,
    ];
    if (opts.chainSeqBase !== undefined) params.push(opts.chainSeqBase + idx + 1);
    await pool.query(
      `INSERT INTO security_audit_log (${cols}${chainSeqCol})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16${chainSeqParam})`,
      params
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
    'SELECT "lastDeliveredId", "lastDeliveredAt", "deliveryCount", "lastError" FROM siem_delivery_cursors WHERE id = $1',
    [source]
  );
  const row = r.rows[0];
  if (!row) return undefined;
  const at = row.lastDeliveredAt;
  return {
    lastDeliveredId: row.lastDeliveredId as string,
    lastDeliveredAt: at instanceof Date ? at : new Date(String(at)),
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

const MAIN_TABLES_DDL = `
  CREATE TABLE activity_logs (
    id text PRIMARY KEY,
    timestamp timestamptz NOT NULL,
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
    timestamp timestamptz NOT NULL,
    event_type text NOT NULL,
    user_id text,
    session_id text,
    service_id text,
    resource_type text,
    resource_id text,
    ip_address text,
    user_agent text,
    geo_location text,
    details jsonb,
    risk_score real,
    anomaly_flags text[],
    previous_hash text NOT NULL,
    event_hash text NOT NULL
  );
  CREATE TABLE siem_delivery_cursors (
    id text PRIMARY KEY,
    "lastDeliveredId" text,
    "lastDeliveredAt" timestamptz,
    "deliveryCount" integer NOT NULL DEFAULT 0,
    "lastError" text,
    "lastErrorAt" timestamptz,
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cursor_pair_check CHECK (("lastDeliveredId" IS NULL) = ("lastDeliveredAt" IS NULL))
  );
`;
// NOTE: siem_delivery_receipts is deliberately ABSENT from the main scratch
// DB — a receipt write routed to main is a matrix violation and must explode.

describe.skipIf(!url)('SIEM delivery worker across the admin store flip (wire-connected)', () => {
  let adminOwner: PgPool;
  let mainOwner: PgPool;
  let appPool: PgPool;
  let procPool: PgPool;

  const workerDeps = () => ({
    mainPool: mainOwner,
    adminPool: procPool,
    env: { ADMIN_DATABASE_URL: url },
  });

  async function resetBothStores(): Promise<void> {
    // Close login pools BEFORE dropping their roles/schema — see recreate below.
    await Promise.all([appPool?.end(), procPool?.end()]);
    // Admin store: same fresh-DB reset as the db package's admin suites.
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

    // Sessions opened before a schema reset hold the DROPPED public schema's
    // OID in their search_path cache and stop seeing the recreated tables —
    // fresh pools per reset.
    appPool = new Pool(loginConfig('admin_app_user', PASSWORDS.ADMIN_APP_PASSWORD));
    procPool = new Pool(loginConfig('admin_processor_user', PASSWORDS.ADMIN_PROCESSOR_PASSWORD));

    // Main (legacy) store: minimal DDL matching the worker's raw SQL.
    await mainOwner.query('DROP TABLE IF EXISTS activity_logs, security_audit_log, siem_delivery_cursors, siem_delivery_receipts');
    await mainOwner.query(MAIN_TABLES_DDL);
  }

  beforeAll(async () => {
    adminOwner = new Pool({ connectionString: url, max: 3 });
    await adminOwner
      .query(`CREATE DATABASE ${MAIN_DB_NAME}`)
      .catch((err: unknown) => {
        if ((err as { code?: string }).code !== '42P04') throw err; // 42P04 = already exists
      });
    mainOwner = new Pool({ connectionString: mainDbUrl(), max: 3 });
    // appPool/procPool are created (and recreated) by resetBothStores.
  });

  afterAll(async () => {
    await Promise.all([adminOwner?.end(), mainOwner?.end(), appPool?.end(), procPool?.end()]);
  });

  beforeEach(() => {
    deliveredBatches.length = 0;
    mockDeliver.mockClear();
    resetSiemModeBannerForTests();
  });

  describe('flip with prompt backfill — exactly-once continuity', () => {
    const legacy = buildLegacyChain(5); // r1..r5, r1..r3 already shipped pre-flip
    const activity = buildActivityChain(2); // a0 shipped, a1 pending

    beforeAll(async () => {
      await resetBothStores();
      await insertLegacySecurityRows(mainOwner, legacy);
      await insertActivityRows(mainOwner, activity);
      await setCursor(mainOwner, 'security_audit_log', 'r3', legacy[2].timestamp, 3);
      await setCursor(mainOwner, 'activity_logs', 'a0', activity[0].timestamp, 1);
    });

    it('run 1 seeds the admin cursors from the legacy watermark and delivers nothing', async () => {
      await processSiemDelivery(workerDeps());

      expect(mockDeliver).not.toHaveBeenCalled();

      const sec = await readCursor(procPool, 'security_audit_log');
      const act = await readCursor(procPool, 'activity_logs');
      expect(sec).toMatchObject({ lastDeliveredId: 'r3', deliveryCount: 3 });
      expect(sec?.lastDeliveredAt.toISOString()).toBe(legacy[2].timestamp.toISOString());
      expect(act).toMatchObject({ lastDeliveredId: 'a0', deliveryCount: 1 });

      // The legacy cursors are untouched — the admin copies are now authoritative.
      const legacySec = await readCursor(mainOwner, 'security_audit_log');
      expect(legacySec).toMatchObject({ lastDeliveredId: 'r3', deliveryCount: 3 });
    });

    it('run 2 (admin security store still empty) ships pending activity from main; receipts land in ADMIN only', async () => {
      await processSiemDelivery(workerDeps());

      expect(deliveredBatches).toHaveLength(1);
      expect(deliveredBatches[0].map((e) => `${e.source}:${e.id}`)).toEqual(['activity_logs:a1']);

      const act = await readCursor(procPool, 'activity_logs');
      expect(act).toMatchObject({ lastDeliveredId: 'a1', deliveryCount: 2, lastError: null });

      // Receipt attestation went to the ADMIN receipts table (the main DB
      // doesn't even have one — a misroute would have thrown).
      const receipts = await adminOwner.query(
        `SELECT source, "firstEntryId", "lastEntryId", "entryCount" FROM siem_delivery_receipts ORDER BY "deliveredAt" DESC`
      );
      expect(receipts.rows).toEqual([
        { source: 'activity_logs', firstEntryId: 'a1', lastEntryId: 'a1', entryCount: 1 },
      ]);

      // Security cursor pinned at the seeded watermark — nothing to ship yet.
      const sec = await readCursor(procPool, 'security_audit_log');
      expect(sec).toMatchObject({ lastDeliveredId: 'r3', deliveryCount: 3, lastError: null });
    });

    it('after backfill + chainer append + pseudonymization, delivery resumes exactly once across the era boundary', async () => {
      // Backfill: plant ALL legacy rows into the admin store — original ids,
      // timestamps, hashes, preserved chain_seq — then align the sequence.
      await insertLegacySecurityRows(adminOwner, legacy, { chainSeqBase: 0 });
      await adminOwner.query(`SELECT setval('security_audit_log_chain_seq_seq', 5)`);

      // Pseudonymize r4 (undelivered!) the way the eraser role does: PII
      // nulled, hash columns untouched. Chain verification and delivery must
      // both survive this (#890 leaf 6 handoff).
      await adminOwner.query(
        `UPDATE security_audit_log SET ip_address = NULL, user_agent = NULL, geo_location = NULL, session_id = NULL WHERE id = 'r4'`
      );

      // New-era events e6, e7 flow through the REAL ingest + chainer.
      const e6: AuditEvent = {
        eventType: 'data.read',
        userId: 'user-6',
        serviceId: 'web',
        resourceType: 'page',
        resourceId: 'p-6',
        details: { era: 'chainer', n: 6 },
      };
      const e7: AuditEvent = {
        eventType: 'data.read',
        userId: 'user-7',
        serviceId: 'web',
        resourceType: 'page',
        resourceId: 'p-7',
        details: { era: 'chainer', n: 7 },
      };
      await seedIngestRows(appPool, [
        { id: 'e6', event: e6, timestamp: T(6), emittedAt: T(6) },
        { id: 'e7', event: e7, timestamp: T(7), emittedAt: T(7) },
      ]);
      const chained = await processAuditChainer({ pool: procPool });
      expect(chained).toMatchObject({ outcome: 'chained', drained: 2 });
      expect(chained.verification?.valid).toBe(true);

      // The chainer linked the new era onto the backfilled legacy head.
      const boundary = await adminOwner.query(
        `SELECT id, previous_hash FROM security_audit_log WHERE id = 'e6'`
      );
      expect(boundary.rows[0].previous_hash).toBe(legacy[4].eventHash);

      await processSiemDelivery(workerDeps());

      // EXACTLY the undelivered rows, in order, exactly once: r4 (erased),
      // r5 (legacy), e6, e7 (chainer era). r1..r3 never replay.
      expect(deliveredBatches).toHaveLength(1);
      expect(deliveredBatches[0].map((e) => `${e.source}:${e.id}`)).toEqual([
        'security_audit_log:r4',
        'security_audit_log:r5',
        'security_audit_log:e6',
        'security_audit_log:e7',
      ]);

      const sec = await readCursor(procPool, 'security_audit_log');
      expect(sec).toMatchObject({ lastDeliveredId: 'e7', deliveryCount: 7, lastError: null });
      expect(sec?.lastDeliveredAt.toISOString()).toBe(T(7).toISOString());

      const receipts = await adminOwner.query(
        `SELECT source, "firstEntryId", "lastEntryId", "entryCount" FROM siem_delivery_receipts WHERE source = 'security_audit_log'`
      );
      expect(receipts.rows).toEqual([
        { source: 'security_audit_log', firstEntryId: 'r4', lastEntryId: 'e7', entryCount: 4 },
      ]);
    });

    it('an idle rerun delivers nothing again — no replays after the flip settles', async () => {
      await processSiemDelivery(workerDeps());

      expect(mockDeliver).not.toHaveBeenCalled();
      const sec = await readCursor(procPool, 'security_audit_log');
      expect(sec).toMatchObject({ lastDeliveredId: 'e7', deliveryCount: 7 });
    });
  });

  describe('pre-backfill deferral — new-era rows exist but the anchor is not planted yet', () => {
    const legacy = buildLegacyChain(3); // r1..r3, r1..r2 shipped pre-flip
    const activity = buildActivityChain(2);

    beforeAll(async () => {
      await resetBothStores();
      await insertLegacySecurityRows(mainOwner, legacy);
      await insertActivityRows(mainOwner, activity);
      await setCursor(mainOwner, 'security_audit_log', 'r2', legacy[1].timestamp, 2);
      await setCursor(mainOwner, 'activity_logs', 'a0', activity[0].timestamp, 1);

      // New-era events land in the admin store BEFORE any backfill ran —
      // the exact transitional window leaf 5 flagged. (Fresh store, so this
      // chain starts at genesis; leaf 8 reconciles the two chains.) The
      // era-fork guard refuses this on upgrades, so simulating the window
      // requires the fresh-install flag (#890 Phase 2 FIX).
      await seedIngestRows(appPool, [
        {
          id: 'g1',
          event: { eventType: 'data.read', userId: 'user-g', resourceType: 'page', resourceId: 'p-g1' } as AuditEvent,
          timestamp: T(60),
          emittedAt: T(60),
        },
      ]);
      process.env.AUDIT_CHAINER_ALLOW_GENESIS = 'true';
      try {
        const chained = await processAuditChainer({ pool: procPool });
        expect(chained).toMatchObject({ outcome: 'chained', drained: 1 });
      } finally {
        delete process.env.AUDIT_CHAINER_ALLOW_GENESIS;
      }
    });

    it('defers the security source (no delivery, no error, cursor pinned) while activity keeps flowing', async () => {
      // Run 1: seeding only.
      await processSiemDelivery(workerDeps());
      expect(mockDeliver).not.toHaveBeenCalled();

      // Run 2: security has a pending admin row (g1) but the anchor r2 is
      // not backfilled — deferral must drop g1 from the batch and let a1 ship.
      await processSiemDelivery(workerDeps());

      expect(deliveredBatches).toHaveLength(1);
      expect(deliveredBatches[0].map((e) => `${e.source}:${e.id}`)).toEqual(['activity_logs:a1']);

      const sec = await readCursor(procPool, 'security_audit_log');
      expect(sec).toMatchObject({
        lastDeliveredId: 'r2',
        deliveryCount: 2,
        // A deferral is an expected deployment state, NOT an error — /health
        // must not go red over it.
        lastError: null,
      });

      const act = await readCursor(procPool, 'activity_logs');
      expect(act).toMatchObject({ lastDeliveredId: 'a1', deliveryCount: 2 });
    });
  });
});
