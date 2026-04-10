import { loadSiemConfig, validateSiemConfig, deliverToSiemWithRetry } from '../services/siem-adapter';
import { mapActivityLogsToSiemEntries } from '../services/siem-event-mapper';
import { getPoolForWorker } from '../db';

const CURSOR_ID = 'activity_logs';
const DEFAULT_BATCH_SIZE = 100;

const ACTIVITY_LOG_COLUMNS = `id, timestamp, "userId", "actorEmail", "actorDisplayName",
        "isAiGenerated", "aiProvider", "aiModel", "aiConversationId",
        operation, "resourceType", "resourceId", "resourceTitle",
        "driveId", "pageId", metadata, "previousLogHash", "logHash"`;

/**
 * SIEM delivery worker — polls activity_logs for new entries and delivers
 * them to the configured SIEM endpoint via the existing siem-adapter.
 *
 * Scheduled by pg-boss every 30s. Expected max duration: ~4 minutes
 * (3 retries x 60s backoff cap + network time). The schedule uses
 * retryLimit: 0 so overlapping runs won't stack.
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

  try {
    // Read cursor position
    const cursorResult = await client.query(
      'SELECT "lastDeliveredId", "lastDeliveredAt", "deliveryCount" FROM siem_delivery_cursors WHERE id = $1',
      [CURSOR_ID]
    );
    const cursor = cursorResult.rows[0] as {
      lastDeliveredId: string | null;
      lastDeliveredAt: Date | null;
      deliveryCount: number;
    } | undefined;

    // Query new activity_logs after the cursor position.
    // Uses timestamp-only comparison because activity_logs.timestamp has
    // microsecond precision (PostgreSQL NOW()) and each event comes from a
    // separate HTTP request/transaction, making same-timestamp collision
    // effectively impossible. CUID2 IDs are non-monotonic so cannot be used
    // for reliable cursor ordering.
    const batchSize = config.webhook?.batchSize ?? DEFAULT_BATCH_SIZE;
    let logsResult;

    if (cursor?.lastDeliveredAt) {
      logsResult = await client.query(
        `SELECT ${ACTIVITY_LOG_COLUMNS}
         FROM activity_logs
         WHERE timestamp > $1
         ORDER BY timestamp ASC
         LIMIT $2`,
        [cursor.lastDeliveredAt, batchSize]
      );
    } else {
      logsResult = await client.query(
        `SELECT ${ACTIVITY_LOG_COLUMNS}
         FROM activity_logs
         ORDER BY timestamp ASC
         LIMIT $1`,
        [batchSize]
      );
    }

    if (logsResult.rows.length === 0) {
      return;
    }

    // Map and deliver
    const entries = mapActivityLogsToSiemEntries(logsResult.rows as Record<string, unknown>[]);
    const result = await deliverToSiemWithRetry(config, entries);

    // Advance cursor past any delivered entries (handles both full and partial delivery)
    if (result.entriesDelivered > 0) {
      const lastDeliveredRow = logsResult.rows[result.entriesDelivered - 1] as Record<string, unknown>;
      const newCount = (cursor?.deliveryCount ?? 0) + result.entriesDelivered;

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
        [CURSOR_ID, lastDeliveredRow.id as string, lastDeliveredRow.timestamp as Date, newCount]
      );
    }

    if (result.success) {
      console.log(`[siem-delivery] Delivered ${result.entriesDelivered} entries`);
    } else {
      // Record the error — cursor was already advanced past any partial delivery above
      await client.query(
        `INSERT INTO siem_delivery_cursors (id, "lastError", "lastErrorAt", "updatedAt")
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           "lastError" = $2,
           "lastErrorAt" = NOW(),
           "updatedAt" = NOW()`,
        [CURSOR_ID, result.error ?? 'Unknown delivery error']
      );

      console.error(`[siem-delivery] Delivery failed: ${result.error}${result.entriesDelivered > 0 ? ` (${result.entriesDelivered} entries delivered before failure)` : ''}`);
    }
  } catch (error) {
    console.error('[siem-delivery] Worker error:', error instanceof Error ? error.message : error);
  } finally {
    client.release();
  }
}
