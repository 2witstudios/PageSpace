/**
 * Authentication anomaly detection (#977).
 *
 * GDPR Art 32 (security of processing) / Art 33 (breach awareness) expect basic
 * monitoring and alerting on authentication abuse. The distributed rate limiter
 * blocks individual abusive identifiers; this adds a classification + alerting
 * layer on top of the failure counts it already maintains.
 *
 * The detection and the audit-event construction are PURE (no I/O,
 * deterministic) so the thresholds are exhaustively testable; `reportAuthFailure`
 * is the thin imperative edge that counts failures and emits the alert.
 */

import type { AuditEvent } from '../audit/security-audit';

/** A window of authentication failures observed for one identifier. */
export interface AuthFailureSignal {
  /** The identifier the failures are attributed to (e.g. an IP address). */
  identifier: string;
  /** Number of auth failures observed in the window. */
  failureCount: number;
  /**
   * Distinct accounts targeted from this identifier in the window. Many
   * distinct targets is the credential-stuffing signature. Defaults to 1.
   */
  distinctTargets?: number;
}

export type AuthAnomalyType = 'none' | 'brute_force' | 'credential_stuffing';

export interface AuthAnomalyResult {
  isAnomaly: boolean;
  anomalyType: AuthAnomalyType;
  /** Risk score in [0, 1]. */
  riskScore: number;
  flags: string[];
}

/** Failure count from a single identifier that signals brute force. */
export const BRUTE_FORCE_FAILURE_THRESHOLD = 10;
/** Distinct targets from one identifier that signals credential stuffing. */
export const CREDENTIAL_STUFFING_TARGET_THRESHOLD = 5;

/**
 * Classify an authentication-failure window into an anomaly signal.
 *
 * Credential stuffing (many distinct targets) is checked first and outranks
 * brute force (many attempts on few targets) because it is the higher-risk,
 * more distributed pattern.
 */
export function detectAuthAnomaly(signal: AuthFailureSignal): AuthAnomalyResult {
  const distinctTargets = signal.distinctTargets ?? 1;

  if (distinctTargets >= CREDENTIAL_STUFFING_TARGET_THRESHOLD) {
    return {
      isAnomaly: true,
      anomalyType: 'credential_stuffing',
      riskScore: 0.9,
      flags: ['credential_stuffing'],
    };
  }

  if (signal.failureCount >= BRUTE_FORCE_FAILURE_THRESHOLD) {
    return {
      isAnomaly: true,
      anomalyType: 'brute_force',
      riskScore: 0.8,
      flags: ['brute_force'],
    };
  }

  return { isAnomaly: false, anomalyType: 'none', riskScore: 0, flags: [] };
}

export interface AuthAnomalyContext {
  ipAddress?: string;
  userId?: string;
  /** The auth endpoint where the failures occurred, e.g. 'magic-link/verify'. */
  endpoint?: string;
}

/**
 * Build the audit event for a detected anomaly, or null if there is no anomaly.
 * Brute force maps to the dedicated brute-force event type; credential stuffing
 * (and any other future anomaly) maps to the generic anomaly event. Pure.
 */
export function buildAuthAnomalyAuditEvent(
  result: AuthAnomalyResult,
  signal: AuthFailureSignal,
  context: AuthAnomalyContext = {},
): AuditEvent | null {
  if (!result.isAnomaly) return null;

  return {
    eventType:
      result.anomalyType === 'brute_force'
        ? 'security.brute.force.detected'
        : 'security.anomaly.detected',
    userId: context.userId,
    ipAddress: context.ipAddress,
    riskScore: result.riskScore,
    anomalyFlags: result.flags,
    details: {
      anomalyType: result.anomalyType,
      failureCount: signal.failureCount,
      distinctTargets: signal.distinctTargets ?? 1,
      endpoint: context.endpoint ?? null,
    },
  };
}
