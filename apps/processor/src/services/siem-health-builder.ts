import type { AuditLogSource, SiemType } from './siem-adapter';

export interface CursorSnapshot {
  id: AuditLogSource;
  lastDeliveredId: string | null;
  lastDeliveredAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  deliveryCount: number;
  updatedAt: Date;
}

export interface RecentReceipt {
  deliveryId: string;
  source: AuditLogSource;
  deliveredAt: Date;
  ackReceivedAt: Date | null;
  entryCount: number;
}

export type SourceStatus = 'initialized' | 'delivering' | 'error' | 'missing';

export interface SiemHealthLastReceipt {
  deliveryId: string;
  deliveredAt: string;
  ackReceivedAt: string | null;
  entryCount: number;
}

export interface SiemHealthPerSource {
  status: SourceStatus;
  lastDeliveredAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  deliveryCount: number;
  updatedAt?: string;
  lastReceipt?: SiemHealthLastReceipt;
}

export interface SiemHealthResponse {
  enabled: boolean;
  type: SiemType | null;
  sources: Partial<Record<AuditLogSource, SiemHealthPerSource>>;
}

interface BuildSiemHealthParams {
  enabled: boolean;
  type: SiemType | null;
  sources: readonly AuditLogSource[];
  cursors: CursorSnapshot[];
  recentReceipts: RecentReceipt[] | null;
  cursorInitSentinel: string;
}

export function buildSiemHealth(params: BuildSiemHealthParams): SiemHealthResponse {
  const { enabled, type, sources, cursors, recentReceipts, cursorInitSentinel } = params;

  if (!enabled) {
    return { enabled: false, type, sources: {} };
  }

  const cursorById = new Map<AuditLogSource, CursorSnapshot>();
  for (const cursor of cursors) {
    cursorById.set(cursor.id, cursor);
  }

  const latestReceiptBySource = selectLatestReceiptPerSource(recentReceipts);

  const out: Partial<Record<AuditLogSource, SiemHealthPerSource>> = {};
  for (const source of sources) {
    const cursor = cursorById.get(source);
    const base = cursor
      ? cursorToPerSource(cursor, cursorInitSentinel)
      : missingPerSource();

    const receipt = latestReceiptBySource?.get(source);
    if (receipt) {
      base.lastReceipt = receiptToShape(receipt);
    }

    out[source] = base;
  }

  return { enabled: true, type, sources: out };
}

function cursorToPerSource(
  cursor: CursorSnapshot,
  cursorInitSentinel: string,
): SiemHealthPerSource {
  return {
    status: deriveStatus(cursor, cursorInitSentinel),
    lastDeliveredAt: toIsoOrNull(cursor.lastDeliveredAt),
    lastErrorAt: toIsoOrNull(cursor.lastErrorAt),
    lastError: cursor.lastError,
    deliveryCount: cursor.deliveryCount,
    updatedAt: cursor.updatedAt.toISOString(),
  };
}

function missingPerSource(): SiemHealthPerSource {
  return {
    status: 'missing',
    lastDeliveredAt: null,
    lastErrorAt: null,
    lastError: null,
    deliveryCount: 0,
  };
}

function deriveStatus(cursor: CursorSnapshot, cursorInitSentinel: string): SourceStatus {
  if (cursor.lastError !== null) {
    if (cursor.lastDeliveredAt === null) {
      return 'error';
    }
    if (cursor.lastErrorAt !== null && cursor.lastErrorAt > cursor.lastDeliveredAt) {
      return 'error';
    }
  }

  if (cursor.lastDeliveredId === cursorInitSentinel) {
    return 'initialized';
  }

  return 'delivering';
}

function selectLatestReceiptPerSource(
  receipts: RecentReceipt[] | null,
): Map<AuditLogSource, RecentReceipt> | null {
  if (receipts === null) {
    return null;
  }

  const latest = new Map<AuditLogSource, RecentReceipt>();
  for (const receipt of receipts) {
    const existing = latest.get(receipt.source);
    if (!existing || receipt.deliveredAt > existing.deliveredAt) {
      latest.set(receipt.source, receipt);
    }
  }
  return latest;
}

function receiptToShape(receipt: RecentReceipt): SiemHealthLastReceipt {
  return {
    deliveryId: receipt.deliveryId,
    deliveredAt: receipt.deliveredAt.toISOString(),
    ackReceivedAt: toIsoOrNull(receipt.ackReceivedAt),
    entryCount: receipt.entryCount,
  };
}

function toIsoOrNull(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}
