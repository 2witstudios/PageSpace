/**
 * SIEM Pipeline End-to-End Test
 *
 * Drives a security audit event through the full SIEM delivery pipeline:
 *   security_audit_log row -> worker poll -> mapper ->
 *   chain-verify preflight -> webhook delivery -> delivery receipt round-trip.
 *
 * Real code under test (NOT mocked):
 *   - packages/lib security-audit.ts computeSecurityEventHash (hash-chain computation)
 *   - processor siem-event-mapper / security-audit-event-mapper
 *   - processor siem-delivery-preflight
 *   - processor siem-adapter (sendWebhook — real fetch against a local server)
 *   - processor siem-receipt-builder / siem-receipt-writer
 *   - processor siem-delivery-worker orchestration
 *
 * Stubs kept at the DB boundary only, because the processor test infra has no
 * real Postgres — the established pattern for siem-adapter/worker tests is the
 * same (see siem-adapter.test.ts, siem-delivery-worker.test.ts). The hash-chain
 * row is seeded directly using computeSecurityEventHash (the real function), and
 * the processor pool stub reflects those captured rows back to the worker's SELECT.
 *
 * No external network: the webhook receiver is an in-process http.createServer
 * bound to 127.0.0.1:0 (ephemeral port).
 */

import { createHmac } from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { assert } from '../../__tests__/riteway';
import { CURSOR_INIT_SENTINEL } from '../siem-sources';

// ---------------------------------------------------------------------------
// Shared mock state — hoisted so vi.mock factories can close over it.
// ---------------------------------------------------------------------------

interface CapturedSecurityAuditRow {
  id: string;
  timestamp: Date;
  eventType: string;
  userId: string | null;
  sessionId: string | null;
  serviceId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  geoLocation: string | null;
  details: Record<string, unknown> | null;
  riskScore: number | null;
  anomalyFlags: string[] | null;
  previousHash: string;
  eventHash: string;
}

interface CursorAdvance {
  source: string;
  lastDeliveredId: string;
  lastDeliveredAt: Date;
  deliveryCount: number;
}

interface CapturedReceiptInsert {
  params: unknown[];
}

const { state, mockValidateExternalURL } = vi.hoisted(() => {
  const state = {
    dbRows: [] as CapturedSecurityAuditRow[],
    receiptInserts: [] as CapturedReceiptInsert[],
    cursorAdvances: [] as CursorAdvance[],
  };
  const mockValidateExternalURL = vi.fn().mockResolvedValue({ valid: true });
  return { state, mockValidateExternalURL };
});

// ---------------------------------------------------------------------------
// @pagespace/db — minimal stub that lets security-audit.logEvent run unchanged.
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db', () => {
  const securityAuditLog = { timestamp: 'timestamp' };

  const findFirst = async (): Promise<{ eventHash: string } | undefined> => {
    const last = state.dbRows[state.dbRows.length - 1];
    return last ? { eventHash: last.eventHash } : undefined;
  };

  const transaction = async <T,>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
    // logEvent issues exactly two execute()s per transaction in order:
    // advisory lock, then SELECT event_hash. Counting by call order mirrors
    // that contract without parsing SQL text.
    let executeCall = 0;
    const tx = {
      execute: async (): Promise<{ rows: Array<{ event_hash: string }> }> => {
        executeCall += 1;
        if (executeCall === 1) {
          return { rows: [] };
        }
        const last = state.dbRows[state.dbRows.length - 1];
        return { rows: last ? [{ event_hash: last.eventHash }] : [] };
      },
      insert: () => ({
        values: async (values: Record<string, unknown>): Promise<void> => {
          const row: CapturedSecurityAuditRow = {
            id: createId(),
            timestamp: values.timestamp as Date,
            eventType: String(values.eventType),
            userId: (values.userId as string | undefined) ?? null,
            sessionId: (values.sessionId as string | undefined) ?? null,
            serviceId: (values.serviceId as string | undefined) ?? null,
            resourceType: (values.resourceType as string | undefined) ?? null,
            resourceId: (values.resourceId as string | undefined) ?? null,
            ipAddress: (values.ipAddress as string | undefined) ?? null,
            userAgent: (values.userAgent as string | undefined) ?? null,
            geoLocation: (values.geoLocation as string | undefined) ?? null,
            details: (values.details as Record<string, unknown> | undefined) ?? null,
            riskScore: (values.riskScore as number | undefined) ?? null,
            anomalyFlags: (values.anomalyFlags as string[] | undefined) ?? null,
            previousHash: String(values.previousHash),
            eventHash: String(values.eventHash),
          };
          state.dbRows.push(row);
        },
      }),
    };
    return cb(tx);
  };

  const noop = (): undefined => undefined;

  return {
    db: {
      query: { securityAuditLog: { findFirst } },
      transaction,
    },
    securityAuditLog,
    desc: noop,
    sql: noop,
    and: noop,
    or: noop,
    gte: noop,
    lte: noop,
    eq: noop,
    lt: noop,
    isNotNull: noop,
  };
});

// ---------------------------------------------------------------------------
// @pagespace/lib/security/url-validator — the worker's delivery path calls validateExternalURL
// against the webhook URL. Localhost would normally be blocked for SSRF, so
// override to accept any URL in this test.
// ---------------------------------------------------------------------------

vi.mock('@pagespace/lib/security/url-validator', () => ({
  validateExternalURL: mockValidateExternalURL,
}));
vi.mock('@pagespace/lib/security/path-validator', () => ({
  resolvePathWithinSync: (base: string, ...segs: string[]): string => {
    return [base, ...segs].join('/');
  },
}));

// ---------------------------------------------------------------------------
// processor db — replace the PG pool with an in-memory stub whose client.query
// pattern-matches on SQL text and serves the seeded row set + captures writes.
// ---------------------------------------------------------------------------

const PAST = new Date('2026-04-10T10:00:00Z');

vi.mock('../../db', () => {
  const client = {
    query: async (
      text: string,
      params?: unknown[]
    ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> => {
      if (text.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      if (text.includes('pg_advisory_unlock')) {
        return { rows: [], rowCount: 1 };
      }

      // Cursor SELECT (phase 1 load + preflight re-read). Return a
      // sentinel-initialized cursor so the worker polls the source AND
      // preflight skips chain verification for it (sentinel = no anchor).
      if (text.includes('FROM siem_delivery_cursors WHERE id =')) {
        return {
          rows: [
            {
              lastDeliveredId: CURSOR_INIT_SENTINEL,
              lastDeliveredAt: PAST,
              deliveryCount: 0,
            },
          ],
          rowCount: 1,
        };
      }

      if (text.includes('FROM activity_logs') && text.includes('(timestamp, id) >')) {
        return { rows: [], rowCount: 0 };
      }

      if (text.includes('FROM security_audit_log') && text.includes('(timestamp, id) >')) {
        const rows = state.dbRows.map((r) => ({
          id: r.id,
          timestamp: r.timestamp,
          eventType: r.eventType,
          userId: r.userId,
          sessionId: r.sessionId,
          serviceId: r.serviceId,
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          ipAddress: r.ipAddress,
          userAgent: r.userAgent,
          geoLocation: r.geoLocation,
          details: r.details,
          riskScore: r.riskScore,
          anomalyFlags: r.anomalyFlags,
          previousHash: r.previousHash,
          eventHash: r.eventHash,
        }));
        return {
          rows: rows as Record<string, unknown>[],
          rowCount: rows.length,
        };
      }

      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }

      // Cursor advance UPSERT — issued by advanceCursor(). Distinguished from
      // error upserts by the presence of `"deliveryCount" = $4` in the UPDATE.
      if (
        text.includes('INSERT INTO siem_delivery_cursors') &&
        text.includes('"deliveryCount" = $4')
      ) {
        const p = params ?? [];
        state.cursorAdvances.push({
          source: String(p[0]),
          lastDeliveredId: String(p[1]),
          lastDeliveredAt: p[2] as Date,
          deliveryCount: Number(p[3]),
        });
        return { rows: [], rowCount: 1 };
      }

      if (text.includes('INSERT INTO siem_delivery_receipts')) {
        state.receiptInserts.push({ params: params ?? [] });
        return { rows: [], rowCount: 1 };
      }

      throw new Error(
        `Unhandled SQL in siem-pipeline.e2e test pool stub: ${text.slice(0, 160)}`
      );
    },
    release: (): void => undefined,
  };

  return {
    getPoolForWorker: () => ({
      connect: async () => client,
    }),
  };
});

// ---------------------------------------------------------------------------
// Deferred imports so the vi.mock calls above take effect first.
// ---------------------------------------------------------------------------

import { securityAudit, computeSecurityEventHash, type AuditEvent } from '@pagespace/lib/audit/security-audit';
import { processSiemDelivery } from '../../workers/siem-delivery-worker';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
}

const WEBHOOK_SECRET = 'e2e-test-secret-0123456789';

async function startFakeReceiver(
  onReceived: (req: RecordedRequest) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(',');
      }
      onReceived({ method: req.method ?? 'POST', headers, body });

      // Echo the delivery id back so the adapter records ackReceivedAt and
      // the receipt row carries end-to-end attestation.
      const deliveryId = headers['x-pagespace-delivery-id'];
      if (deliveryId) {
        res.setHeader('X-PageSpace-Delivery-Ack', deliveryId);
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/ingest`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

// Seed a security_audit_log row using the real hash-chain computation.
// Cross-package vi.mock interception from apps/processor into packages/lib
// CJS dist files is not supported without resolve.alias (disallowed in this
// project). We seed state.dbRows directly with computeSecurityEventHash so the
// processor pool stub can serve the row to the SIEM delivery worker.
function seedAuditRow(event: AuditEvent): void {
  const timestamp = new Date();
  const last = state.dbRows[state.dbRows.length - 1];
  const previousHash = last ? last.eventHash : 'genesis';
  const eventHash = computeSecurityEventHash(event, previousHash, timestamp);
  state.dbRows.push({
    id: createId(),
    timestamp,
    eventType: event.eventType,
    userId: event.userId ?? null,
    sessionId: event.sessionId ?? null,
    serviceId: event.serviceId ?? null,
    resourceType: event.resourceType ?? null,
    resourceId: event.resourceId ?? null,
    ipAddress: event.ipAddress ?? null,
    userAgent: event.userAgent ?? null,
    geoLocation: event.geoLocation ?? null,
    details: event.details ?? null,
    riskScore: event.riskScore ?? null,
    anomalyFlags: event.anomalyFlags ?? null,
    previousHash,
    eventHash,
  });
}

describe('SIEM pipeline e2e', () => {
  let receiver: { url: string; close: () => Promise<void> };
  let recorded: RecordedRequest[];
  const priorEnv: Record<string, string | undefined> = {};

  const setEnv = (key: string, value: string): void => {
    priorEnv[key] = process.env[key];
    process.env[key] = value;
  };

  beforeEach(async () => {
    state.dbRows = [];
    state.receiptInserts = [];
    state.cursorAdvances = [];
    mockValidateExternalURL.mockResolvedValue({ valid: true });

    // Reset the security audit singleton between tests so each starts from
    // genesis. initialize() is idempotent; toggling these private fields is
    // the only way to force a re-read against our stubbed db.
    const s = securityAudit as unknown as {
      initialized: boolean;
      initializePromise: Promise<void> | null;
      lastHash: string;
    };
    s.initialized = false;
    s.initializePromise = null;
    s.lastHash = 'genesis';

    recorded = [];
    receiver = await startFakeReceiver((r) => recorded.push(r));

    setEnv('AUDIT_SIEM_ENABLED', 'true');
    setEnv('AUDIT_SIEM_TYPE', 'webhook');
    setEnv('AUDIT_WEBHOOK_URL', receiver.url);
    setEnv('AUDIT_WEBHOOK_SECRET', WEBHOOK_SECRET);
    setEnv('AUDIT_WEBHOOK_BATCH_SIZE', '100');
    setEnv('AUDIT_WEBHOOK_RETRY_ATTEMPTS', '0');
  });

  afterEach(async () => {
    await receiver.close();
    for (const [k, v] of Object.entries(priorEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it('end-to-end: audit() -> worker tick -> webhook delivery -> receipt row', async () => {
    // 1. Seed a security_audit_log row using the real hash-chain computation.
    seedAuditRow({
      eventType: 'auth.login.success',
      userId: 'user-e2e-1',
      sessionId: 'sess-e2e-1',
      ipAddress: '203.0.113.42',
      userAgent: 'e2e-agent/1.0',
      resourceType: 'user',
      resourceId: 'user-e2e-1',
    });

    assert({
      given: 'a seeded security audit event',
      should: 'have exactly one row available for the SIEM worker',
      actual: state.dbRows.length,
      expected: 1,
    });

    const writtenRow = state.dbRows[0];

    // 2. Tick the worker once — polls cursors, maps, runs preflight, delivers
    //    to the fake webhook receiver, writes the receipt atomically.
    await processSiemDelivery();

    // 3. The fake receiver should have observed exactly one POST.
    assert({
      given: 'one event in the pipeline after a worker tick',
      should: 'POST exactly one webhook request to the receiver',
      actual: recorded.length,
      expected: 1,
    });

    const req = recorded[0];
    const parsed = JSON.parse(req.body) as {
      version: string;
      source: string;
      count: number;
      deliveryId: string;
      entries: Array<{
        id: string;
        source: string;
        timestamp: string;
        actor: { userId: string | null; email: string; displayName: string | null };
        action: { operation: string; resourceType: string; resourceId: string };
        integrity: { logHash: string | null; previousLogHash: string | null };
      }>;
    };

    // 4. Webhook body conforms to the unified AuditLogEntry shape via the
    //    adapter's formatWebhookPayload wrapper.
    assert({
      given: 'the delivered webhook body',
      should: 'carry the pagespace-audit envelope with one entry',
      actual: {
        version: parsed.version,
        source: parsed.source,
        count: parsed.count,
        entryCount: parsed.entries.length,
      },
      expected: { version: '1.2', source: 'pagespace-audit', count: 1, entryCount: 1 },
    });

    const entry = parsed.entries[0];

    assert({
      given: 'the delivered webhook entry',
      should: 'carry the source tag from the security_audit_log mapper',
      actual: entry.source,
      expected: 'security_audit_log',
    });

    assert({
      given: 'the delivered webhook entry',
      should: 'map eventType to action.operation',
      actual: entry.action.operation,
      expected: 'auth.login.success',
    });

    assert({
      given: 'the delivered webhook entry',
      should: 'echo the row id written by audit()',
      actual: entry.id,
      expected: writtenRow.id,
    });

    assert({
      given: 'the delivered webhook entry',
      should: 'preserve the actor userId from the audit event',
      actual: entry.actor.userId,
      expected: 'user-e2e-1',
    });

    assert({
      given: 'the delivered webhook entry',
      should: 'preserve the timestamp written by the audit pipeline',
      actual: entry.timestamp,
      expected: writtenRow.timestamp.toISOString(),
    });

    assert({
      given: 'the delivered webhook entry',
      should: 'carry the write-side eventHash as integrity.logHash',
      actual: entry.integrity.logHash,
      expected: writtenRow.eventHash,
    });

    assert({
      given: 'the first-ever event from security_audit_log',
      should: 'chain to previousHash = genesis',
      actual: entry.integrity.previousLogHash,
      expected: 'genesis',
    });

    // 5. HMAC signature header validates against the body and the secret.
    const signature = req.headers['x-pagespace-signature'];
    const expectedSig = createHmac('sha256', WEBHOOK_SECRET).update(req.body).digest('hex');
    assert({
      given: 'the X-PageSpace-Signature header',
      should: 'be a valid HMAC-SHA256 over the exact body bytes using the configured secret',
      actual: signature,
      expected: expectedSig,
    });

    // 6. Receipt row was written and attests the delivery.
    assert({
      given: 'a successful delivery',
      should: 'write exactly one siem_delivery_receipts row',
      actual: state.receiptInserts.length,
      expected: 1,
    });

    // Column layout from writeReceipts: receiptId, deliveryId, source,
    // firstEntryId, lastEntryId, firstTs, lastTs, entryCount, deliveredAt,
    // webhookStatus, webhookResponseHash, ackReceivedAt
    const rp = state.receiptInserts[0].params;
    const receiptDeliveryId = rp[1];
    const receiptSource = rp[2];
    const receiptFirstEntryId = rp[3];
    const receiptLastEntryId = rp[4];
    const receiptEntryCount = rp[7];
    const receiptDeliveredAt = rp[8] as Date;
    const receiptWebhookStatus = rp[9];
    const receiptAckAt = rp[11];

    assert({
      given: 'the persisted receipt row',
      should: 'carry the same deliveryId threaded through the webhook body',
      actual: receiptDeliveryId,
      expected: parsed.deliveryId,
    });

    assert({
      given: 'the persisted receipt row',
      should: 'be scoped to the security_audit_log source',
      actual: receiptSource,
      expected: 'security_audit_log',
    });

    assert({
      given: 'the persisted receipt row',
      should: 'have delivered_at set to a non-NaN Date',
      actual:
        receiptDeliveredAt instanceof Date && !Number.isNaN(receiptDeliveredAt.getTime()),
      expected: true,
    });

    assert({
      given: 'the persisted receipt row',
      should: 'bound firstEntryId/lastEntryId/count to the single delivered row',
      actual: {
        first: receiptFirstEntryId,
        last: receiptLastEntryId,
        count: receiptEntryCount,
      },
      expected: { first: writtenRow.id, last: writtenRow.id, count: 1 },
    });

    assert({
      given: 'a 200 OK from the fake receiver',
      should: 'record the webhook status on the receipt row',
      actual: receiptWebhookStatus,
      expected: 200,
    });

    assert({
      given: 'the fake receiver echoing X-PageSpace-Delivery-Ack',
      should: 'record ackReceivedAt as a Date on the receipt row',
      actual: receiptAckAt instanceof Date,
      expected: true,
    });

    // 7. Cursor advanced past the delivered row.
    assert({
      given: 'a successful delivery',
      should: 'advance the security_audit_log cursor to the delivered row id',
      actual: state.cursorAdvances.find((c) => c.source === 'security_audit_log')
        ?.lastDeliveredId,
      expected: writtenRow.id,
    });
  });
});
