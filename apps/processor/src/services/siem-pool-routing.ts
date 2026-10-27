import {
  resolveAdminDbMode,
  type AdminDbEnv,
  type AdminDbModeDecision,
} from '@pagespace/db/admin-db';
import type { AuditLogSource } from './siem-adapter';

/**
 * Pool-per-operation matrix for the SIEM delivery worker (#890 Phase 2 leaf 7).
 *
 * Post-cutover the worker straddles two stores: security_audit_log rows land
 * in the dedicated Admin PG (written by the lock-free ingest + chainer path),
 * while activity_logs stays in the main DB until Phase 5. The worker's own
 * state — siem_delivery_cursors and siem_delivery_receipts — lives in the
 * Admin PG (Phase 1 barrel), for BOTH sources: the cursor for a main-db data
 * source is still an admin-plane row.
 *
 * Mode follows the write path's resolver (resolveAdminDbMode) so the worker
 * always reads the store that audit writes actually target:
 *   - 'dedicated'   → the matrix below (admin state + split data planes).
 *   - 'break-glass' → everything on main: writes degraded to the legacy
 *                     table, so delivery, cursors, and receipts all revert
 *                     to the exact pre-cutover worker behavior.
 *   - 'main-db'     → identical routing to break-glass (everything on main),
 *                     but SILENT: the unconfigured pre-trust-plane default,
 *                     not an emergency degrade, so the worker logs no banner.
 *   - 'fail'        → no routing. Writes are being rejected; delivering from
 *                     either store would be guessing. The worker halts loudly.
 */

export type SiemStorePlane = 'main' | 'admin';

export interface SiemPoolRouting {
  mode: 'dedicated' | 'break-glass' | 'main-db';
  /**
   * Always 'main' until Phase 5: the lock key ('activity_logs', hashed) and
   * its host DB must stay stable across a rolling deploy so old-code and
   * new-code workers keep serializing their cursor upserts against each
   * other. Moving the lock to the admin pool before the last main-db source
   * moves would let the two versions run concurrently.
   */
  advisoryLock: SiemStorePlane;
  /** siem_delivery_cursors reads/writes — both sources. */
  cursors: SiemStorePlane;
  /** siem_delivery_receipts writes — both sources. */
  receipts: SiemStorePlane;
  /** Source-table data reads (delivery batch, preflight anchor + hashables). */
  data: Record<AuditLogSource, SiemStorePlane>;
  /**
   * First dedicated run: copy an initialized legacy cursor tuple from the
   * main DB into the admin cursors table so the watermark survives the flip
   * (no replay of already-shipped rows, no NOW()-plant gap).
   */
  seedCursorFromLegacy: boolean;
  /**
   * When the security cursor's anchor row is missing from the admin store
   * but still present in the main store, the legacy rows simply haven't been
   * backfilled yet — defer that source instead of failing closed.
   */
  awaitingBackfillProbe: boolean;
}

export interface SiemPoolRoutingResolution {
  decision: AdminDbModeDecision;
  routing: SiemPoolRouting | null;
}

const DEDICATED_ROUTING: SiemPoolRouting = {
  mode: 'dedicated',
  advisoryLock: 'main',
  cursors: 'admin',
  receipts: 'admin',
  data: {
    activity_logs: 'main',
    security_audit_log: 'admin',
  },
  seedCursorFromLegacy: true,
  awaitingBackfillProbe: true,
};

const BREAK_GLASS_ROUTING: SiemPoolRouting = {
  mode: 'break-glass',
  advisoryLock: 'main',
  cursors: 'main',
  receipts: 'main',
  data: {
    activity_logs: 'main',
    security_audit_log: 'main',
  },
  seedCursorFromLegacy: false,
  awaitingBackfillProbe: false,
};

// Identical routing to break-glass (everything on main), but mode 'main-db':
// the unconfigured pre-trust-plane default. The worker keys its loud degrade
// banner on 'break-glass' only, so main-db delivers from the main stores
// silently.
const MAIN_DB_ROUTING: SiemPoolRouting = {
  ...BREAK_GLASS_ROUTING,
  mode: 'main-db',
};

export function resolveSiemPoolRouting(env: AdminDbEnv): SiemPoolRoutingResolution {
  const decision = resolveAdminDbMode(env);
  switch (decision.mode) {
    case 'dedicated':
      return { decision, routing: DEDICATED_ROUTING };
    case 'break-glass':
      return { decision, routing: BREAK_GLASS_ROUTING };
    case 'main-db':
      return { decision, routing: MAIN_DB_ROUTING };
    case 'fail':
      return { decision, routing: null };
  }
}
