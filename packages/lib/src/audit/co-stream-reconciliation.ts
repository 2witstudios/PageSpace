/**
 * Co-stream reconciliation consumer — the store-read shell (#890 Phase 2,
 * leaf 4).
 *
 * Wires the pure reconciliation core (co-stream.ts) to Admin PG reads:
 * chained rows in the window plus an INDEPENDENT second read of the
 * window's latest chained head (ORDER BY chain_seq DESC LIMIT 1) for the
 * head-equality check — two reads that disagree mean the row set is stale
 * or the tail was rewritten between them.
 *
 * Deliberately NOT a scheduled job: the tamper drill (Phase 6) and the
 * dual-era verifier (backfill leaf) call it with collector-supplied
 * records. Read errors propagate — the caller owns failure handling.
 */

import { and, desc, gte, lt } from 'drizzle-orm';
import type { AdminDatabase } from '@pagespace/db/admin-db';
import { securityAuditLog } from '@pagespace/db/admin-schema';
import {
  reconcileCoStream,
  type CoStreamRecord,
  type CoStreamReconciliationReport,
  type CoStreamStoreRow,
  type ReconciliationWindow,
} from './co-stream';

export interface RunCoStreamReconciliationDeps {
  /** Witness records from the log collector (parsed CO_STREAM_LOG_MESSAGE lines). */
  records: readonly CoStreamRecord[];
  db: AdminDatabase;
  window: ReconciliationWindow;
}

/**
 * Reconcile collector-supplied co-stream records against the chained store
 * over a window. Reads only — reader-role credentials suffice.
 */
export async function runCoStreamReconciliation({
  records,
  db,
  window,
}: RunCoStreamReconciliationDeps): Promise<CoStreamReconciliationReport> {
  const windowFilter = and(
    gte(securityAuditLog.timestamp, window.start),
    lt(securityAuditLog.timestamp, window.end),
  );

  const storeRows: CoStreamStoreRow[] = await db
    .select({
      id: securityAuditLog.id,
      emissionHash: securityAuditLog.emissionHash,
      eventType: securityAuditLog.eventType,
      timestamp: securityAuditLog.timestamp,
      chainSeq: securityAuditLog.chainSeq,
      eventHash: securityAuditLog.eventHash,
    })
    .from(securityAuditLog)
    .where(windowFilter);

  const [headRow] = await db
    .select({
      chainSeq: securityAuditLog.chainSeq,
      eventHash: securityAuditLog.eventHash,
    })
    .from(securityAuditLog)
    .where(windowFilter)
    .orderBy(desc(securityAuditLog.chainSeq))
    .limit(1);

  return reconcileCoStream(records, storeRows, window, headRow ?? null);
}
