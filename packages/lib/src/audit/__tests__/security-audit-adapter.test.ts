import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoggers } = vi.hoisted(() => ({
  mockLoggers: {
    security: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: mockLoggers,
}));

vi.mock('../security-audit', () => ({
  securityAudit: {
    logEvent: vi.fn().mockResolvedValue(undefined),
    logAuthSuccess: vi.fn().mockResolvedValue(undefined),
    logAuthFailure: vi.fn().mockResolvedValue(undefined),
    logAccessDenied: vi.fn().mockResolvedValue(undefined),
    logTokenCreated: vi.fn().mockResolvedValue(undefined),
    logTokenRevoked: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@pagespace/db', () => ({
  securityAuditLog: {},
}));

import { auditAuthEvent, auditSecurityEvent } from '../security-audit-adapter';
import { securityAudit } from '../security-audit';

describe('Security Audit Adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('auditAuthEvent', () => {
    it('dispatches login success to securityAudit.logEvent', () => {
      auditAuthEvent('login', 'user-1', 'test@example.com', '1.2.3.4');

      expect(securityAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'auth.login.success',
          userId: 'user-1',
          ipAddress: '1.2.3.4',
        })
      );
    });

    it('dispatches login failure with risk score', () => {
      auditAuthEvent('failed', undefined, 'bad@example.com', '1.2.3.4', 'invalid_password');

      expect(securityAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'auth.login.failure',
          riskScore: 0.3,
          details: expect.objectContaining({
            reason: 'invalid_password',
          }),
        })
      );
    });

    it('dispatches logout event', () => {
      auditAuthEvent('logout', 'user-1', undefined, '1.2.3.4');

      expect(securityAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'auth.logout',
          userId: 'user-1',
        })
      );
    });

    it('dispatches token refresh event', () => {
      auditAuthEvent('refresh', 'user-1', undefined, '1.2.3.4');

      expect(securityAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'auth.token.created',
          userId: 'user-1',
        })
      );
    });

    it('masks email in audit details', () => {
      auditAuthEvent('login', 'user-1', 'longuser@example.com', '1.2.3.4');

      expect(securityAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            email: 'lo***@example.com',
          }),
        })
      );
    });

    it('does not throw when securityAudit.logEvent rejects', () => {
      vi.mocked(securityAudit.logEvent).mockRejectedValueOnce(new Error('DB down'));

      expect(() => {
        auditAuthEvent('login', 'user-1', 'test@example.com', '1.2.3.4');
      }).not.toThrow();
    });
  });

  describe('auditSecurityEvent', () => {
    it('dispatches unauthorized as access denied', () => {
      auditSecurityEvent('unauthorized', {
        userId: 'user-1',
        ip: '1.2.3.4',
        reason: 'csrf_failed',
      });

      expect(securityAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'authz.access.denied',
          userId: 'user-1',
          ipAddress: '1.2.3.4',
          details: expect.objectContaining({
            reason: 'csrf_failed',
            originalEvent: 'unauthorized',
          }),
        })
      );
    });

    it('dispatches rate_limit event', () => {
      auditSecurityEvent('rate_limit', {
        ip: '1.2.3.4',
        endpoint: '/api/auth/login',
      });

      expect(securityAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'security.rate.limited',
          ipAddress: '1.2.3.4',
          riskScore: 0.4,
        })
      );
    });

    it('dispatches account_locked_login_attempt with high risk score', () => {
      auditSecurityEvent('account_locked_login_attempt', {
        email: 'locked@test.com',
        ip: '1.2.3.4',
      });

      expect(securityAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'security.brute.force.detected',
          riskScore: 0.8,
        })
      );
    });

    it('skips unmapped security events without calling logEvent', () => {
      auditSecurityEvent('login_csrf_missing', { ip: '1.2.3.4' });

      expect(securityAudit.logEvent).not.toHaveBeenCalled();
    });

    it('does not throw when securityAudit.logEvent rejects', () => {
      vi.mocked(securityAudit.logEvent).mockRejectedValueOnce(new Error('DB down'));

      expect(() => {
        auditSecurityEvent('unauthorized', { userId: 'user-1' });
      }).not.toThrow();
    });
  });

  describe('failure logging', () => {
    it('logs warning when auditAuthEvent write fails', async () => {
      vi.mocked(securityAudit.logEvent).mockRejectedValueOnce(new Error('DB down'));

      auditAuthEvent('login', 'user-1', 'test@example.com', '1.2.3.4');

      await vi.waitFor(() => {
        expect(mockLoggers.security.warn).toHaveBeenCalledWith(
          expect.stringContaining('auditAuthEvent'),
          expect.objectContaining({ error: expect.any(Error) })
        );
      });
    });

    it('logs warning when auditSecurityEvent write fails', async () => {
      vi.mocked(securityAudit.logEvent).mockRejectedValueOnce(new Error('DB down'));

      auditSecurityEvent('unauthorized', { userId: 'user-1' });

      await vi.waitFor(() => {
        expect(mockLoggers.security.warn).toHaveBeenCalledWith(
          expect.stringContaining('auditSecurityEvent'),
          expect.objectContaining({ error: expect.any(Error) })
        );
      });
    });
  });
});
