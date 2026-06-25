/**
 * Incident service — thin imperative edge for the breach pipeline (#979).
 *
 * Persists a security incident, derives the GDPR Art 33/34 obligations via the
 * pure `breach-assessment` core, writes an immutable security-audit event, and
 * dispatches an operational alert through a pluggable notifier (wired at app
 * startup to email/Slack — mirrors the chain-alert-handler pattern in
 * security-audit-alerting.ts).
 *
 * All decision logic lives in breach-assessment.ts; this module only does I/O.
 */

import { db } from '@pagespace/db/db';
import {
  incidents,
  type IncidentSeverity,
  type IncidentCategory,
  type IncidentRiskLevel,
  type SelectIncident,
} from '@pagespace/db/schema/incidents';
import { loggers } from '../logging/logger-config';
import { securityAudit } from '../audit/security-audit';
import { assessIncident, type IncidentAssessment } from './breach-assessment';

export interface CreateIncidentInput {
  title: string;
  description?: string;
  severity: IncidentSeverity;
  category?: IncidentCategory;
  /** Residual risk to data subjects — drives the Art 33/34 obligations. */
  riskLevel: IncidentRiskLevel;
  /** Whether personal data is in scope (false ⇒ outside the GDPR regime). */
  involvesPersonalData: boolean;
  affectedUserCount?: number;
  affectedScope?: Record<string, unknown>;
  /** User who reported/detected the incident, if known. */
  reportedBy?: string;
  /** When the controller became aware. Defaults to now. */
  detectedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface IncidentNotification {
  incident: SelectIncident;
  assessment: IncidentAssessment;
}

/** Handler invoked when an incident is recorded. Wired at app startup. */
export type IncidentNotifier = (notification: IncidentNotification) => void | Promise<void>;

let incidentNotifier: IncidentNotifier | null = null;

/** Register (or clear) the incident notifier. */
export function setIncidentNotifier(handler: IncidentNotifier | null): void {
  incidentNotifier = handler;
}

/** Current incident notifier (for tests / introspection). */
export function getIncidentNotifier(): IncidentNotifier | null {
  return incidentNotifier;
}

/**
 * Record a security incident / personal-data breach.
 *
 * Persists the row with its computed Art 33 deadline and notification flags,
 * emits a `security.incident.created` audit event, logs an operational alert,
 * and dispatches the notifier. A failing audit/notify step must not mask the
 * persisted incident, so those are best-effort.
 */
export async function createIncident(input: CreateIncidentInput): Promise<SelectIncident> {
  const detectedAt = input.detectedAt ?? new Date();
  const assessment = assessIncident({
    detectedAt,
    riskLevel: input.riskLevel,
    involvesPersonalData: input.involvesPersonalData,
  });

  const [incident] = await db
    .insert(incidents)
    .values({
      title: input.title,
      description: input.description,
      severity: input.severity,
      category: input.category,
      riskLevel: input.riskLevel,
      status: 'detected',
      detectedAt,
      reportedBy: input.reportedBy,
      affectedUserCount: input.affectedUserCount,
      affectedScope: input.affectedScope,
      requiresAuthorityNotification: assessment.requiresAuthorityNotification,
      requiresSubjectNotification: assessment.requiresSubjectNotification,
      authorityNotificationDeadline: assessment.authorityNotificationDeadline,
      metadata: input.metadata,
    })
    .returning();

  // Immutable, tamper-evident audit record of the breach.
  try {
    await securityAudit.logEvent({
      eventType: 'security.incident.created',
      userId: input.reportedBy,
      resourceType: 'incident',
      resourceId: incident.id,
      riskScore: input.riskLevel === 'high' ? 0.9 : input.riskLevel === 'medium' ? 0.6 : 0.3,
      anomalyFlags: ['security_incident'],
      details: {
        severity: input.severity,
        category: input.category ?? null,
        riskLevel: input.riskLevel,
        involvesPersonalData: input.involvesPersonalData,
        requiresAuthorityNotification: assessment.requiresAuthorityNotification,
        requiresSubjectNotification: assessment.requiresSubjectNotification,
        authorityNotificationDeadline:
          assessment.authorityNotificationDeadline?.toISOString() ?? null,
        affectedUserCount: input.affectedUserCount ?? null,
      },
    });
  } catch (error) {
    loggers.security.error('[Incident] Failed to write audit event', {
      incidentId: incident.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  loggers.security.error('[Incident] Security incident recorded', {
    incidentId: incident.id,
    severity: input.severity,
    riskLevel: input.riskLevel,
    requiresAuthorityNotification: assessment.requiresAuthorityNotification,
    requiresSubjectNotification: assessment.requiresSubjectNotification,
    authorityNotificationDeadline:
      assessment.authorityNotificationDeadline?.toISOString() ?? null,
  });

  if (incidentNotifier) {
    try {
      await incidentNotifier({ incident, assessment });
    } catch (error) {
      loggers.security.error('[Incident] Notifier failed', {
        incidentId: incident.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return incident;
}
