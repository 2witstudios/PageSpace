/**
 * Functional Audit Pipeline
 *
 * Composed functions that always dual-write to both the structured logger
 * and the tamper-evident audit DB. Replaces the scattered pattern of
 * choosing between logAuthEvent, logSecurityEvent, securityAudit, and logAuditEvent.
 */

import { securityAudit, type AuditEvent } from './security-audit';
import { loggers } from '../logging/logger-config';
import { sanitizeAuditDetails } from './sanitize-audit-details';

/**
 * Dual-write an audit event to the structured logger and audit DB.
 * Fire-and-forget: DB errors are caught and logged as warnings.
 *
 * GDPR (#971): `details` is folded into the tamper-evident hash chain and
 * cannot be erased under Art 17, so we sanitize it here at the runtime edge —
 * stripping user-typed search text and PII from EVERY audit event before it is
 * logged or persisted, regardless of which call site produced it.
 */
export function audit(event: AuditEvent): void {
  const sanitizedEvent: AuditEvent =
    event.details === undefined
      ? event
      : { ...event, details: sanitizeAuditDetails(event.details) };

  const level = (sanitizedEvent.riskScore ?? 0) >= 0.5 ? 'warn' : 'info';
  loggers.security[level](`[Audit] ${sanitizedEvent.eventType}`, { ...sanitizedEvent });

  securityAudit.logEvent(sanitizedEvent).catch((error: unknown) => {
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
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = request.headers.get('x-real-ip')?.trim();
  const headerUserAgent = request.headers.get('user-agent')?.trim();

  const ipAddress =
    event.ipAddress ??
    (forwardedFor || undefined) ??
    (realIp || undefined) ??
    'unknown';

  const userAgent =
    event.userAgent ??
    (headerUserAgent || undefined) ??
    'unknown';

  audit({ ...event, ipAddress, userAgent });
}
