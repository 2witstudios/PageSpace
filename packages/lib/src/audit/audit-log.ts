/**
 * Functional Audit Pipeline
 *
 * Composed functions that always dual-write to both the structured logger
 * and the tamper-evident audit DB. Replaces the scattered pattern of
 * choosing between logAuthEvent, logSecurityEvent, securityAudit, and logAuditEvent.
 */

import { securityAudit, type AuditEvent } from './security-audit';
import { loggers } from '../logging/logger-config';

/**
 * Dual-write an audit event to the structured logger and audit DB.
 * Fire-and-forget: DB errors are caught and logged as warnings.
 */
export function audit(event: AuditEvent): void {
  const level = (event.riskScore ?? 0) >= 0.5 ? 'warn' : 'info';
  loggers.security[level](`[Audit] ${event.eventType}`, { ...event });

  securityAudit.logEvent(event).catch((error: unknown) => {
    loggers.security.warn('[Audit] audit write failed', {
      error: error instanceof Error ? error : new Error(String(error)),
      eventType: event.eventType,
    });
  });
}

/**
 * Dual-write an audit event with automatic request metadata extraction.
 * Extracts ipAddress and userAgent from the Request headers unless
 * already provided on the event.
 */
export function auditRequest(request: Request, event: AuditEvent): void {
  const ipAddress =
    event.ipAddress ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';

  const userAgent =
    event.userAgent ??
    request.headers.get('user-agent') ??
    'unknown';

  audit({ ...event, ipAddress, userAgent });
}
