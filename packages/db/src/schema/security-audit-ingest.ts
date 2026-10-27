/**
 * Security Audit Ingest — transient queue for the lock-free write path
 * (#890 Phase 2, leaf 1).
 *
 * TRUST-PLANE ONLY: this table exists exclusively in the Admin PG. It is
 * exported from src/admin-schema.ts (the drizzle-admin pipeline) and must
 * NEVER be added to the main schema barrel (src/schema.ts) — the app plane
 * has no ingest table.
 *
 * The app computes a pure emission hash in-process and does ONE INSERT here
 * — no advisory lock, no head read, no transaction. The single-writer
 * chainer (processor, leaf 2) drains rows in (emitted_at, id) order, assigns
 * chain_seq + chainHash on security_audit_log, then DELETEs the drained rows
 * — the only DELETE grant anywhere in the trust plane, and it applies to
 * this queue only, never to a chain table. Plain table by design: rows are
 * transient, so the chain tables' monthly partitioning does not apply.
 *
 * Column shapes mirror security_audit_log's event columns exactly (id and
 * ip encryption included — encryption still happens at emission); the chain
 * columns (chain_seq, previous_hash, event_hash) are deliberately absent,
 * replaced by emission_hash + emitted_at.
 */

import { pgTable, text, timestamp, real, jsonb, index } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
import type { SecurityEventType } from './security-audit';

export const securityAuditIngest = pgTable('security_audit_ingest', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Event classification
  eventType: text('event_type').notNull().$type<SecurityEventType>(),

  // Actor — no users FK even in shape: the Admin PG holds no app tables.
  userId: text('user_id'),
  sessionId: text('session_id'),
  serviceId: text('service_id'),

  // Target
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),

  // Request context — ip_address is AES-256-GCM ciphertext (+ ip_bidx blind
  // index) when ENCRYPTION_KEY is configured, exactly as on security_audit_log.
  ipAddress: text('ip_address'),
  ipBidx: text('ip_bidx'),
  userAgent: text('user_agent'),
  geoLocation: text('geo_location'),

  // Event details
  details: jsonb('details').$type<Record<string, unknown>>(),

  // Risk assessment
  riskScore: real('risk_score'),
  anomalyFlags: text('anomaly_flags').array(),

  // Event time — hashed content (part of the emission hash).
  timestamp: timestamp('timestamp', { mode: 'date' }).defaultNow().notNull(),

  // Emission fingerprint: sha256 over the PII-excluded content payload,
  // computed in-process (packages/lib/src/audit/emission-hash.ts). The
  // chainer folds it into chainHash = H(emissionHash, prevHash).
  emissionHash: text('emission_hash').notNull(),

  // Queue-arrival time — drain order, not hashed content.
  emittedAt: timestamp('emitted_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  // FIFO drain: the chainer reads ORDER BY emitted_at, id.
  drainIdx: index('idx_security_audit_ingest_drain').on(table.emittedAt, table.id),
}));

export type InsertSecurityAuditIngest = typeof securityAuditIngest.$inferInsert;
export type SelectSecurityAuditIngest = typeof securityAuditIngest.$inferSelect;
