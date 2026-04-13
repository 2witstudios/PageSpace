import type { AuditLogSource } from '../services/siem-adapter';
import type { CursorSnapshot } from '../services/siem-health-builder';

interface PgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

const CURSOR_SELECT_SQL = `SELECT id, "lastDeliveredId", "lastDeliveredAt", "lastError", "lastErrorAt", "deliveryCount", "updatedAt"
FROM siem_delivery_cursors
WHERE id = ANY($1::text[])`;

export async function readCursorSnapshots(
  client: PgClient,
  sources: readonly AuditLogSource[],
): Promise<CursorSnapshot[]> {
  const result = await client.query(CURSOR_SELECT_SQL, [sources as unknown as string[]]);
  return result.rows.map(rowToSnapshot);
}

function rowToSnapshot(row: Record<string, unknown>): CursorSnapshot {
  return {
    id: row.id as AuditLogSource,
    lastDeliveredId: (row.lastDeliveredId as string | null) ?? null,
    lastDeliveredAt: toDateOrNull(row.lastDeliveredAt),
    lastError: (row.lastError as string | null) ?? null,
    lastErrorAt: toDateOrNull(row.lastErrorAt),
    deliveryCount: Number(row.deliveryCount ?? 0),
    updatedAt: toDateOrThrow(row.updatedAt),
  };
}

function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(String(value));
}

function toDateOrThrow(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') return new Date(value);
  throw new Error('siem-cursor-reader: updatedAt missing from cursor row');
}
