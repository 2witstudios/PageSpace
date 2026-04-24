/**
 * Security Audit Chain Verification Alerting Tests (#544)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createValidSecurityChain, type MockSecurityAuditEntry } from './audit-test-helpers';

let mockEntries: MockSecurityAuditEntry[] = [];

const { mockLoggers } = vi.hoisted(() => ({
  mockLoggers: {
    security: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: mockLoggers,
}));

vi.mock('drizzle-orm', () => ({
  asc: vi.fn(),
  count: vi.fn(() => 'count'),
  and: vi.fn((...args: unknown[]) => args),
  gte: vi.fn(),
  lte: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          return Promise.resolve([{ count: mockEntries.length }]);
        }),
      }),
    }),
    query: {
      securityAuditLog: {
        findMany: vi.fn().mockImplementation(async (opts) => {
          let entries = [...mockEntries];
          entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
          if (opts?.offset) entries = entries.slice(opts.offset);
          if (opts?.limit) entries = entries.slice(0, opts.limit);
          return entries;
        }),
      },
    },
  },
}));
vi.mock('@pagespace/db/schema/security-audit', () => ({
  securityAuditLog: {
    id: 'id',
    eventType: 'eventType',
    userId: 'userId',
    sessionId: 'sessionId',
    serviceId: 'serviceId',
    resourceType: 'resourceType',
    resourceId: 'resourceId',
    ipAddress: 'ipAddress',
    userAgent: 'userAgent',
    geoLocation: 'geoLocation',
    details: 'details',
    riskScore: 'riskScore',
    anomalyFlags: 'anomalyFlags',
    timestamp: 'timestamp',
    previousHash: 'previousHash',
    eventHash: 'eventHash',
  },
}));

import {
  setChainAlertHandler,
  getChainAlertHandler,
  verifyAndAlert,
  startPeriodicVerification,
  stopPeriodicVerification,
  isPeriodicVerificationRunning,
  type ChainVerificationAlert,
} from '../security-audit-alerting';

describe('security-audit-alerting (#544)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEntries = [];
    setChainAlertHandler(null);
    stopPeriodicVerification();
  });

  afterEach(() => {
    stopPeriodicVerification();
  });

  describe('setChainAlertHandler / getChainAlertHandler', () => {
    it('starts with no handler', () => {
      expect(getChainAlertHandler()).toBeNull();
    });

    it('sets and retrieves the handler', () => {
      const handler = vi.fn();
      setChainAlertHandler(handler);
      expect(getChainAlertHandler()).toBe(handler);
    });

    it('clears handler with null', () => {
      setChainAlertHandler(vi.fn());
      setChainAlertHandler(null);
      expect(getChainAlertHandler()).toBeNull();
    });
  });

  describe('verifyAndAlert', () => {
    it('does not alert when chain is valid', async () => {
      mockEntries = createValidSecurityChain(3);
      const handler = vi.fn();
      setChainAlertHandler(handler);

      const result = await verifyAndAlert('manual');

      expect(result.isValid).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    });

    it('fires alert when chain is broken', async () => {
      mockEntries = createValidSecurityChain(3);
      mockEntries[1]!.eventHash = 'tampered';

      const handler = vi.fn();
      setChainAlertHandler(handler);

      const result = await verifyAndAlert('manual');

      expect(result.isValid).toBe(false);
      expect(handler).toHaveBeenCalledTimes(1);

      const alert: ChainVerificationAlert = handler.mock.calls[0][0];
      expect(alert.source).toBe('manual');
      expect(alert.result.isValid).toBe(false);
      expect(alert.result.breakPoint).not.toBeNull();
      expect(alert.triggeredAt).toBeInstanceOf(Date);
    });

    it('passes source correctly for periodic verification', async () => {
      mockEntries = createValidSecurityChain(3);
      mockEntries[1]!.eventHash = 'tampered';

      const handler = vi.fn();
      setChainAlertHandler(handler);

      await verifyAndAlert('periodic');

      const alert: ChainVerificationAlert = handler.mock.calls[0][0];
      expect(alert.source).toBe('periodic');
    });

    it('does not throw when no handler is set and chain is broken', async () => {
      mockEntries = createValidSecurityChain(3);
      mockEntries[1]!.eventHash = 'tampered';

      const result = await verifyAndAlert('manual');
      expect(result.isValid).toBe(false);
    });

    it('catches alert handler errors without throwing', async () => {
      mockEntries = createValidSecurityChain(3);
      mockEntries[1]!.eventHash = 'tampered';

      const handler = vi.fn().mockRejectedValue(new Error('alert delivery failed'));
      setChainAlertHandler(handler);

      const result = await verifyAndAlert('manual');

      expect(result.isValid).toBe(false);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockLoggers.security.error).toHaveBeenCalledWith(
        expect.stringContaining('[SecurityAuditAlerting] Alert handler failed:'),
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it('returns verification result on empty chain without alert', async () => {
      const handler = vi.fn();
      setChainAlertHandler(handler);

      const result = await verifyAndAlert('manual');

      expect(result.isValid).toBe(true);
      expect(result.totalEntries).toBe(0);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('periodic verification', () => {
    it('isPeriodicVerificationRunning returns false initially', () => {
      expect(isPeriodicVerificationRunning()).toBe(false);
    });

    it('starts and stops periodic verification', () => {
      startPeriodicVerification(60000);
      expect(isPeriodicVerificationRunning()).toBe(true);

      stopPeriodicVerification();
      expect(isPeriodicVerificationRunning()).toBe(false);
    });

    it('replaces previous periodic timer on re-start', () => {
      startPeriodicVerification(60000);
      expect(isPeriodicVerificationRunning()).toBe(true);

      startPeriodicVerification(30000);
      expect(isPeriodicVerificationRunning()).toBe(true);

      stopPeriodicVerification();
      expect(isPeriodicVerificationRunning()).toBe(false);
    });

    it('fires verification on interval', async () => {
      vi.useFakeTimers();

      mockEntries = createValidSecurityChain(2);
      mockEntries[1]!.eventHash = 'tampered';

      const handler = vi.fn();
      setChainAlertHandler(handler);

      startPeriodicVerification(1000);

      // Advance past one interval
      await vi.advanceTimersByTimeAsync(1100);

      expect(handler).toHaveBeenCalledTimes(1);
      const alert: ChainVerificationAlert = handler.mock.calls[0][0];
      expect(alert.source).toBe('periodic');

      stopPeriodicVerification();
      vi.useRealTimers();
    });

    it('stopPeriodicVerification is idempotent', () => {
      stopPeriodicVerification();
      stopPeriodicVerification();
      expect(isPeriodicVerificationRunning()).toBe(false);
    });
  });
});
