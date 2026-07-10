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
  notifyChainAppendVerificationFailure,
  startPeriodicVerification,
  stopPeriodicVerification,
  isPeriodicVerificationRunning,
  type ChainVerificationAlert,
} from '../security-audit-alerting';
import type { VerifySecurityChainDeps } from '../security-audit-chain-verifier';
import { db as mockDefaultDb } from '@pagespace/db/db';

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

    it('threads an injected db client through to verifySecurityAuditChain, never touching the module-level singleton', async () => {
      const injectedEntries = createValidSecurityChain(2);
      const select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: injectedEntries.length }]),
        }),
      });
      const findMany = vi.fn().mockImplementation(async (opts) => {
        let result = [...injectedEntries].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        if (opts?.offset) result = result.slice(opts.offset);
        if (opts?.limit) result = result.slice(0, opts.limit);
        return result;
      });
      const injectedDb = { select, query: { securityAuditLog: { findMany } } };
      const deps: VerifySecurityChainDeps = { db: injectedDb as unknown as VerifySecurityChainDeps['db'] };

      const result = await verifyAndAlert('manual', undefined, deps);

      expect(select).toHaveBeenCalled();
      expect(findMany).toHaveBeenCalled();
      expect(mockDefaultDb.select).not.toHaveBeenCalled();
      expect(result.isValid).toBe(true);
      expect(result.totalEntries).toBe(2);
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

  describe('notifyChainAppendVerificationFailure (#890 Phase 2 chainer verify-on-append)', () => {
    const details = {
      entryId: 'chained-row-4',
      breakAtIndex: 4,
      breakReason: 'hash_mismatch' as const,
      expectedHash: 'expected-hash',
      actualHash: 'actual-hash',
      segmentTotalRows: 12,
      priorHead: 'prior-head-hash',
    };

    it('given no registered handler, should be a silent no-op (processor context)', async () => {
      await expect(notifyChainAppendVerificationFailure(details)).resolves.toBeUndefined();
    });

    it('given a registered handler, should fire an append-sourced alert with a synthetic result describing the break', async () => {
      const handler = vi.fn();
      setChainAlertHandler(handler);

      await notifyChainAppendVerificationFailure(details);

      expect(handler).toHaveBeenCalledTimes(1);
      const alert: ChainVerificationAlert = handler.mock.calls[0][0];
      expect(alert.source).toBe('append');
      expect(alert.result.isValid).toBe(false);
      expect(alert.result.totalEntries).toBe(12);
      expect(alert.result.entriesVerified).toBe(5);
      expect(alert.result.validEntries).toBe(4);
      expect(alert.result.invalidEntries).toBe(1);
      expect(alert.result.breakPoint?.entryId).toBe('chained-row-4');
      expect(alert.result.breakPoint?.storedHash).toBe('actual-hash');
      expect(alert.result.breakPoint?.computedHash).toBe('expected-hash');
      expect(alert.result.breakPoint?.previousHashUsed).toBe('prior-head-hash');
      expect(alert.result.breakPoint?.description).toContain('verify-on-append');
    });

    it('given a throwing handler, should swallow the error and log it (alerting must never mask the detection)', async () => {
      setChainAlertHandler(() => {
        throw new Error('alert transport down');
      });

      await expect(notifyChainAppendVerificationFailure(details)).resolves.toBeUndefined();
      expect(mockLoggers.security.error).toHaveBeenCalled();
    });

    it('given each break reason, should render a distinct human description', async () => {
      const handler = vi.fn();
      setChainAlertHandler(handler);

      for (const breakReason of ['hash_mismatch', 'linkage_break', 'missing_emission_hash'] as const) {
        await notifyChainAppendVerificationFailure({ ...details, breakReason });
      }

      const descriptions = handler.mock.calls.map(
        (call) => (call[0] as ChainVerificationAlert).result.breakPoint?.description,
      );
      expect(new Set(descriptions).size).toBe(3);
    });
  });
});
