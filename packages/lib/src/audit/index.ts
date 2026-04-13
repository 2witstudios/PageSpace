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

export { maskEmail } from './mask-email';
