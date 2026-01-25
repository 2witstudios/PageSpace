import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

// Mock the database module
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      securityAuditLog: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn(),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn(),
        }),
      }),
    }),
  },
  securityAuditLog: {},
  desc: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  eq: vi.fn(),
}));

// Import after mocking
import {
  SecurityAuditService,
  computeSecurityEventHash,
  type AuditEvent,
} from '../security-audit';
import { db, securityAuditLog } from '@pagespace/db';

describe('Security Audit Service', () => {
  let service: SecurityAuditService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SecurityAuditService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('computeSecurityEventHash', () => {
    it('computes consistent SHA-256 hash for event data', () => {
      const event: AuditEvent = {
        eventType: 'auth.login.success',
        userId: 'user123',
        ipAddress: '192.168.1.1',
      };
      const previousHash = 'genesis';
      const timestamp = new Date('2026-01-25T10:00:00Z');

      const hash1 = computeSecurityEventHash(event, previousHash, timestamp);
      const hash2 = computeSecurityEventHash(event, previousHash, timestamp);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex length
    });

    it('produces different hashes for different events', () => {
      const event1: AuditEvent = {
        eventType: 'auth.login.success',
        userId: 'user123',
      };
      const event2: AuditEvent = {
        eventType: 'auth.login.failure',
        userId: 'user123',
      };
      const previousHash = 'genesis';
      const timestamp = new Date('2026-01-25T10:00:00Z');

      const hash1 = computeSecurityEventHash(event1, previousHash, timestamp);
      const hash2 = computeSecurityEventHash(event2, previousHash, timestamp);

      expect(hash1).not.toBe(hash2);
    });

    it('produces different hashes with different previous hash (hash chain)', () => {
      const event: AuditEvent = {
        eventType: 'auth.login.success',
        userId: 'user123',
      };
      const timestamp = new Date('2026-01-25T10:00:00Z');

      const hash1 = computeSecurityEventHash(event, 'genesis', timestamp);
      const hash2 = computeSecurityEventHash(event, 'different-previous', timestamp);

      expect(hash1).not.toBe(hash2);
    });

    it('handles events with all optional fields', () => {
      const event: AuditEvent = {
        eventType: 'auth.login.success',
        userId: 'user123',
        sessionId: 'sess456',
        serviceId: 'web',
        resourceType: 'drive',
        resourceId: 'drive789',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        details: { browser: 'Chrome', os: 'Windows' },
        riskScore: 0.3,
        anomalyFlags: ['new_device', 'unusual_time'],
      };
      const previousHash = 'prev123';
      const timestamp = new Date('2026-01-25T10:00:00Z');

      const hash = computeSecurityEventHash(event, previousHash, timestamp);

      expect(hash).toHaveLength(64);
      expect(typeof hash).toBe('string');
    });
  });

  describe('initialize', () => {
    it('initializes with genesis hash when no previous events exist', async () => {
      vi.mocked(db.query.securityAuditLog.findFirst).mockResolvedValue(undefined);

      await service.initialize();

      expect(db.query.securityAuditLog.findFirst).toHaveBeenCalled();
    });

    it('initializes with last event hash when events exist', async () => {
      const lastEvent = {
        id: 'evt123',
        eventHash: 'abc123def456',
        timestamp: new Date(),
      };
      vi.mocked(db.query.securityAuditLog.findFirst).mockResolvedValue(lastEvent as never);

      await service.initialize();

      expect(db.query.securityAuditLog.findFirst).toHaveBeenCalled();
    });

    it('only initializes once (idempotent)', async () => {
      vi.mocked(db.query.securityAuditLog.findFirst).mockResolvedValue(undefined);

      await service.initialize();
      await service.initialize();
      await service.initialize();

      expect(db.query.securityAuditLog.findFirst).toHaveBeenCalledTimes(1);
    });
  });

  describe('logEvent', () => {
    beforeEach(async () => {
      vi.mocked(db.query.securityAuditLog.findFirst).mockResolvedValue(undefined);
      await service.initialize();
    });

    it('logs events with hash chain', async () => {
      const mockInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });
      vi.mocked(db.insert).mockImplementation(mockInsert);

      await service.logEvent({
        eventType: 'auth.login.success',
        userId: 'user123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(mockInsert).toHaveBeenCalledWith(securityAuditLog);
    });

    it('hash chain is verifiable (subsequent events reference previous hash)', async () => {
      const insertedValues: Array<{ previousHash: string; eventHash: string }> = [];

      const mockInsert = vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((value) => {
          insertedValues.push({
            previousHash: value.previousHash,
            eventHash: value.eventHash,
          });
          return Promise.resolve();
        }),
      }));
      vi.mocked(db.insert).mockImplementation(mockInsert);

      // Log first event
      await service.logEvent({
        eventType: 'auth.login.success',
        userId: 'user123',
      });

      // Log second event
      await service.logEvent({
        eventType: 'auth.logout',
        userId: 'user123',
      });

      expect(insertedValues).toHaveLength(2);
      // First event should have 'genesis' as previous hash
      expect(insertedValues[0].previousHash).toBe('genesis');
      // Second event should reference first event's hash
      expect(insertedValues[1].previousHash).toBe(insertedValues[0].eventHash);
    });

    it('handles concurrent logging (sequential processing)', async () => {
      const insertedEvents: AuditEvent[] = [];

      const mockInsert = vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((value) => {
          insertedEvents.push(value);
          return Promise.resolve();
        }),
      }));
      vi.mocked(db.insert).mockImplementation(mockInsert);

      // Simulate concurrent logging
      await Promise.all([
        service.logEvent({ eventType: 'auth.login.success', userId: 'user1' }),
        service.logEvent({ eventType: 'auth.login.success', userId: 'user2' }),
        service.logEvent({ eventType: 'auth.login.success', userId: 'user3' }),
      ]);

      // All events should be logged
      expect(insertedEvents).toHaveLength(3);
    });
  });

  describe('convenience methods', () => {
    beforeEach(async () => {
      vi.mocked(db.query.securityAuditLog.findFirst).mockResolvedValue(undefined);
      await service.initialize();

      const mockInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });
      vi.mocked(db.insert).mockImplementation(mockInsert);
    });

    it('logAuthSuccess logs correct event type', async () => {
      const logEventSpy = vi.spyOn(service, 'logEvent');

      await service.logAuthSuccess('user123', 'sess456', '192.168.1.1', 'Mozilla/5.0');

      expect(logEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'auth.login.success',
          userId: 'user123',
          sessionId: 'sess456',
          ipAddress: '192.168.1.1',
          userAgent: 'Mozilla/5.0',
        })
      );
    });

    it('logAuthFailure logs correct event type with risk score', async () => {
      const logEventSpy = vi.spyOn(service, 'logEvent');

      await service.logAuthFailure('attempted@email.com', '192.168.1.1', 'Invalid password');

      expect(logEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'auth.login.failure',
          ipAddress: '192.168.1.1',
          riskScore: 0.3,
          details: expect.objectContaining({
            attemptedUser: 'attempted@email.com',
            reason: 'Invalid password',
          }),
        })
      );
    });

    it('logAccessDenied logs correct event type with risk score', async () => {
      const logEventSpy = vi.spyOn(service, 'logEvent');

      await service.logAccessDenied('user123', 'page', 'page456', 'Insufficient permissions');

      expect(logEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'authz.access.denied',
          userId: 'user123',
          resourceType: 'page',
          resourceId: 'page456',
          riskScore: 0.5,
          details: expect.objectContaining({
            reason: 'Insufficient permissions',
          }),
        })
      );
    });

    it('logTokenCreated logs correct event type', async () => {
      const logEventSpy = vi.spyOn(service, 'logEvent');

      await service.logTokenCreated('user123', 'service', '192.168.1.1');

      expect(logEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'auth.token.created',
          userId: 'user123',
          ipAddress: '192.168.1.1',
          details: expect.objectContaining({
            tokenType: 'service',
          }),
        })
      );
    });

    it('logTokenRevoked logs correct event type', async () => {
      const logEventSpy = vi.spyOn(service, 'logEvent');

      await service.logTokenRevoked('user123', 'service', 'User logout');

      expect(logEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'auth.token.revoked',
          userId: 'user123',
          details: expect.objectContaining({
            tokenType: 'service',
            reason: 'User logout',
          }),
        })
      );
    });

    it('logAnomalyDetected logs correct event type with flags', async () => {
      const logEventSpy = vi.spyOn(service, 'logEvent');

      await service.logAnomalyDetected(
        'user123',
        '192.168.1.1',
        0.8,
        ['impossible_travel', 'new_device']
      );

      expect(logEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'security.anomaly.detected',
          userId: 'user123',
          ipAddress: '192.168.1.1',
          riskScore: 0.8,
          anomalyFlags: ['impossible_travel', 'new_device'],
        })
      );
    });

    it('logDataAccess logs correct event type', async () => {
      const logEventSpy = vi.spyOn(service, 'logEvent');

      await service.logDataAccess('user123', 'read', 'page', 'page456');

      expect(logEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'data.read',
          userId: 'user123',
          resourceType: 'page',
          resourceId: 'page456',
        })
      );
    });
  });

  describe('queryEvents', () => {
    it('queries events within time range', async () => {
      const mockEvents = [
        { id: 'evt1', eventType: 'auth.login.success', timestamp: new Date() },
        { id: 'evt2', eventType: 'auth.logout', timestamp: new Date() },
      ];

      const mockOrderBy = vi.fn().mockResolvedValue(mockEvents);
      const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const result = await service.queryEvents({
        fromTimestamp: new Date('2026-01-01'),
        toTimestamp: new Date('2026-01-31'),
      });

      expect(db.select).toHaveBeenCalled();
      expect(result).toEqual(mockEvents);
    });

    it('queries events by user ID', async () => {
      const mockEvents = [
        { id: 'evt1', eventType: 'auth.login.success', userId: 'user123' },
      ];

      const mockOrderBy = vi.fn().mockResolvedValue(mockEvents);
      const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const result = await service.queryEvents({ userId: 'user123' });

      expect(result).toEqual(mockEvents);
    });

    it('queries events by event type', async () => {
      const mockEvents = [
        { id: 'evt1', eventType: 'auth.login.failure' },
      ];

      const mockOrderBy = vi.fn().mockResolvedValue(mockEvents);
      const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const result = await service.queryEvents({ eventType: 'auth.login.failure' });

      expect(result).toEqual(mockEvents);
    });
  });
});

describe('Hash Chain Integrity', () => {
  it('manual verification: hash chain links events correctly', () => {
    // This test manually verifies the hash chain concept
    const event1 = {
      eventType: 'auth.login.success',
      userId: 'user1',
      timestamp: new Date('2026-01-25T10:00:00Z'),
    };

    const event2 = {
      eventType: 'auth.logout',
      userId: 'user1',
      timestamp: new Date('2026-01-25T11:00:00Z'),
    };

    // Compute hash for first event (uses genesis)
    const hash1 = computeSecurityEventHash(
      event1 as AuditEvent,
      'genesis',
      event1.timestamp
    );

    // Compute hash for second event (uses first event's hash)
    const hash2 = computeSecurityEventHash(
      event2 as AuditEvent,
      hash1,
      event2.timestamp
    );

    // Verify both hashes are valid SHA-256
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    expect(hash2).toMatch(/^[a-f0-9]{64}$/);

    // Verify changing event1 would break verification of event2
    const modifiedEvent1 = {
      ...event1,
      userId: 'hacker', // Modified!
    };

    const badHash1 = computeSecurityEventHash(
      modifiedEvent1 as AuditEvent,
      'genesis',
      event1.timestamp
    );

    // If someone tried to verify event2 with the modified event1's hash,
    // the chain would break (hashes wouldn't match)
    expect(badHash1).not.toBe(hash1);
  });
});
