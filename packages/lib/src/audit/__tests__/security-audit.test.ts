import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

// Use vi.hoisted to create shared state that can be accessed from the hoisted mock
const { testState, createMockTxFn } = vi.hoisted(() => {
  const state = {
    capturedInserts: [] as Array<{ previousHash: string; eventHash: string }>,
    executedSql: [] as Array<{ strings: TemplateStringsArray; values: unknown[] }>,
  };

  const createMockTx = () => {
    return {
      execute: (sqlObj: { strings: TemplateStringsArray; values: unknown[] }) => {
        state.executedSql.push(sqlObj);
        return Promise.resolve({ rows: [] });
      },
      insert: () => ({
        values: (value: { previousHash: string; eventHash: string }) => {
          state.capturedInserts.push({
            previousHash: value.previousHash,
            eventHash: value.eventHash,
          });
          return Promise.resolve(undefined);
        },
      }),
    };
  };

  return { testState: state, createMockTxFn: createMockTx };
});

// Mock the database module
vi.mock('@pagespace/db', () => {
  return {
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
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn(),
            }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transaction: vi.fn().mockImplementation(async (callback: any) => {
        const tx = createMockTxFn();
        return callback(tx);
      }),
    },
    securityAuditLog: {},
    desc: vi.fn(),
    and: vi.fn(),
    gte: vi.fn(),
    lte: vi.fn(),
    eq: vi.fn(),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  };
});

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
    // Restore transaction implementation after clearAllMocks removes it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(db.transaction).mockImplementation(async (callback: any) => {
      const tx = createMockTxFn();
      return callback(tx);
    });
    testState.capturedInserts.length = 0;
    testState.executedSql.length = 0;
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

    it('produces the same hash regardless of key order in details (canonical JSON)', () => {
      const timestamp = new Date('2026-01-25T10:00:00Z');
      const base = {
        eventType: 'auth.login.success' as const,
        serviceId: 'web',
        resourceType: 'page',
        resourceId: 'page-1',
      };

      // Simulate write-time key order vs Postgres JSONB read-back with different order
      const hashA = computeSecurityEventHash(
        { ...base, details: { action: 'export', format: 'pdf', userId: 'u1' } },
        'genesis',
        timestamp
      );
      const hashB = computeSecurityEventHash(
        { ...base, details: { userId: 'u1', format: 'pdf', action: 'export' } },
        'genesis',
        timestamp
      );

      expect(hashA).toBe(hashB);
    });

    it('produces the same hash regardless of key order in nested details objects', () => {
      const timestamp = new Date('2026-01-25T10:00:00Z');
      const base = { eventType: 'data.read' as const };

      const hashA = computeSecurityEventHash(
        { ...base, details: { meta: { z: 1, a: 2 }, top: 'value' } },
        'prev',
        timestamp
      );
      const hashB = computeSecurityEventHash(
        { ...base, details: { top: 'value', meta: { a: 2, z: 1 } } },
        'prev',
        timestamp
      );

      expect(hashA).toBe(hashB);
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

    it('logs events with hash chain using transaction', async () => {
      await service.logEvent({
        eventType: 'auth.login.success',
        userId: 'user123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      // Transaction was called for atomic insert with row locking
      expect(db.transaction).toHaveBeenCalled();
      expect(db.transaction).toHaveBeenCalledWith(expect.any(Function));
    });

    it('uses transaction for each event to ensure atomic insert with row locking', async () => {
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

      // Both events should have used transactions
      expect(db.transaction).toHaveBeenCalledTimes(2);
      // Each transaction callback should have been invoked
      expect(db.transaction).toHaveBeenCalledWith(expect.any(Function));
    });

    it('handles concurrent logging (all use transactions)', async () => {
      await Promise.all([
        service.logEvent({ eventType: 'auth.login.success', userId: 'user1' }),
        service.logEvent({ eventType: 'auth.login.success', userId: 'user2' }),
        service.logEvent({ eventType: 'auth.login.success', userId: 'user3' }),
      ]);

      expect(db.transaction).toHaveBeenCalledTimes(3);
    });

    it('acquires advisory lock before reading last hash (#542)', async () => {
      await service.logEvent({
        eventType: 'auth.login.success',
        userId: 'user123',
      });

      // First SQL execute call should be the advisory lock
      expect(testState.executedSql.length).toBeGreaterThanOrEqual(2);
      const lockSql = testState.executedSql[0];
      expect(lockSql).toBeDefined();
      // The template string should contain pg_advisory_xact_lock
      const joinedSql = lockSql!.strings.join('');
      expect(joinedSql).toContain('pg_advisory_xact_lock');
    });

    it('uses fixed lock key for all events (#542)', async () => {
      expect(SecurityAuditService.CHAIN_LOCK_KEY).toBe(8370291546);
    });

    it('reads latest hash after acquiring lock, not with FOR UPDATE (#542)', async () => {
      await service.logEvent({
        eventType: 'auth.login.success',
        userId: 'user123',
      });

      // Second SQL call reads latest hash (without FOR UPDATE)
      const selectSql = testState.executedSql[1];
      expect(selectSql).toBeDefined();
      const joinedSql = selectSql!.strings.join('');
      expect(joinedSql).toContain('SELECT');
      expect(joinedSql).toContain('event_hash');
      expect(joinedSql).not.toContain('FOR UPDATE');
    });
  });

  describe('convenience methods', () => {
    beforeEach(async () => {
      vi.mocked(db.query.securityAuditLog.findFirst).mockResolvedValue(undefined);
      await service.initialize();
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

    it('applies limit when specified', async () => {
      const mockEvents = [
        { id: 'evt1', eventType: 'auth.login.success' },
      ];

      const mockLimit = vi.fn().mockResolvedValue(mockEvents);
      const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const result = await service.queryEvents({ limit: 10 });

      expect(mockLimit).toHaveBeenCalledWith(10);
      expect(result).toEqual(mockEvents);
    });
  });
});

describe('Hash Chain Integrity', () => {
  it('manual verification: hash chain links events correctly', () => {
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

    const hash1 = computeSecurityEventHash(
      event1 as AuditEvent,
      'genesis',
      event1.timestamp
    );

    const hash2 = computeSecurityEventHash(
      event2 as AuditEvent,
      hash1,
      event2.timestamp
    );

    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    expect(hash2).toMatch(/^[a-f0-9]{64}$/);

    // Changing event type (non-PII) breaks the chain
    const modifiedEvent1 = {
      ...event1,
      eventType: 'auth.login.failure',
    };

    const badHash1 = computeSecurityEventHash(
      modifiedEvent1 as AuditEvent,
      'genesis',
      event1.timestamp
    );

    expect(badHash1).not.toBe(hash1);
  });
});

describe('GDPR-Safe Hash Chain (#541)', () => {
  it('hash is stable after userId is anonymized (nulled)', () => {
    const timestamp = new Date('2026-01-25T10:00:00Z');
    const event: AuditEvent = {
      eventType: 'auth.login.success',
      userId: 'user123',
      ipAddress: '192.168.1.1',
      userAgent: 'Mozilla/5.0',
      sessionId: 'sess-abc',
      geoLocation: 'US-CA',
    };

    const hashBefore = computeSecurityEventHash(event, 'genesis', timestamp);

    const anonymizedEvent: AuditEvent = {
      ...event,
      userId: undefined,
      ipAddress: undefined,
      userAgent: undefined,
      sessionId: undefined,
      geoLocation: undefined,
    };

    const hashAfter = computeSecurityEventHash(anonymizedEvent, 'genesis', timestamp);

    expect(hashBefore).toBe(hashAfter);
  });

  it('hash changes when non-PII fields change', () => {
    const timestamp = new Date('2026-01-25T10:00:00Z');
    const event1: AuditEvent = {
      eventType: 'auth.login.success',
      userId: 'user123',
      resourceType: 'page',
      resourceId: 'page-1',
    };

    const event2: AuditEvent = {
      ...event1,
      resourceId: 'page-2',
    };

    const hash1 = computeSecurityEventHash(event1, 'genesis', timestamp);
    const hash2 = computeSecurityEventHash(event2, 'genesis', timestamp);

    expect(hash1).not.toBe(hash2);
  });

  it('PII fields are excluded: changing them does not change hash', () => {
    const timestamp = new Date('2026-01-25T10:00:00Z');
    const base: AuditEvent = {
      eventType: 'data.read',
      resourceType: 'page',
      resourceId: 'page-1',
      riskScore: 0.5,
      details: { action: 'export' },
    };

    const withPII: AuditEvent = {
      ...base,
      userId: 'user-xyz',
      ipAddress: '10.0.0.1',
      userAgent: 'Chrome/120',
      sessionId: 'sess-999',
      geoLocation: 'DE-BE',
    };

    const withoutPII: AuditEvent = {
      ...base,
    };

    const hash1 = computeSecurityEventHash(withPII, 'prev-hash', timestamp);
    const hash2 = computeSecurityEventHash(withoutPII, 'prev-hash', timestamp);

    expect(hash1).toBe(hash2);
  });

  it('non-PII fields that remain in hash: eventType, resourceType, resourceId, details, riskScore, anomalyFlags, serviceId', () => {
    const timestamp = new Date('2026-01-25T10:00:00Z');

    const event1: AuditEvent = {
      eventType: 'auth.login.success',
      serviceId: 'web',
      resourceType: 'drive',
      resourceId: 'drv-1',
      details: { browser: 'Chrome' },
      riskScore: 0.3,
      anomalyFlags: ['new_device'],
    };

    const event2: AuditEvent = {
      ...event1,
      serviceId: 'api',
    };

    const hash1 = computeSecurityEventHash(event1, 'genesis', timestamp);
    const hash2 = computeSecurityEventHash(event2, 'genesis', timestamp);

    expect(hash1).not.toBe(hash2);
  });

  it('resourceId containing userId cannot be anonymized without breaking chain', () => {
    const timestamp = new Date('2026-01-25T10:00:00Z');
    const userId = 'user-abc-123';

    // Simulates the bug: passing userId as resourceId
    const eventWithUserIdInResource: AuditEvent = {
      eventType: 'data.read',
      userId,
      resourceType: 'inbox',
      resourceId: userId,
    };

    const hashBefore = computeSecurityEventHash(eventWithUserIdInResource, 'genesis', timestamp);

    // After GDPR anonymization: userId column nulled, but resourceId remains
    const anonymizedEvent: AuditEvent = {
      ...eventWithUserIdInResource,
      userId: undefined,
      // resourceId still contains the userId — can't be nulled without breaking hash
    };

    const hashAfter = computeSecurityEventHash(anonymizedEvent, 'genesis', timestamp);

    // Hash is stable (userId excluded) but resourceId still leaks the user ID
    expect(hashBefore).toBe(hashAfter);
    // The PII is permanently embedded — this is why callers must use 'self' instead
    expect(anonymizedEvent.resourceId).toBe(userId);
  });

  it('using "self" as resourceId avoids PII in hash-protected fields', () => {
    const timestamp = new Date('2026-01-25T10:00:00Z');

    const event: AuditEvent = {
      eventType: 'data.read',
      userId: 'user-abc-123',
      resourceType: 'inbox',
      resourceId: 'self',
    };

    const hashBefore = computeSecurityEventHash(event, 'genesis', timestamp);

    // After GDPR anonymization: only PII fields nulled
    const anonymizedEvent: AuditEvent = {
      ...event,
      userId: undefined,
    };

    const hashAfter = computeSecurityEventHash(anonymizedEvent, 'genesis', timestamp);

    // Hash stable AND no PII remains anywhere in the record
    expect(hashBefore).toBe(hashAfter);
    expect(anonymizedEvent.resourceId).toBe('self');
  });
});
