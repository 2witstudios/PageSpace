import type { PgPoolClient } from '../db';
import type { ReceiptRow } from '../services/siem-receipt-builder';

const COLUMNS_PER_ROW = 11;

/**
 * Thin DB-side-effect wrapper around `siem_delivery_receipts`. Keeps the
 * worker free of inline SQL so build/write concerns stay separate, and so
 * `buildReceipts` can be tested as a pure function without touching pg.
 *
 * Writes all receipts in a single multi-row INSERT to keep the delivery-side
 * hot path to one round trip. Throws on DB error — the worker's existing
 * try/catch and `recordError` path handle failure persistence.
 */
export async function writeReceipts(
  client: PgPoolClient,
  receipts: ReceiptRow[]
): Promise<void> {
  if (receipts.length === 0) {
    return;
  }

  const valueClauses: string[] = [];
  const params: unknown[] = [];

  receipts.forEach((r, rowIdx) => {
    const base = rowIdx * COLUMNS_PER_ROW;
    const placeholders: string[] = [];
    for (let i = 1; i <= COLUMNS_PER_ROW; i++) {
      placeholders.push(`$${base + i}`);
    }
    valueClauses.push(`(${placeholders.join(', ')})`);
    params.push(
      r.deliveryId,
      r.source,
      r.firstEntryId,
      r.lastEntryId,
      r.firstEntryTimestamp,
      r.lastEntryTimestamp,
      r.entryCount,
      r.deliveredAt,
      r.webhookStatus,
      r.webhookResponseHash,
      r.ackReceivedAt
    );
  });

  const sql = `INSERT INTO siem_delivery_receipts (
      "deliveryId",
      "source",
      "firstEntryId",
      "lastEntryId",
      "firstEntryTimestamp",
      "lastEntryTimestamp",
      "entryCount",
      "deliveredAt",
      "webhookStatus",
      "webhookResponseHash",
      "ackReceivedAt"
    ) VALUES ${valueClauses.join(', ')}`;

  await client.query(sql, params);
}
