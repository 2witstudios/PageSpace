/**
 * Security Incident / Personal-Data-Breach Schema (#979)
 *
 * Backing store for the breach-notification pipeline (GDPR Art 33 / Art 34).
 *
 * An incident moves through a lifecycle (detected → triaged → notified →
 * closed) and records the two regulatory notification obligations:
 *  - Art 33: notify the supervisory authority within 72h of becoming aware,
 *    unless the breach is unlikely to result in a risk to rights/freedoms.
 *  - Art 34: notify affected data subjects when the breach is likely to
 *    result in a HIGH risk to their rights/freedoms.
 *
 * The deadline / notifiability decisions are computed by pure functions in
 * `@pagespace/lib/incidents/breach-assessment`; this table only stores the
 * resulting facts so the imperative edge stays thin.
 */

import { pgTable, text, timestamp, integer, boolean, jsonb, index } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

/** Incident severity (internal triage scale). */
export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

/** Incident lifecycle state. */
export type IncidentStatus = 'detected' | 'triaged' | 'notified' | 'closed';

/**
 * CIA classification of the breach (Art 4(12)): a breach of confidentiality,
 * integrity, and/or availability of personal data.
 */
export type IncidentCategory = 'confidentiality' | 'integrity' | 'availability';

/** Art 34 residual-risk classification used to decide subject notification. */
export type IncidentRiskLevel = 'low' | 'medium' | 'high';

export const incidents = pgTable('incidents', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Classification
  title: text('title').notNull(),
  description: text('description'),
  severity: text('severity').notNull().$type<IncidentSeverity>(),
  status: text('status').notNull().default('detected').$type<IncidentStatus>(),
  category: text('category').$type<IncidentCategory>(),

  // Detection / accountability — actor preserved via set-null so the incident
  // record outlives a deleted reporter (audit-trail preservation).
  detectedAt: timestamp('detectedAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  reportedBy: text('reportedBy').references(() => users.id, { onDelete: 'set null' }),

  // Affected scope
  affectedUserCount: integer('affectedUserCount'),
  affectedScope: jsonb('affectedScope').$type<Record<string, unknown>>(),
  riskLevel: text('riskLevel').$type<IncidentRiskLevel>(),

  // Art 33 — supervisory-authority notification
  requiresAuthorityNotification: boolean('requiresAuthorityNotification'),
  authorityNotificationDeadline: timestamp('authorityNotificationDeadline', { mode: 'date', withTimezone: true }),
  authorityNotifiedAt: timestamp('authorityNotifiedAt', { mode: 'date', withTimezone: true }),

  // Art 34 — data-subject notification
  requiresSubjectNotification: boolean('requiresSubjectNotification'),
  subjectsNotifiedAt: timestamp('subjectsNotifiedAt', { mode: 'date', withTimezone: true }),

  // Free-form forensic metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp('closedAt', { mode: 'date', withTimezone: true }),
}, (table) => ({
  statusIdx: index('idx_incidents_status').on(table.status),
  detectedAtIdx: index('idx_incidents_detected_at').on(table.detectedAt),
  // Find incidents whose authority-notification deadline is approaching/overdue.
  authorityDeadlineIdx: index('idx_incidents_authority_deadline').on(table.authorityNotificationDeadline),
}));

export type InsertIncident = typeof incidents.$inferInsert;
export type SelectIncident = typeof incidents.$inferSelect;
