import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../audit-query', () => ({
  queryAuditEvents: vi.fn(),
}));

import { createSecurityAuditService } from '../security-audit';
import type { SecurityAuditRepository } from '../security-audit-repository';
import { queryAuditEvents } from '../audit-query';

function createMockRepository(): SecurityAuditRepository & {
  appendEvent: ReturnType<typeof vi.fn>;
  readChainHead: ReturnType<typeof vi.fn>;
} {
  return {
    appendEvent: vi.fn().mockResolvedValue(undefined),
    readChainHead: vi.fn().mockResolvedValue('genesis'),
  };
}

describe('createSecurityAuditService', () => {
  let repository: ReturnType<typeof createMockRepository>;
  let service: ReturnType<typeof createSecurityAuditService>;

  beforeEach(() => {
    vi.clearAllMocks();
    repository = createMockRepository();
    service = createSecurityAuditService({ repository });
  });

  describe('initialize / isInitialized', () => {
    it('given a fresh service, should report not initialized', () => {
      expect(service.isInitialized()).toBe(false);
    });

    it('given initialize() was called, should report initialized', async () => {
      await service.initialize();

      expect(service.isInitialized()).toBe(true);
    });

    it('given initialize() called multiple times, should stay idempotent', async () => {
      await service.initialize();
      await service.initialize();
      await service.initialize();

      expect(service.isInitialized()).toBe(true);
    });
  });

  describe('logEvent', () => {
    it('given an event, should pass it verbatim to repository.appendEvent', async () => {
      const event = {
        eventType: 'auth.login.success' as const,
        userId: 'user123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      };

      await service.logEvent(event);

      expect(repository.appendEvent).toHaveBeenCalledTimes(1);
      expect(repository.appendEvent).toHaveBeenCalledWith(event);
    });

    it('given logEvent is called before initialize(), should self-initialize', async () => {
      expect(service.isInitialized()).toBe(false);

      await service.logEvent({ eventType: 'auth.logout', userId: 'user123' });

      expect(service.isInitialized()).toBe(true);
    });

    it('given multiple logEvent calls, should call repository.appendEvent once per event', async () => {
      await service.logEvent({ eventType: 'auth.login.success', userId: 'user1' });
      await service.logEvent({ eventType: 'auth.logout', userId: 'user1' });

      expect(repository.appendEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe('convenience methods', () => {
    it('logAuthSuccess should log auth.login.success with the given fields', async () => {
      await service.logAuthSuccess('user123', 'sess456', '192.168.1.1', 'Mozilla/5.0');

      expect(repository.appendEvent).toHaveBeenCalledTimes(1);
      expect(repository.appendEvent).toHaveBeenCalledWith({
        eventType: 'auth.login.success',
        userId: 'user123',
        sessionId: 'sess456',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });
    });

    it('logAuthFailure should log auth.login.failure with risk score 0.3', async () => {
      await service.logAuthFailure('attempted@email.com', '192.168.1.1', 'Invalid password');

      expect(repository.appendEvent).toHaveBeenCalledTimes(1);
      expect(repository.appendEvent).toHaveBeenCalledWith({
        eventType: 'auth.login.failure',
        ipAddress: '192.168.1.1',
        details: { attemptedUser: 'attempted@email.com', reason: 'Invalid password' },
        riskScore: 0.3,
      });
    });

    it('logAccessDenied should log authz.access.denied with risk score 0.5', async () => {
      await service.logAccessDenied('user123', 'page', 'page456', 'Insufficient permissions');

      expect(repository.appendEvent).toHaveBeenCalledTimes(1);
      expect(repository.appendEvent).toHaveBeenCalledWith({
        eventType: 'authz.access.denied',
        userId: 'user123',
        resourceType: 'page',
        resourceId: 'page456',
        details: { reason: 'Insufficient permissions' },
        riskScore: 0.5,
      });
    });

    it('logTokenCreated should log auth.token.created', async () => {
      await service.logTokenCreated('user123', 'service', '192.168.1.1');

      expect(repository.appendEvent).toHaveBeenCalledTimes(1);
      expect(repository.appendEvent).toHaveBeenCalledWith({
        eventType: 'auth.token.created',
        userId: 'user123',
        ipAddress: '192.168.1.1',
        details: { tokenType: 'service' },
      });
    });

    it('logTokenRevoked should log auth.token.revoked', async () => {
      await service.logTokenRevoked('user123', 'service', 'User logout');

      expect(repository.appendEvent).toHaveBeenCalledTimes(1);
      expect(repository.appendEvent).toHaveBeenCalledWith({
        eventType: 'auth.token.revoked',
        userId: 'user123',
        details: { tokenType: 'service', reason: 'User logout' },
      });
    });

    it('logAnomalyDetected should log security.anomaly.detected with flags', async () => {
      await service.logAnomalyDetected('user123', '192.168.1.1', 0.8, ['impossible_travel', 'new_device']);

      expect(repository.appendEvent).toHaveBeenCalledTimes(1);
      expect(repository.appendEvent).toHaveBeenCalledWith({
        eventType: 'security.anomaly.detected',
        userId: 'user123',
        ipAddress: '192.168.1.1',
        riskScore: 0.8,
        anomalyFlags: ['impossible_travel', 'new_device'],
      });
    });

    it.each([
      ['read', 'data.read'],
      ['write', 'data.write'],
      ['delete', 'data.delete'],
      ['export', 'data.export'],
      ['share', 'data.share'],
    ] as const)('logDataAccess(%s) should map to %s', async (operation, eventType) => {
      await service.logDataAccess('user123', operation, 'page', 'page456', { extra: true });

      expect(repository.appendEvent).toHaveBeenCalledTimes(1);
      expect(repository.appendEvent).toHaveBeenCalledWith({
        eventType,
        userId: 'user123',
        resourceType: 'page',
        resourceId: 'page456',
        details: { extra: true },
      });
    });

    it('logLogout should log auth.logout', async () => {
      await service.logLogout('user123', 'sess456', '192.168.1.1');

      expect(repository.appendEvent).toHaveBeenCalledTimes(1);
      expect(repository.appendEvent).toHaveBeenCalledWith({
        eventType: 'auth.logout',
        userId: 'user123',
        sessionId: 'sess456',
        ipAddress: '192.168.1.1',
      });
    });

    it('logRateLimited should log security.rate.limited with risk score 0.4', async () => {
      await service.logRateLimited('192.168.1.1', '/api/foo', 'user123');

      expect(repository.appendEvent).toHaveBeenCalledTimes(1);
      expect(repository.appendEvent).toHaveBeenCalledWith({
        eventType: 'security.rate.limited',
        userId: 'user123',
        ipAddress: '192.168.1.1',
        details: { endpoint: '/api/foo' },
        riskScore: 0.4,
      });
    });

    it('logBruteForceDetected should log security.brute.force.detected with risk score 0.8', async () => {
      await service.logBruteForceDetected('192.168.1.1', 5, 'targetUser');

      expect(repository.appendEvent).toHaveBeenCalledTimes(1);
      expect(repository.appendEvent).toHaveBeenCalledWith({
        eventType: 'security.brute.force.detected',
        ipAddress: '192.168.1.1',
        details: { attemptCount: 5, targetUser: 'targetUser' },
        riskScore: 0.8,
        anomalyFlags: ['brute_force'],
      });
    });
  });

  describe('queryEvents', () => {
    it('should delegate to the standalone queryAuditEvents() function', async () => {
      const mockEvents = [{ id: 'evt1' }];
      vi.mocked(queryAuditEvents).mockResolvedValue(mockEvents as never);

      const options = { userId: 'user123' };
      const result = await service.queryEvents(options);

      expect(queryAuditEvents).toHaveBeenCalledTimes(1);
      expect(queryAuditEvents).toHaveBeenCalledWith(options);
      expect(result).toBe(mockEvents);
    });
  });
});
