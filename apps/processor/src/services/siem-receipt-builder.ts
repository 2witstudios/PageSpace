import type { AuditLogEntry, AuditLogSource } from './siem-adapter';

/**
 * Input to buildReceipts — everything needed to produce one per-source receipt
 * row for the entries the worker actually delivered in a single run. Pure data;
 * no DB handles, no IO, no clocks.
 *
 * `deliveredEntries` is the prefix `merged.slice(0, result.entriesDelivered)`
 * the worker computes in its Phase 4 walk — already time-sorted, already the
 * set we want to attest.
 */
export interface ReceiptInput {
  deliveryId: string;
  deliveredAt: Date;
  webhookStatus: number | null;
  webhookResponseHash: string | null;
  ackReceivedAt: Date | null;
  deliveredEntries: AuditLogEntry[];
}

/**
 * One row destined for siem_delivery_receipts. Per source, never per merged
 * batch — a single delivery with entries from multiple sources produces one
 * row per source.
 */
export interface ReceiptRow {
  deliveryId: string;
  source: AuditLogSource;
  firstEntryId: string;
  lastEntryId: string;
  firstEntryTimestamp: Date;
  lastEntryTimestamp: Date;
  entryCount: number;
  deliveredAt: Date;
  webhookStatus: number | null;
  webhookResponseHash: string | null;
  ackReceivedAt: Date | null;
}

interface ReceiptAccumulator {
  firstEntry: AuditLogEntry;
  lastEntry: AuditLogEntry;
  entryCount: number;
}

/**
 * Build one ReceiptRow per source that has at least one delivered entry.
 *
 * Pure function of its input — no IO, no clock reads. The per-source first /
 * last are computed by min/max timestamp within the source, not by batch
 * position, so an interleaved merge does not mislabel the boundaries if the
 * order mutates upstream.
 */
export function buildReceipts(input: ReceiptInput): ReceiptRow[] {
  const { deliveryId, deliveredAt, webhookStatus, webhookResponseHash, ackReceivedAt, deliveredEntries } = input;

  if (deliveredEntries.length === 0) {
    return [];
  }

  const bySource = new Map<AuditLogSource, ReceiptAccumulator>();

  for (const entry of deliveredEntries) {
    const existing = bySource.get(entry.source);
    if (!existing) {
      bySource.set(entry.source, {
        firstEntry: entry,
        lastEntry: entry,
        entryCount: 1,
      });
      continue;
    }

    existing.entryCount += 1;
    if (entry.timestamp.getTime() < existing.firstEntry.timestamp.getTime()) {
      existing.firstEntry = entry;
    }
    if (entry.timestamp.getTime() >= existing.lastEntry.timestamp.getTime()) {
      existing.lastEntry = entry;
    }
  }

  const receipts: ReceiptRow[] = [];
  for (const [source, acc] of bySource) {
    receipts.push({
      deliveryId,
      source,
      firstEntryId: acc.firstEntry.id,
      lastEntryId: acc.lastEntry.id,
      firstEntryTimestamp: acc.firstEntry.timestamp,
      lastEntryTimestamp: acc.lastEntry.timestamp,
      entryCount: acc.entryCount,
      deliveredAt,
      webhookStatus,
      webhookResponseHash,
      ackReceivedAt,
    });
  }

  return receipts;
}
