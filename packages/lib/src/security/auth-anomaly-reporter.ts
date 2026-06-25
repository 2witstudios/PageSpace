/**
 * Auth-anomaly reporter — thin imperative edge (#977).
 *
 * Counts authentication failures per identifier (Postgres-backed, via
 * `countAuthFailure`), runs the pure `detectAuthAnomaly` classifier, and emits a
 * security-audit + structured-log alert when an anomaly is detected. The
 * decision logic is entirely in the pure `auth-anomaly` module; this file only
 * does I/O.
 */

import { countAuthFailure } from './distributed-rate-limit';
import { audit } from '../audit/audit-log';
import { loggers } from '../logging/logger-config';
import {
  detectAuthAnomaly,
  buildAuthAnomalyAuditEvent,
  type AuthAnomalyResult,
  type AuthAnomalyContext,
  type AuthFailureSignal,
} from './auth-anomaly';

/** Default failure-count window: 15 minutes (matches LOGIN/MAGIC_LINK windows). */
export const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;

export interface ReportAuthFailureInput extends AuthAnomalyContext {
  /** Identifier to attribute failures to (usually the client IP). */
  identifier: string;
  /** Distinct accounts targeted in the window, if known (stuffing signal). */
  distinctTargets?: number;
  /** Override the counting window. */
  windowMs?: number;
}

/**
 * Record one authentication failure and alert if it crosses an anomaly
 * threshold. Returns the anomaly result. Never throws — auth failure handling
 * must not be blocked by monitoring.
 */
export async function reportAuthFailure(input: ReportAuthFailureInput): Promise<AuthAnomalyResult> {
  const windowMs = input.windowMs ?? AUTH_FAILURE_WINDOW_MS;
  const failureCount = await countAuthFailure(input.identifier, windowMs);

  const signal: AuthFailureSignal = {
    identifier: input.identifier,
    failureCount,
    distinctTargets: input.distinctTargets,
  };
  const result = detectAuthAnomaly(signal);
  const event = buildAuthAnomalyAuditEvent(result, signal, input);

  if (event) {
    loggers.security.error('[AuthAnomaly] Authentication anomaly detected', {
      identifier: input.identifier,
      anomalyType: result.anomalyType,
      failureCount,
      endpoint: input.endpoint,
    });
    audit(event);
  }

  return result;
}
