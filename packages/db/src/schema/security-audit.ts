/**
 * Security Audit Log Schema
 *
 * Comprehensive security event logging with hash chain integrity.
 * Part of the Zero-Trust Security Architecture (Phase 5).
 *
 * Features:
 * - Complete security event tracking (auth, authz, data access)
 * - Hash chain for tamper-evident audit trail
 * - Risk scoring and anomaly flags
 * - Efficient indexes for forensic queries
 */

import {
  pgTable,
  text,
  timestamp,
  real,
  jsonb,
  index,
  bigserial,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

/**
 * Security event types. Stored as text in the DB (see migration 0105): the
 * column was converted from a pg enum to text so that removing legacy values
 * doesn't require DELETE / UPDATE on rows that participate in the
 * tamper-evident hash chain (event_type is part of computeSecurityEventHash).
 * Writer-side type safety lives here.
 */
export type SecurityEventType =
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.logout'
  | 'auth.token.created'
  | 'auth.token.revoked'
  | 'auth.token.refreshed'
  | 'auth.mfa.enabled'
  | 'auth.mfa.disabled'
  | 'auth.mfa.challenged'
  | 'auth.mfa.verified'
  | 'auth.session.created'
  | 'auth.session.revoked'
  | 'auth.device.registered'
  | 'auth.device.revoked'
  | 'authz.access.granted'
  | 'authz.access.denied'
  | 'authz.permission.granted'
  | 'authz.permission.revoked'
  | 'authz.role.assigned'
  | 'authz.role.removed'
  | 'data.read'
  | 'data.write'
  | 'data.delete'
  | 'data.export'
  | 'data.share'
  | 'admin.user.created'
  | 'admin.user.suspended'
  | 'admin.user.reactivated'
  | 'admin.user.deleted'
  | 'admin.settings.changed'
  | 'security.anomaly.detected'
  | 'security.rate.limited'
  | 'security.brute.force.detected'
  | 'security.suspicious.activity';

/**
 * Security Audit Log table - tamper-evident security event tracking.
 *
 * Uses a hash chain to ensure audit trail integrity:
 * - Each entry includes the hash of the previous entry
 * - Any modification breaks the chain and is detectable
 * - First entry in chain uses 'genesis' as previousHash
 */
export const securityAuditLog = pgTable('security_audit_log', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Event classification
  eventType: text('event_type').notNull().$type<SecurityEventType>(),

  // Actor (who triggered the event)
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  sessionId: text('session_id'),
  serviceId: text('service_id'),

  // Target (what was affected)
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),

  // Request context
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  geoLocation: text('geo_location'),

  // Event details (flexible JSON for event-specific data)
  details: jsonb('details').$type<Record<string, unknown>>(),

  // Risk assessment
  riskScore: real('risk_score'),
  anomalyFlags: text('anomaly_flags').array(),

  // Timing
  timestamp: timestamp('timestamp', { mode: 'date' }).defaultNow().notNull(),

  // BIGSERIAL for commit-order predecessor lookup — timestamps are pre-assigned before the advisory lock.
  chainSeq: bigserial('chain_seq', { mode: 'number' }).notNull(),

  // Hash chain integrity
  previousHash: text('previous_hash').notNull(),
  eventHash: text('event_hash').notNull(),
}, (table) => ({
  // Time-based queries (most common access pattern)
  timestampIdx: index('idx_security_audit_timestamp').on(table.timestamp),
  // User activity forensics
  userTimestampIdx: index('idx_security_audit_user_timestamp').on(table.userId, table.timestamp),
  // Event type filtering
  eventTypeTimestampIdx: index('idx_security_audit_event_type').on(table.eventType, table.timestamp),
  // Resource access audit
  resourceIdx: index('idx_security_audit_resource').on(table.resourceType, table.resourceId, table.timestamp),
  // IP-based forensics
  ipTimestampIdx: index('idx_security_audit_ip').on(table.ipAddress, table.timestamp),
  // Hash chain verification
  eventHashIdx: index('idx_security_audit_event_hash').on(table.eventHash),
  // Predecessor lookup (ORDER BY chain_seq DESC LIMIT 1 inside advisory lock)
  chainSeqIdx: index('idx_security_audit_chain_seq').on(table.chainSeq),
  // High-risk event queries
  riskScoreIdx: index('idx_security_audit_risk_score').on(table.riskScore),
  // Session tracking
  sessionIdx: index('idx_security_audit_session').on(table.sessionId, table.timestamp),
}));

/**
 * Relations for security audit log
 */
export const securityAuditLogRelations = relations(securityAuditLog, ({ one }) => ({
  user: one(users, {
    fields: [securityAuditLog.userId],
    references: [users.id],
  }),
}));

/**
 * TypeScript type for inserting audit log entries
 */
export type InsertSecurityAuditLog = typeof securityAuditLog.$inferInsert;

/**
 * TypeScript type for selected audit log entries
 */
export type SelectSecurityAuditLog = typeof securityAuditLog.$inferSelect;
