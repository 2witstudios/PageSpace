/**
 * Breach assessment — pure core for the GDPR breach-notification pipeline (#979).
 *
 * GDPR Art 33: a controller must notify the supervisory authority of a personal
 * data breach within 72 hours of becoming aware of it, UNLESS the breach is
 * "unlikely to result in a risk to the rights and freedoms of natural persons".
 *
 * GDPR Art 34: the controller must additionally notify the affected data
 * subjects when the breach is likely to result in a HIGH risk to their rights
 * and freedoms.
 *
 * Every function here is pure (no I/O, no clock reads, deterministic) so the
 * regulatory decision logic is exhaustively testable; the imperative incident
 * service consumes these results.
 */

import type { IncidentStatus, IncidentRiskLevel } from '@pagespace/db/schema/incidents';

/** Art 33 notification window: 72 hours, in milliseconds. */
export const AUTHORITY_NOTIFICATION_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * Compute the Art 33 supervisory-authority notification deadline: 72 hours
 * after the controller became aware of the breach.
 */
export function computeAuthorityNotificationDeadline(detectedAt: Date): Date {
  return new Date(detectedAt.getTime() + AUTHORITY_NOTIFICATION_WINDOW_MS);
}

export interface NotifiabilityInput {
  /** Residual risk to data subjects after mitigations. */
  riskLevel: IncidentRiskLevel;
  /**
   * Whether the breach involves personal data at all. A breach of non-personal
   * data is outside the GDPR notification regime.
   */
  involvesPersonalData: boolean;
}

export interface NotifiabilityAssessment {
  /** Art 33 — supervisory authority must be notified. */
  requiresAuthorityNotification: boolean;
  /** Art 34 — affected data subjects must be notified. */
  requiresSubjectNotification: boolean;
}

/**
 * Decide the two GDPR notification obligations for a breach.
 *
 * - No personal data involved ⇒ neither obligation applies.
 * - Low residual risk ⇒ Art 33 exemption ("unlikely to result in a risk").
 * - Medium/high residual risk ⇒ authority notification required (Art 33).
 * - High residual risk ⇒ data-subject notification additionally required (Art 34).
 */
export function assessNotifiability(input: NotifiabilityInput): NotifiabilityAssessment {
  if (!input.involvesPersonalData) {
    return { requiresAuthorityNotification: false, requiresSubjectNotification: false };
  }

  return {
    requiresAuthorityNotification: input.riskLevel !== 'low',
    requiresSubjectNotification: input.riskLevel === 'high',
  };
}

export interface IncidentAssessmentInput extends NotifiabilityInput {
  detectedAt: Date;
}

export interface IncidentAssessment extends NotifiabilityAssessment {
  /** Deadline for Art 33 notification, or null when no notification is required. */
  authorityNotificationDeadline: Date | null;
}

/**
 * Full breach assessment: notification obligations plus the Art 33 deadline.
 * The deadline is null whenever supervisory-authority notification is not
 * required, so a null deadline cannot be mistaken for "overdue".
 */
export function assessIncident(input: IncidentAssessmentInput): IncidentAssessment {
  const notifiability = assessNotifiability(input);
  return {
    ...notifiability,
    authorityNotificationDeadline: notifiability.requiresAuthorityNotification
      ? computeAuthorityNotificationDeadline(input.detectedAt)
      : null,
  };
}

/**
 * Allowed incident lifecycle transitions. An incident may always be closed
 * early; it can never move backwards or skip the notification step forward.
 */
const VALID_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  detected: ['triaged', 'closed'],
  triaged: ['notified', 'closed'],
  notified: ['closed'],
  closed: [],
};

/** Whether moving an incident from `from` to `to` is a legal lifecycle step. */
export function isValidIncidentTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Whether the Art 33 deadline has passed as of `now`. */
export function isAuthorityNotificationOverdue(deadline: Date, now: Date): boolean {
  return now.getTime() > deadline.getTime();
}
