/**
 * Security Audit Adapter
 *
 * Bridges existing logAuthEvent/logSecurityEvent calls to the tamper-evident
 * SecurityAuditService. Provides drop-in replacements that fan out events
 * to both the structured logger and the hash-chain audit log.
 *
 * Fire-and-forget: audit writes never block or reject the caller.
 */

import { securityAudit } from './security-audit';
import { loggers } from '../logging/logger-config';
import type { SecurityEventType } from '@pagespace/db';

type AuthEventType = 'login' | 'logout' | 'signup' | 'refresh' | 'failed' | 'magic_link_login';

type SecurityLogEventType =
  | 'rate_limit'
  | 'invalid_token'
  | 'unauthorized'
  | 'suspicious_activity'
  | 'login_csrf_missing'
  | 'login_csrf_mismatch'
  | 'login_csrf_invalid'
  | 'signup_csrf_missing'
  | 'signup_csrf_mismatch'
  | 'signup_csrf_invalid'
  | 'origin_validation_failed'
  | 'origin_validation_warning'
  | 'account_locked_login_attempt'
  | 'admin_role_version_mismatch'
  | 'magic_link_csrf_missing'
  | 'magic_link_csrf_mismatch'
  | 'magic_link_csrf_invalid'
  | 'magic_link_rate_limit_ip'
  | 'magic_link_rate_limit_email'
  | 'magic_link_suspended_user'
  | 'passkey_csrf_invalid'
  | 'passkey_rate_limit_auth'
  | 'passkey_rate_limit_options'
  | 'passkey_rate_limit_register'
  | 'passkey_rate_limit_signup_ip'
  | 'passkey_rate_limit_signup_email'
  | 'signup_blocked_onprem';

const AUTH_EVENT_MAP: Record<AuthEventType, SecurityEventType> = {
  login: 'auth.login.success',
  logout: 'auth.logout',
  signup: 'auth.login.success',
  refresh: 'auth.token.created',
  failed: 'auth.login.failure',
  magic_link_login: 'auth.login.success',
};

const SECURITY_EVENT_MAP: Partial<Record<SecurityLogEventType, SecurityEventType>> = {
  rate_limit: 'security.rate.limited',
  invalid_token: 'auth.token.revoked',
  unauthorized: 'authz.access.denied',
  suspicious_activity: 'security.anomaly.detected',
  account_locked_login_attempt: 'security.brute.force.detected',
};

/**
 * Fan out an auth event to the SecurityAuditService.
 * Silently catches errors to avoid disrupting the auth flow.
 */
export function auditAuthEvent(
  event: AuthEventType,
  userId?: string,
  email?: string,
  ip?: string,
  reason?: string
): void {
  const eventType = AUTH_EVENT_MAP[event];
  if (!eventType) return;

  const maskedEmail = email ? email.replace(/(.{2}).*(@.*)/, '$1***$2') : undefined;

  securityAudit.logEvent({
    eventType,
    userId,
    ipAddress: ip,
    details: {
      ...(maskedEmail && { email: maskedEmail }),
      ...(reason && { reason }),
      source: 'auth_event_adapter',
    },
    riskScore: event === 'failed' ? 0.3 : undefined,
  }).catch((error) => {
    loggers.security.warn('[SecurityAuditAdapter] auditAuthEvent write failed:', { error });
  });
}

/**
 * Fan out a security event to the SecurityAuditService.
 * Silently catches errors to avoid disrupting the security flow.
 */
export function auditSecurityEvent(
  event: SecurityLogEventType,
  details: Record<string, unknown>
): void {
  const eventType = SECURITY_EVENT_MAP[event];
  if (!eventType) return;

  const { userId, ip, ...rest } = details;

  securityAudit.logEvent({
    eventType,
    userId: typeof userId === 'string' ? userId : undefined,
    ipAddress: typeof ip === 'string' ? ip : undefined,
    details: {
      ...rest,
      originalEvent: event,
      source: 'security_event_adapter',
    },
    riskScore: event === 'account_locked_login_attempt' ? 0.8 : 0.4,
  }).catch((error) => {
    loggers.security.warn('[SecurityAuditAdapter] auditSecurityEvent write failed:', { error });
  });
}
