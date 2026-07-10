/**
 * Admin PG (trust plane) schema barrel (#890 Phase 1).
 *
 * Selects WHICH tables belong to the dedicated admin database. Per the
 * 2026-07-09 reconciliation this is EXACTLY:
 *   - securityAuditLog (tamper-evident chained table)
 *   - siemDeliveryCursors
 *   - siemDeliveryReceipts
 *   - securityAuditIngest (Phase 2 lock-free emission queue, trust-plane only)
 *   - securityAuditAnchors (Phase 2 anchor receipts, trust-plane only)
 * The 4 analytics tables (systemLogs, apiMetrics, userActivities, errorLogs)
 * go to ClickHouse in Phase 3 — NOT into Admin PG. activityLogs joins in
 * Phase 5.
 *
 * Source of truth stays in ./schema/* — the SIEM tables are plain re-exports,
 * and securityAuditLog is instantiated from the shared factory WITHOUT the
 * cross-plane FK to `users` (a cross-database FK is impossible; the admin DB
 * holds no app tables). Columns/indexes are defined once, so the planes
 * cannot drift. The relations from ./schema/security-audit are deliberately
 * not included: they join to `users`, which exists in the app plane only.
 *
 * This module is both the drizzle-kit schema entry (drizzle-admin.config.ts)
 * and the runtime schema bound to the adminDb client (admin-db.ts).
 */
import { defineAdminSecurityAuditLogTable } from './schema/security-audit';

/**
 * Trust-plane instance of security_audit_log — identical shape, no users FK,
 * plus the nullable emission_hash column (chainer verify-on-append input;
 * NULL = legacy-era row). See defineAdminSecurityAuditLogTable.
 */
export const securityAuditLog = defineAdminSecurityAuditLogTable();

export type {
  SecurityEventType,
  InsertSecurityAuditLog,
  SelectSecurityAuditLog,
} from './schema/security-audit';
export { siemDeliveryCursors, siemDeliveryReceipts } from './schema/monitoring';
export {
  securityAuditIngest,
  type InsertSecurityAuditIngest,
  type SelectSecurityAuditIngest,
} from './schema/security-audit-ingest';
export {
  securityAuditAnchors,
  type InsertSecurityAuditAnchor,
  type SelectSecurityAuditAnchor,
} from './schema/security-audit-anchors';
