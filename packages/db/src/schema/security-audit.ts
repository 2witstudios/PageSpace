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
  type ExtraConfigColumn,
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
  | 'auth.token.updated'
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
  // Privileged operator read of another subject's personal data (#954, Art 32(1)(b)).
  // Distinct from data.read so DSAR/admin reads are separable in forensic queries.
  | 'admin.data.read'
  | 'security.anomaly.detected'
  | 'security.rate.limited'
  | 'security.brute.force.detected'
  | 'security.suspicious.activity'
  // Personal-data breach / security incident recorded (#979, Art 33/34).
  | 'security.incident.created';

/**
 * Single source of truth for the security_audit_log table shape (#890 Phase 1).
 *
 * The table exists in two planes during the trust-plane migration: the main
 * app DB (current writer, FK to users intact) and the Admin PG trust plane
 * (src/admin-schema.ts), where a FK to `users` is impossible — cross-database
 * foreign keys don't exist, and the admin DB deliberately holds no app tables.
 * drizzle-kit serializes inline FKs unconditionally, so the admin variant
 * cannot be a plain re-export; this factory keeps columns and indexes defined
 * exactly once so the two instances can never drift. Only `crossPlaneUserFk`
 * differs between them.
 */
const securityAuditLogColumns = (opts: { crossPlaneUserFk: boolean }) => ({
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Event classification
  eventType: text('event_type').notNull().$type<SecurityEventType>(),

  // Actor (who triggered the event). The FK exists only in the app plane —
  // the Admin PG has no users table to reference.
  userId: opts.crossPlaneUserFk
    ? text('user_id').references(() => users.id, { onDelete: 'set null' })
    : text('user_id'),
  sessionId: text('session_id'),
  serviceId: text('service_id'),

  // Target (what was affected)
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),

  // Request context. `ip_address` holds AES-256-GCM ciphertext for rows written
  // while ENCRYPTION_KEY is configured (wired in SecurityAuditService.logEvent);
  // `ip_bidx` is its deterministic blind index for equality forensics
  // (idx_security_audit_ip_bidx, used by queryAuditEvents). This is FORWARD-ONLY:
  // existing rows stay plaintext (event_hash EXCLUDES ip_address, so encrypting
  // new rows is chain-safe and legacy plaintext rows still verify, match, and
  // read). See docs/security/pii-encryption-design.md.
  ipAddress: text('ip_address'),
  ipBidx: text('ip_bidx'),
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
});

/** The columns the shared index set touches — structural so both planes' tables fit. */
type SecurityAuditLogIndexColumns = Record<
  | 'timestamp'
  | 'userId'
  | 'eventType'
  | 'resourceType'
  | 'resourceId'
  | 'ipAddress'
  | 'ipBidx'
  | 'eventHash'
  | 'chainSeq'
  | 'riskScore'
  | 'sessionId',
  Partial<ExtraConfigColumn>
>;

const securityAuditLogIndexes = (table: SecurityAuditLogIndexColumns) => ({
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
  // IP-based forensics over encrypted rows (blind-index equality)
  ipBidxTimestampIdx: index('idx_security_audit_ip_bidx').on(table.ipBidx, table.timestamp),
  // Hash chain verification
  eventHashIdx: index('idx_security_audit_event_hash').on(table.eventHash),
  // Predecessor lookup (ORDER BY chain_seq DESC LIMIT 1 inside advisory lock)
  chainSeqIdx: index('idx_security_audit_chain_seq').on(table.chainSeq),
  // High-risk event queries
  riskScoreIdx: index('idx_security_audit_risk_score').on(table.riskScore),
  // Session tracking
  sessionIdx: index('idx_security_audit_session').on(table.sessionId, table.timestamp),
});

export const defineSecurityAuditLogTable = (opts: { crossPlaneUserFk: boolean }) =>
  pgTable('security_audit_log', securityAuditLogColumns(opts), securityAuditLogIndexes);

/**
 * Trust-plane (Admin PG) instance of security_audit_log (#890 Phase 2).
 *
 * Identical to the app-plane shape (columns + indexes come from the same
 * builders above, so the planes cannot drift) with two deliberate deltas the
 * shared factory cannot express:
 *   - no cross-plane FK to `users` (the admin DB holds no app tables), and
 *   - an extra NULLABLE `emission_hash` column: the chainer copies each
 *     drained ingest row's emission hash here so verify-on-append can
 *     recompute chainHash = H(emissionHash, prevHash) from storage. NULL
 *     marks a legacy-era row (pre-cutover / backfilled) whose event_hash was
 *     computed by the advisory-lock path. Verification reads walk chain_seq
 *     (already indexed), so the column itself needs no index.
 *
 * This exists ONLY in src/admin-schema.ts / the drizzle-admin pipeline — the
 * main-plane table above keeps its shape and main db:generate stays no-drift.
 */
export const defineAdminSecurityAuditLogTable = () =>
  pgTable(
    'security_audit_log',
    {
      ...securityAuditLogColumns({ crossPlaneUserFk: false }),
      emissionHash: text('emission_hash'),
    },
    securityAuditLogIndexes,
  );

/**
 * Security Audit Log table - tamper-evident security event tracking.
 *
 * Uses a hash chain to ensure audit trail integrity:
 * - Each entry includes the hash of the previous entry
 * - Any modification breaks the chain and is detectable
 * - First entry in chain uses 'genesis' as previousHash
 *
 * This is the APP-PLANE instance (main DB, FK to users). The trust-plane
 * instance lives in src/admin-schema.ts. Dropping the FK here is Phase 2+.
 */
export const securityAuditLog = defineSecurityAuditLogTable({ crossPlaneUserFk: true });

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
