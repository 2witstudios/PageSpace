/**
 * Security Audit Module
 *
 * Exports the security audit service for tamper-evident event logging.
 */

export {
  SecurityAuditService,
  securityAudit,
  computeSecurityEventHash,
  type AuditEvent,
  type QueryEventsOptions,
} from './security-audit';

export {
  auditAuthEvent,
  auditSecurityEvent,
} from './security-audit-adapter';

export { audit, auditRequest } from './audit-log';

export { queryAuditEvents } from './audit-query';

export {
  verifyAndAlert,
  setChainAlertHandler,
  getChainAlertHandler,
  startPeriodicVerification,
  stopPeriodicVerification,
  isPeriodicVerificationRunning,
  type ChainVerificationAlert,
  type ChainAlertHandler,
} from './security-audit-alerting';

/** Mask email to prevent PII in audit logs (e.g., john@example.com -> jo***@example.com) */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***@***';
  const visibleChars = Math.min(2, local.length);
  return `${local.slice(0, visibleChars)}***@${domain}`;
}
