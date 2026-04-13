import type { AuditLogSource } from '../services/siem-adapter';
import type { RecentReceipt } from '../services/siem-health-builder';

interface PgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

// deliveryId is the tiebreaker so two receipts for the same source with
// identical deliveredAt (possible under batched delivery with ms-precision
// timestamps) yield a deterministic winner across refreshes.
const RECEIPT_SELECT_SQL = `SELECT DISTINCT ON (source)
  "deliveryId", source, "deliveredAt", "ackReceivedAt", "entryCount"
FROM siem_delivery_receipts
ORDER BY source, "deliveredAt" DESC, "deliveryId" DESC`;

// Returns null if the receipts table does not yet exist (Wave 3b not merged).
// Returns [] if the table exists but holds no rows.
// Throws on any other DB error.
export async function readRecentReceipts(
  client: PgClient,
): Promise<RecentReceipt[] | null> {
  try {
    const result = await client.query(RECEIPT_SELECT_SQL);
    return result.rows.map(rowToReceipt);
  } catch (err) {
    if (isRelationNotFoundError(err)) {
      return null;
    }
    throw err;
  }
}

function rowToReceipt(row: Record<string, unknown>): RecentReceipt {
  return {
    deliveryId: String(row.deliveryId),
    source: row.source as AuditLogSource,
    deliveredAt: toDate(row.deliveredAt),
    ackReceivedAt: row.ackReceivedAt === null || row.ackReceivedAt === undefined
      ? null
      : toDate(row.ackReceivedAt),
    entryCount: Number(row.entryCount ?? 0),
  };
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(String(value));
}

function isRelationNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown };
  return e.code === '42P01';
}
