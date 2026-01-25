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
