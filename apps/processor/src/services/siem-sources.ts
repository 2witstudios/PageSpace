import type { AuditLogSource } from './siem-adapter';

// Shared across health endpoint wiring and (once Wave 2 lands) the dual-source
// worker. Kept in its own module so Wave 3c ships without touching
// siem-delivery-worker.ts, which is being refactored on a parallel branch.
export const SIEM_SOURCES: readonly AuditLogSource[] = [
  'activity_logs',
  'security_audit_log',
];

// Written into siem_delivery_cursors.lastDeliveredId when a new source cursor
// is initialized at `NOW()` but hasn't yet delivered any real rows. The health
// endpoint surfaces this as status='initialized' so operators can distinguish
// "never delivered anything" from "actively delivering".
export const CURSOR_INIT_SENTINEL = '__cursor_init__';
