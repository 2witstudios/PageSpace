import {
  loadSiemConfig,
  validateSiemConfig,
  deliverToSiemWithRetry,
  type AuditLogEntry,
  type AuditLogSource,
} from '../services/siem-adapter';
import {
  mapActivityLogsToSiemEntries,
  type ActivityLogSiemRow,
} from '../services/siem-event-mapper';
import {
  mapSecurityAuditEventsToSiemEntries,
  type SecurityAuditSiemRow,
} from '../services/security-audit-event-mapper';
import { getPoolForWorker } from '../db';

export const SOURCES: readonly AuditLogSource[] = ['activity_logs', 'security_audit_log'] as const;
const DEFAULT_BATCH_SIZE = 100;

// One advisory lock guards the whole worker run — not per-source. Key is kept
// as 'activity_logs' for backward compatibility: renaming it would hash to a
// different lock slot, so during a rolling deploy old/new workers would stop
// serializing against each other and could race on cursor upserts.
const ADVISORY_LOCK_KEY = 'activity_logs';

// Stored in siem_delivery_cursors.lastDeliveredId when a cursor is first
// initialized for a new source. The table has a CHECK constraint requiring
// lastDeliveredId and lastDeliveredAt to be both null or both non-null. Phase 7
// of the dual-read plan requires the cursor to plant at NOW() with zero backfill,
// so we need a non-null placeholder until the first real row is delivered. Real
// row ids are cuids and cannot collide with this sentinel.
const CURSOR_INIT_SENTINEL = '__cursor_init__';

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

async function loadCursor(client: PgClient, source: AuditLogSource): Promise<CursorRow | undefined> {
  const result = await client.query(
    'SELECT "lastDeliveredId", "lastDeliveredAt", "deliveryCount" FROM siem_delivery_cursors WHERE id = $1',
    [source]
  );
  return result.rows[0] as unknown as CursorRow | undefined;
}

async function initCursor(client: PgClient, source: AuditLogSource): Promise<CursorRow> {
  // Plant the cursor at the DATABASE clock, not `new Date()`. If the worker
  // host clock runs ahead of Postgres, any rows whose server-side `timestamp`
  // defaults landed between DB-now and app-now would be silently skipped on
  // first init — the tuple cursor `(ts, id) > (app-now, sentinel)` would
  // exclude them. Read the planted timestamp back via RETURNING so the
  // in-memory cursor and the row actually match.
  //
  // The caller only reaches this path while holding the worker advisory lock
  // AND after seeing `loadCursor` return either no row or a row with null
  // cursor fields (an error-only row from `recordError`). Under the lock both
  // conditions imply we're the unique writer, so DO UPDATE unconditionally
  // overwrites the planted state without clobbering progress that isn't
  // there.
  const result = await client.query(
    `INSERT INTO siem_delivery_cursors (id, "lastDeliveredId", "lastDeliveredAt", "deliveryCount", "lastError", "lastErrorAt", "updatedAt")
     VALUES ($1, $2, statement_timestamp(), 0, NULL, NULL, NOW())
     ON CONFLICT (id) DO UPDATE SET
       "lastDeliveredId" = EXCLUDED."lastDeliveredId",
       "lastDeliveredAt" = EXCLUDED."lastDeliveredAt",
       "deliveryCount" = 0,
       "lastError" = NULL,
       "lastErrorAt" = NULL,
       "updatedAt" = NOW()
     RETURNING "lastDeliveredId", "lastDeliveredAt", "deliveryCount"`,
    [source, CURSOR_INIT_SENTINEL]
  );
  const row = result.rows[0] as unknown as CursorRow;
  console.log(
    `[siem-delivery] Initialized cursor for source=${source} at ${row.lastDeliveredAt?.toISOString()} (no backfill)`
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

async function recordError(
  client: PgClient,
  source: AuditLogSource,
  message: string
): Promise<void> {
  await client.query(
    `INSERT INTO siem_delivery_cursors (id, "lastError", "lastErrorAt", "updatedAt")
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       "lastError" = $2,
       "lastErrorAt" = NOW(),
       "updatedAt" = NOW()`,
    [source, message]
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
 * Scheduled by pg-boss every 30s. Expected max duration: ~4 minutes
 * (3 retries x 60s backoff cap + network time). The schedule uses
 * retryLimit: 0 so overlapping runs won't stack, and a single advisory lock
 * keeps overlapping invocations serialized across every source.
 */
export async function processSiemDelivery(): Promise<void> {
  const config = loadSiemConfig();

  if (!config.enabled) {
    return;
  }

  const validation = validateSiemConfig(config);
  if (!validation.valid) {
    console.warn('[siem-delivery] Invalid config:', validation.errors.join(', '));
    return;
  }

  const pool = getPoolForWorker();
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    const lockResult = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [ADVISORY_LOCK_KEY]
    );
    lockAcquired = Boolean(lockResult.rows[0]?.acquired);

    if (!lockAcquired) {
      return;
    }

    const batchSize = config.webhook?.batchSize ?? DEFAULT_BATCH_SIZE;

    // Phase 1: load (or initialize) each source's cursor and query its new rows.
    // Cursor queries use a (timestamp, id) tuple so that rows sharing a
    // microsecond with the last delivered row are still picked up. CUID ids
    // are not time-monotonic, but they sort lexicographically and that is all
    // we need from them as a tie-breaker — same-timestamp rows just need
    // *some* stable order so neither side gets dropped.
    const states: SourceState[] = [];
    for (const source of SOURCES) {
      let cursor = await loadCursor(client, source);

      // Treat a null-timestamp row as uninitialized. The schema CHECK constraint
      // permits (lastDeliveredId, lastDeliveredAt) = (null, null), and the
      // recordError() insert path can create exactly that state if an error
      // fires before the cursor was ever initialized. Without this branch the
      // worker would skip the source forever on the next run. Re-initializing
      // is safe — we lose at most a handful of seconds' worth of events that
      // arrived during the failure window, which is the same exposure as a
      // brand-new source per Phase 7's no-backfill rule.
      if (!cursor || !cursor.lastDeliveredAt || !cursor.lastDeliveredId) {
        // Phase 7: plant cursor at NOW() and deliver zero historical rows.
        // Backfilling would break temporal audit semantics (customers would
        // see events from months ago appearing today).
        cursor = await initCursor(client, source);
        states.push({ source, cursor, entries: [] });
        continue;
      }

      const entries = await queryRowsForSource(
        client,
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

    const merged = safeUntil
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

    // Phase 3: single delivery call for the merged, time-ordered batch.
    const result = await deliverToSiemWithRetry(config, merged);

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

    // Phase 5: advance cursors for sources whose entries were actually delivered.
    // Sources with zero progress keep their cursor exactly where it was.
    for (const state of states) {
      const lastDelivered = perSourceLastDelivered.get(state.source);
      if (!lastDelivered) continue;

      const count = perSourceDeliveredCount.get(state.source) ?? 0;
      const newCount = state.cursor.deliveryCount + count;
      await advanceCursor(
        client,
        state.source,
        lastDelivered.id,
        lastDelivered.timestamp,
        newCount
      );
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
      for (const source of SOURCES) {
        await recordError(client, source, errorMessage);
      }
      const partial =
        result.entriesDelivered > 0
          ? ` (${result.entriesDelivered} entries delivered before failure)`
          : '';
      console.error(`[siem-delivery] Delivery failed: ${errorMessage}${partial}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    try {
      for (const source of SOURCES) {
        await recordError(client, source, message);
      }
    } catch {
      // best-effort only — don't mask the original error
    }

    console.error('[siem-delivery] Worker error:', message);
    throw error;
  } finally {
    if (lockAcquired) {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK_KEY])
        .catch(() => undefined);
    }
    client.release();
  }
}
