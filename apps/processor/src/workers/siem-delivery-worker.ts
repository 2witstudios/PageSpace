import { createId } from '@paralleldrive/cuid2';
import {
  loadSiemConfig,
  validateSiemConfig,
  deliverToSiemWithRetry,
  type AuditLogEntry,
  type AuditLogSource,
  type DeliveryErrorClass,
} from '../services/siem-adapter';
import {
  mapActivityLogsToSiemEntries,
  type ActivityLogSiemRow,
} from '../services/siem-event-mapper';
import {
  mapSecurityAuditEventsToSiemEntries,
  type SecurityAuditSiemRow,
} from '../services/security-audit-event-mapper';
import { buildReceipts } from '../services/siem-receipt-builder';
import { writeReceipts } from './siem-receipt-writer';
import { runChainPreflight, type PreflightStores } from './siem-delivery-preflight';
import {
  resolveSiemPoolRouting,
  type SiemStorePlane,
} from '../services/siem-pool-routing';
import { SIEM_SOURCES, CURSOR_INIT_SENTINEL } from '../services/siem-sources';
import { notifyChainPreflightFailure } from '@pagespace/lib/audit/security-audit-alerting';
import { getPoolForWorker, getAdminPoolForWorker } from '../db';

const DEFAULT_BATCH_SIZE = 100;

// One advisory lock guards the whole worker run — not per-source. Key is kept
// as 'activity_logs' for backward compatibility: renaming it would hash to a
// different lock slot, so during a rolling deploy old/new workers would stop
// serializing against each other and could race on cursor upserts. For the
// same reason the lock stays on the MAIN pool even in dedicated mode (see
// siem-pool-routing.ts) — pre-cutover workers only know that lock point, and
// the cutover's cursor seed must happen under the same serialization they
// advance the legacy cursor under.
const ADVISORY_LOCK_KEY = 'activity_logs';

// Stored in siem_delivery_cursors.lastDeliveredId when a cursor is first
// initialized for a new source. The table has a CHECK constraint requiring
// lastDeliveredId and lastDeliveredAt to be both null or both non-null. Phase 7
// of the dual-read plan requires the cursor to plant at NOW() with zero backfill,
// so we need a non-null placeholder until the first real row is delivered. Real
// row ids are cuids and cannot collide with this sentinel.
const ACTIVITY_LOG_COLUMNS = `id, timestamp, "userId", "actorEmail", "actorDisplayName",
        "isAiGenerated", "aiProvider", "aiModel", "aiConversationId",
        operation, "resourceType", "resourceId", "resourceTitle",
        "driveId", "pageId", metadata, "previousLogHash", "logHash"`;

const SECURITY_AUDIT_COLUMNS = `id, timestamp,
        event_type AS "eventType",
        user_id AS "userId",
        session_id AS "sessionId",
        service_id AS "serviceId",
        resource_type AS "resourceType",
        resource_id AS "resourceId",
        ip_address AS "ipAddress",
        user_agent AS "userAgent",
        geo_location AS "geoLocation",
        details,
        risk_score AS "riskScore",
        anomaly_flags AS "anomalyFlags",
        previous_hash AS "previousHash",
        event_hash AS "eventHash"`;

// Minimal subset of pg's PoolClient API that this worker uses — defined
// locally because @types/pg is not installed in this workspace.
interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}

interface PgPoolLike {
  connect(): Promise<PgClient>;
}

/**
 * Injection surface for tests (unit + wire-connected integration). Defaults
 * to the processor's module-level pools and process.env.
 */
export interface SiemDeliveryDeps {
  mainPool?: PgPoolLike;
  adminPool?: PgPoolLike;
  env?: { ADMIN_DATABASE_URL?: string | undefined; ADMIN_DB_BREAK_GLASS?: string | undefined };
}

interface CursorRow {
  lastDeliveredId: string | null;
  lastDeliveredAt: Date | null;
  deliveryCount: number;
}

interface SourceState {
  source: AuditLogSource;
  cursor: CursorRow;
  entries: AuditLogEntry[];
}

// Mode banners fire once per process, mirroring the break-glass observability
// convention from the audit write path (#890 Phase 2 leaf 5). The 30s poll
// cadence would otherwise turn a standing condition into ~2880 log lines/day.
let modeBannerLogged: string | null = null;
export function resetSiemModeBannerForTests(): void {
  modeBannerLogged = null;
}

function logModeBannerOnce(kind: string, line: string, level: 'warn' | 'error'): void {
  if (modeBannerLogged === kind) return;
  modeBannerLogged = kind;
  console[level](line);
}

// pg parses timestamptz to Date under node, but string-typed rows appear in
// some runtimes — same defensive coercion as the mappers and cursor reader.
function toCursorRow(raw: Record<string, unknown>): CursorRow {
  const at = raw.lastDeliveredAt;
  return {
    lastDeliveredId: (raw.lastDeliveredId as string | null) ?? null,
    lastDeliveredAt:
      at === null || at === undefined ? null : at instanceof Date ? at : new Date(String(at)),
    deliveryCount: Number(raw.deliveryCount ?? 0),
  };
}

async function loadCursor(client: PgClient, source: AuditLogSource): Promise<CursorRow | undefined> {
  const result = await client.query(
    'SELECT "lastDeliveredId", "lastDeliveredAt", "deliveryCount" FROM siem_delivery_cursors WHERE id = $1',
    [source]
  );
  return result.rows[0] ? toCursorRow(result.rows[0]) : undefined;
}

async function initCursor(
  client: PgClient,
  source: AuditLogSource,
  plantAt?: Date
): Promise<CursorRow> {
  // Plant the cursor at the DATA store's DB clock, not `new Date()`. If the
  // clock the row timestamps come from runs ahead of the clock we plant at,
  // any rows whose server-side `timestamp` defaults landed between the two
  // nows would be silently skipped on first init — the tuple cursor
  // `(ts, id) > (planted, sentinel)` would exclude them. When cursor store
  // and data store are the same DB, statement_timestamp() inline is exact;
  // when they differ (dedicated mode, activity_logs data on main but cursors
  // on admin) the caller samples the DATA store's statement_timestamp() and
  // passes it as `plantAt`. Read the planted timestamp back via RETURNING so
  // the in-memory cursor and the row actually match.
  //
  // The caller only reaches this path while holding the worker advisory lock
  // AND after seeing `loadCursor` return either no row or a row with null
  // cursor fields (an error-only row from `recordError`). Under the lock both
  // conditions imply we're the unique writer, so DO UPDATE unconditionally
  // overwrites the planted state without clobbering progress that isn't
  // there.
  const plantedExpr = plantAt ? '$3' : 'statement_timestamp()';
  const params: unknown[] = plantAt
    ? [source, CURSOR_INIT_SENTINEL, plantAt]
    : [source, CURSOR_INIT_SENTINEL];
  const result = await client.query(
    `INSERT INTO siem_delivery_cursors (id, "lastDeliveredId", "lastDeliveredAt", "deliveryCount", "lastError", "lastErrorAt", "updatedAt")
     VALUES ($1, $2, ${plantedExpr}, 0, NULL, NULL, NOW())
     ON CONFLICT (id) DO UPDATE SET
       "lastDeliveredId" = EXCLUDED."lastDeliveredId",
       "lastDeliveredAt" = EXCLUDED."lastDeliveredAt",
       "deliveryCount" = 0,
       "lastError" = NULL,
       "lastErrorAt" = NULL,
       "updatedAt" = NOW()
     RETURNING "lastDeliveredId", "lastDeliveredAt", "deliveryCount"`,
    params
  );
  const row = toCursorRow(result.rows[0]);
  console.log(
    `[siem-delivery] Initialized cursor for source=${source} at ${row.lastDeliveredAt?.toISOString()} (no backfill)`
  );
  return row;
}

/**
 * One-time cursor migration at the store flip (#890 Phase 2 leaf 7): copy an
 * INITIALIZED legacy cursor tuple from the main DB into the admin cursors
 * table, preserving the exact (lastDeliveredAt, lastDeliveredId) watermark
 * and deliveryCount. Runs under the shared main-pool advisory lock — the
 * same lock pre-cutover workers advance the legacy cursor under — so the
 * seeded watermark is the legacy store's final word, not a racing snapshot.
 * Guarded: only invoked when the admin-side cursor is missing/uninitialized,
 * so re-runs and restarts are no-ops.
 */
async function seedCursorFromLegacy(
  client: PgClient,
  source: AuditLogSource,
  legacy: CursorRow
): Promise<CursorRow> {
  const result = await client.query(
    `INSERT INTO siem_delivery_cursors (id, "lastDeliveredId", "lastDeliveredAt", "deliveryCount", "lastError", "lastErrorAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NULL, NULL, NOW())
     ON CONFLICT (id) DO UPDATE SET
       "lastDeliveredId" = EXCLUDED."lastDeliveredId",
       "lastDeliveredAt" = EXCLUDED."lastDeliveredAt",
       "deliveryCount" = EXCLUDED."deliveryCount",
       "lastError" = NULL,
       "lastErrorAt" = NULL,
       "updatedAt" = NOW()
     RETURNING "lastDeliveredId", "lastDeliveredAt", "deliveryCount"`,
    [source, legacy.lastDeliveredId, legacy.lastDeliveredAt, legacy.deliveryCount]
  );
  const row = toCursorRow(result.rows[0]);
  console.log(
    `[siem-delivery] Seeded cursor for source=${source} from legacy store at ${row.lastDeliveredAt?.toISOString()} (id=${row.lastDeliveredId}, deliveryCount=${row.deliveryCount})`
  );
  return row;
}

async function queryActivityLogs(
  client: PgClient,
  afterTimestamp: Date,
  afterId: string,
  batchSize: number
): Promise<AuditLogEntry[]> {
  // Tuple cursor: (timestamp, id) > (lastDeliveredAt, lastDeliveredId).
  // Strict timestamp > would silently drop rows that share a microsecond with
  // the last delivered row — possible under load when multiple transactions
  // commit in the same microsecond. CUID2 ids sort lexicographically, which is
  // sufficient as a tie-breaker (we don't need them to be time-ordered, only
  // to give same-timestamp rows a stable order).
  const result = await client.query(
    `SELECT ${ACTIVITY_LOG_COLUMNS}
     FROM activity_logs
     WHERE (timestamp, id) > ($1, $2)
     ORDER BY timestamp ASC, id ASC
     LIMIT $3`,
    [afterTimestamp, afterId, batchSize]
  );
  return mapActivityLogsToSiemEntries(result.rows as unknown as ActivityLogSiemRow[]);
}

async function querySecurityAuditLog(
  client: PgClient,
  afterTimestamp: Date,
  afterId: string,
  batchSize: number
): Promise<AuditLogEntry[]> {
  const result = await client.query(
    `SELECT ${SECURITY_AUDIT_COLUMNS}
     FROM security_audit_log
     WHERE (timestamp, id) > ($1, $2)
     ORDER BY timestamp ASC, id ASC
     LIMIT $3`,
    [afterTimestamp, afterId, batchSize]
  );
  return mapSecurityAuditEventsToSiemEntries(result.rows as unknown as SecurityAuditSiemRow[]);
}

async function queryRowsForSource(
  client: PgClient,
  source: AuditLogSource,
  afterTimestamp: Date,
  afterId: string,
  batchSize: number
): Promise<AuditLogEntry[]> {
  if (source === 'activity_logs') {
    return queryActivityLogs(client, afterTimestamp, afterId, batchSize);
  }
  return querySecurityAuditLog(client, afterTimestamp, afterId, batchSize);
}

// The persisted `lastError` is deliberately typed as DeliveryErrorClass, not a
// free-text string. This makes it a compile-time error to write a raw webhook
// response body (or any customer-controlled text) into the column that the
// unauthenticated /health endpoint surfaces. Full error detail is retained in
// the processor's stdout logs at each call site for operator triage. See #989.
async function recordError(
  client: PgClient,
  source: AuditLogSource,
  errorClass: DeliveryErrorClass
): Promise<void> {
  await client.query(
    `INSERT INTO siem_delivery_cursors (id, "lastError", "lastErrorAt", "updatedAt")
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       "lastError" = $2,
       "lastErrorAt" = NOW(),
       "updatedAt" = NOW()`,
    [source, errorClass]
  );
}

async function advanceCursor(
  client: PgClient,
  source: AuditLogSource,
  lastDeliveredId: string,
  lastDeliveredAt: Date,
  newDeliveryCount: number
): Promise<void> {
  await client.query(
    `INSERT INTO siem_delivery_cursors (id, "lastDeliveredId", "lastDeliveredAt", "deliveryCount", "lastError", "lastErrorAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NULL, NULL, NOW())
     ON CONFLICT (id) DO UPDATE SET
       "lastDeliveredId" = $2,
       "lastDeliveredAt" = $3,
       "deliveryCount" = $4,
       "lastError" = NULL,
       "lastErrorAt" = NULL,
       "updatedAt" = NOW()`,
    [source, lastDeliveredId, lastDeliveredAt, newDeliveryCount]
  );
}

/**
 * SIEM delivery worker — polls every configured audit source for new entries,
 * interleaves them by timestamp, and delivers a single unified batch to the
 * configured SIEM endpoint via the existing siem-adapter.
 *
 * Post-cutover (#890 Phase 2) the worker straddles two stores per the
 * pool-per-operation matrix in services/siem-pool-routing.ts:
 * security_audit_log data (and its preflight loads) come from the Admin PG,
 * activity_logs data stays on main until Phase 5, and the worker's own state
 * (cursors + receipts, BOTH sources) lives in the Admin PG. The advisory
 * lock stays on main so old and new workers serialize across a rolling
 * deploy.
 *
 * Scheduled by pg-boss every 30s. Expected max duration: ~4 minutes
 * (3 retries x 60s backoff cap + network time). The schedule uses
 * retryLimit: 0 so overlapping runs won't stack, and a single advisory lock
 * keeps overlapping invocations serialized across every source.
 */
export async function processSiemDelivery(deps: SiemDeliveryDeps = {}): Promise<void> {
  const config = loadSiemConfig();

  if (!config.enabled) {
    return;
  }

  const validation = validateSiemConfig(config);
  if (!validation.valid) {
    console.warn('[siem-delivery] Invalid config:', validation.errors.join(', '));
    return;
  }

  const env = deps.env ?? {
    ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL,
    ADMIN_DB_BREAK_GLASS: process.env.ADMIN_DB_BREAK_GLASS,
  };
  const { decision, routing } = resolveSiemPoolRouting(env);
  if (routing === null) {
    // 'fail' — the trust plane is misconfigured and audit writes are being
    // rejected. Neither store can be trusted as THE source, so delivering
    // from either would be guessing; halt loudly instead. Nothing is lost:
    // cursors don't move, and delivery resumes where it left off once the
    // Admin PG is configured (or break-glass is armed).
    logModeBannerOnce(
      'fail',
      `[siem-delivery] Admin DB mode 'fail' — SIEM delivery halted. ${decision.reason ?? ''}`,
      'error'
    );
    return;
  }
  if (routing.mode === 'break-glass') {
    logModeBannerOnce(
      'break-glass',
      '[siem-delivery] Admin DB break-glass armed — delivering from the LEGACY main-db stores (cursors, receipts, and both sources on main)',
      'warn'
    );
  }

  const mainPool = deps.mainPool ?? getPoolForWorker();
  const mainClient = await mainPool.connect();
  // Connected lazily AFTER the advisory lock so lock-busy runs don't burn an
  // admin connection. Null in break-glass mode (routing sends nothing there).
  let adminClient: PgClient | null = null;
  const clientFor = (plane: SiemStorePlane): PgClient =>
    plane === 'admin' && adminClient !== null ? adminClient : mainClient;
  // Cursor writes must survive errors thrown before the admin client exists;
  // resolved to the routed client once connected.
  let cursorClient: PgClient | null = null;
  let lockAcquired = false;

  try {
    const lockResult = await mainClient.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [ADVISORY_LOCK_KEY]
    );
    lockAcquired = Boolean(lockResult.rows[0]?.acquired);

    if (!lockAcquired) {
      return;
    }

    if (routing.mode === 'dedicated') {
      const adminPool = deps.adminPool ?? getAdminPoolForWorker();
      adminClient = await adminPool.connect();
    }
    cursorClient = clientFor(routing.cursors);

    const batchSize = config.webhook?.batchSize ?? DEFAULT_BATCH_SIZE;

    // Phase 1: load (or initialize) each source's cursor and query its new rows.
    // Cursor queries use a (timestamp, id) tuple so that rows sharing a
    // microsecond with the last delivered row are still picked up. CUID ids
    // are not time-monotonic, but they sort lexicographically and that is all
    // we need from them as a tie-breaker — same-timestamp rows just need
    // *some* stable order so neither side gets dropped.
    const states: SourceState[] = [];
    for (const source of SIEM_SOURCES) {
      const dataClient = clientFor(routing.data[source]);
      let cursor = await loadCursor(cursorClient, source);

      // Treat a null-timestamp row as uninitialized. The schema CHECK constraint
      // permits (lastDeliveredId, lastDeliveredAt) = (null, null), and the
      // recordError() insert path can create exactly that state if an error
      // fires before the cursor was ever initialized. Without this branch the
      // worker would skip the source forever on the next run. Re-initializing
      // is safe — we lose at most a handful of seconds' worth of events that
      // arrived during the failure window, which is the same exposure as a
      // brand-new source per Phase 7's no-backfill rule.
      if (!cursor || !cursor.lastDeliveredAt || !cursor.lastDeliveredId) {
        // Cutover seed: before planting a fresh NOW() cursor, adopt the
        // legacy main-db cursor if one was ever initialized — the watermark
        // must survive the store flip so already-shipped rows never replay
        // and not-yet-shipped legacy rows still deliver (via the backfill).
        const legacy = routing.seedCursorFromLegacy ? await loadCursor(mainClient, source) : undefined;
        if (legacy && legacy.lastDeliveredAt && legacy.lastDeliveredId) {
          cursor = await seedCursorFromLegacy(cursorClient, source, legacy);
          // Same contract as a fresh init: deliver nothing on the seeding
          // run. The next poll (30s) starts from the seeded watermark.
          states.push({ source, cursor, entries: [] });
          continue;
        }

        // Phase 7: plant cursor at NOW() and deliver zero historical rows.
        // Backfilling would break temporal audit semantics (customers would
        // see events from months ago appearing today). When the cursor store
        // and the data store are different DBs, sample the DATA store's
        // clock for the plant (see initCursor).
        if (routing.data[source] === routing.cursors) {
          cursor = await initCursor(cursorClient, source);
        } else {
          const clockResult = await dataClient.query('SELECT statement_timestamp() AS now');
          const rawNow = clockResult.rows[0]?.now;
          const plantAt = rawNow instanceof Date ? rawNow : new Date(String(rawNow));
          cursor = await initCursor(cursorClient, source, plantAt);
        }
        states.push({ source, cursor, entries: [] });
        continue;
      }

      const entries = await queryRowsForSource(
        dataClient,
        source,
        cursor.lastDeliveredAt,
        cursor.lastDeliveredId,
        batchSize
      );
      states.push({ source, cursor, entries });
    }

    // Phase 2a: compute a safety watermark so a skewed backlog in one source
    // doesn't cause out-of-order cross-source delivery across runs. If source A
    // has 10k old rows (Jan) and source B has 5 new rows (Apr), polling each
    // with LIMIT=batchSize returns A's oldest 100 + all 5 of B's. Naively
    // merging and shipping would send the 5 Apr rows while 9900 Jan rows from
    // A are still in the queue — a future run would then ship Jan rows AFTER
    // Apr rows, violating global chronological order. The fix: if any source
    // returned a full batch (meaning "more rows may exist after this tail"),
    // only ship rows with timestamp <= min(backlogged-tail-timestamps). Rows
    // from other sources past that watermark wait until the next run, when
    // the backlogged source's cursor has advanced. A source that returned
    // fewer than batchSize rows is fully drained, contributes no bound, and
    // its rows are free to ship unconditionally.
    const backloggedTails = states
      .filter((s) => s.entries.length === batchSize)
      .map((s) => s.entries[s.entries.length - 1].timestamp);

    const safeUntil =
      backloggedTails.length > 0
        ? new Date(Math.min(...backloggedTails.map((d) => d.getTime())))
        : null;

    // Phase 2b: interleave by timestamp. Preserving global temporal ordering
    // across sources is critical for SIEM correctness — a receiver that sees
    // a login after the resource access it authorized would flag false anomalies.
    const allEntries = states
      .flatMap((s) => s.entries)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    let merged = safeUntil
      ? allEntries.filter((e) => e.timestamp.getTime() <= safeUntil.getTime())
      : allEntries;

    if (merged.length === 0) {
      // Idle poll — no log line. The worker runs every 30s and the vast
      // majority of cycles are idle; logging here would emit ~2880 no-op
      // lines per day per instance.
      return;
    }

    const pollCounts = states.map((s) => `${s.source}=${s.entries.length}`).join(', ');
    console.log(`[siem-delivery] Polled ${pollCounts} rows`);

    // Phase 2c: chain verification preflight. Before any batch leaves the
    // system we re-verify the hash chain for every source represented in
    // `merged`. If any source is tampered with, we halt the ENTIRE run —
    // not just the offending source — because an operator needs to see the
    // whole picture before letting events flow again. Cursors stay put on
    // halt (including the clean source's cursor) so the operator has a
    // stable state to investigate, and a single alert fires via the
    // existing webhook surface (#854).
    //
    // Sources whose cursor is still at CURSOR_INIT_SENTINEL have no anchor
    // hash to compare against — they're skipped for this run and start
    // being verified from the next run forward. See loadAnchorHash for the
    // null-anchor contract.
    //
    // Anchor + hashable fields are loaded from the DB here rather than
    // carried on AuditLogEntry because (a) the activity_logs mapper drops
    // contentSnapshot/previousValues/newValues, which the write-side hash
    // includes, and (b) the security_audit_log mapper folds fields into
    // metadata and substitutes defaults for null resourceType/resourceId,
    // which would corrupt recomputation. Loading the raw DB subset keeps
    // both mappers untouched.
    const preflightStores: PreflightStores = {
      cursors: cursorClient,
      activityData: clientFor(routing.data.activity_logs),
      securityData: clientFor(routing.data.security_audit_log),
      securityPlane: routing.data.security_audit_log,
      legacySecurityStore: routing.awaitingBackfillProbe ? mainClient : null,
    };
    let preflightResult = await runChainPreflight(preflightStores, merged);

    if (preflightResult !== null && preflightResult.kind === 'awaiting_backfill') {
      // Transitional cutover window (#890 Phase 2 leaves 7+8): the seeded
      // cursor's anchor row hasn't been backfilled into the admin store yet.
      // Defer ONLY this source — its cursor stays put so nothing is lost or
      // replayed — and keep the other sources flowing. NOT recorded as a
      // cursor error: an expected deployment state must not page anyone or
      // trip /health.
      const deferred = preflightResult;
      console.log(
        `[siem-delivery] Deferring source=${deferred.source} — cursor anchor ${deferred.anchorId} not yet backfilled into the admin store`
      );
      merged = merged.filter((e) => e.source !== deferred.source);
      preflightResult = null;
      if (merged.length === 0) {
        return;
      }
    }

    if (preflightResult !== null && preflightResult.kind === 'db_error') {
      // Preflight couldn't even load the data needed to verify. Halt
      // delivery and surface the error on the affected source's cursor,
      // but do NOT fire the chain verification webhook — a transient DB
      // failure is not tamper, and a false tamper page erodes the
      // alert's credibility. The next poll cycle will retry naturally.
      await recordError(cursorClient, preflightResult.source, 'preflight_unavailable');
      console.warn(
        `[siem-delivery] Chain preflight data unavailable source=${preflightResult.source}: ${preflightResult.message}`
      );
      return;
    }

    if (preflightResult !== null && preflightResult.kind === 'tamper') {
      const halt = preflightResult;
      // /health only ever shows the safe 'chain_tamper' class. The full
      // forensic detail (index, reason, expected/actual hashes) stays in the
      // operator-only channels below: the structured console.error line and
      // the notifyChainPreflightFailure alert. Hashes are internally computed,
      // not customer-controlled, but there is no reason to widen the
      // unauthenticated /health surface with them.
      const hashDetail = [
        halt.expectedHash !== null ? `expected=${halt.expectedHash}` : null,
        halt.actualHash !== null ? `actual=${halt.actualHash}` : null,
      ]
        .filter((s): s is string => s !== null)
        .join(' ');

      await recordError(cursorClient, halt.source, 'chain_tamper');

      // Fire the existing chain verification webhook. notifyChainPreflightFailure
      // swallows alert-handler errors internally, but we still wrap the call
      // defensively — a broken alert surface must NEVER mask tamper detection
      // or drop the lock-release in the finally. The tamper-error write has
      // already been made above, so /health already shows the failure.
      const sourceBatchTotalEntries = merged.filter(
        (e) => e.source === halt.source
      ).length;
      try {
        await notifyChainPreflightFailure({
          auditSource: halt.source,
          entryId: halt.entryId,
          breakAtIndex: halt.breakAtIndex,
          breakReason: halt.breakReason,
          expectedHash: halt.expectedHash,
          actualHash: halt.actualHash,
          sourceBatchTotalEntries,
        });
      } catch (alertError) {
        const msg = alertError instanceof Error ? alertError.message : String(alertError);
        console.warn(`[siem-delivery] Chain verification alert failed: ${msg}`);
      }

      console.error(
        `[siem-delivery] CHAIN TAMPER DETECTED source=${halt.source} index=${halt.breakAtIndex} reason=${halt.breakReason} entry=${halt.entryId}${hashDetail ? ` ${hashDetail}` : ''}`
      );
      return;
    }

    // Phase 3: single delivery call for the merged, time-ordered batch.
    // deliveryId is generated ONCE per worker run and reused across any
    // retries the adapter performs internally — same logical delivery → same
    // id → one row per source in siem_delivery_receipts, not one per network
    // attempt. The receiver may also use this id for its own de-duplication.
    const deliveryId = createId();
    const result = await deliverToSiemWithRetry(config, merged, deliveryId);

    // Phase 4: walk the delivered prefix and track per-source progress. The
    // adapter reports entriesDelivered as the count of the merged batch that
    // made it through — because entries are interleaved, a single source may
    // advance over a non-contiguous sub-slice of its own rows, but each source's
    // OWN rows remain in timestamp order inside that prefix.
    const delivered = merged.slice(0, result.entriesDelivered);
    const perSourceLastDelivered = new Map<AuditLogSource, AuditLogEntry>();
    const perSourceDeliveredCount = new Map<AuditLogSource, number>();
    for (const entry of delivered) {
      perSourceLastDelivered.set(entry.source, entry);
      perSourceDeliveredCount.set(
        entry.source,
        (perSourceDeliveredCount.get(entry.source) ?? 0) + 1
      );
    }

    // Phase 5 + 5b: advance cursors AND write per-source receipts atomically.
    //
    // The cursor upsert and the receipt INSERT must commit or roll back
    // together. If the cursor advanced but the receipt write failed, the
    // worker would mark events as delivered while leaving no attestation
    // row — `/siem/receipts` would return a false negative for data that
    // already shipped. Wrapping both writes in a single BEGIN/COMMIT closes
    // that window: on rollback the cursor stays put and the next run
    // re-delivers the same events with a fresh deliveryId, which the
    // receiver de-dupes via its own idempotency key. A missing receipt is
    // never a correctness failure; an advanced cursor without a receipt
    // would be.
    //
    // Both writes target the cursors/receipts store (Admin PG in dedicated
    // mode), so the transaction never spans databases.
    //
    // Sources with zero progress keep their cursor exactly where it was —
    // the loop body is a no-op for them.
    if (delivered.length > 0) {
      await cursorClient.query('BEGIN');
      try {
        for (const state of states) {
          const lastDelivered = perSourceLastDelivered.get(state.source);
          if (!lastDelivered) continue;

          const count = perSourceDeliveredCount.get(state.source) ?? 0;
          const newCount = state.cursor.deliveryCount + count;
          await advanceCursor(
            cursorClient,
            state.source,
            lastDelivered.id,
            lastDelivered.timestamp,
            newCount
          );
        }

        // buildReceipts groups by source, so a single dual-source delivery
        // yields up to one receipt per source — every receipt sharing this
        // run's deliveryId.
        const receipts = buildReceipts({
          deliveryId,
          deliveredAt: new Date(),
          webhookStatus: result.webhookStatus ?? null,
          webhookResponseHash: result.responseHash ?? null,
          ackReceivedAt: result.ackReceivedAt ?? null,
          deliveredEntries: delivered,
        });
        if (receipts.length > 0) {
          await writeReceipts(clientFor(routing.receipts), receipts);
        }

        await cursorClient.query('COMMIT');
      } catch (txnError) {
        // Rollback before rethrowing so the catch block above doesn't
        // observe an open transaction. `.catch` swallows the rollback
        // failure deliberately — the original error is what matters.
        await cursorClient.query('ROLLBACK').catch(() => undefined);
        throw txnError;
      }
    }

    // Phase 6: result logging + failure handling.
    if (result.success) {
      const breakdown =
        Array.from(perSourceDeliveredCount.entries())
          .map(([src, n]) => `${n} from ${src}`)
          .join(', ') || 'none';
      console.log(
        `[siem-delivery] Delivered ${result.entriesDelivered} entries (${breakdown})`
      );
    } else {
      // A unified delivery failure means both sources are blocked on the same
      // network/webhook issue, so record the error on every source cursor. The
      // error write runs after the cursor advance above, so sources that made
      // partial progress still show lastError in /health.
      const errorMessage = result.error ?? 'Unknown delivery error';
      const errorClass = result.errorClass ?? 'internal_error';
      for (const source of SIEM_SOURCES) {
        await recordError(cursorClient, source, errorClass);
      }
      const partial =
        result.entriesDelivered > 0
          ? ` (${result.entriesDelivered} entries delivered before failure)`
          : '';
      // Raw error text (may embed the receiver's response body) stays in the
      // operator-only log; only `errorClass` was persisted to the cursor above.
      console.error(`[siem-delivery] Delivery failed [${errorClass}]: ${errorMessage}${partial}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    try {
      // cursorClient is null only when the failure happened before the
      // cursor store was reachable (e.g. admin connect failed) — there is
      // no cursor row to annotate in that case, the log line below is the
      // only surface.
      if (cursorClient !== null) {
        for (const source of SIEM_SOURCES) {
          await recordError(cursorClient, source, 'internal_error');
        }
      }
    } catch {
      // best-effort only — don't mask the original error
    }

    // Persist only the safe class; the raw message (which may include internal
    // detail) stays in the operator-only log.
    console.error('[siem-delivery] Worker error:', message);
    throw error;
  } finally {
    if (lockAcquired) {
      await mainClient
        .query('SELECT pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK_KEY])
        .catch(() => undefined);
    }
    if (adminClient !== null) {
      adminClient.release();
    }
    mainClient.release();
  }
}
