import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb, mockSecurityAuditLog } = vi.hoisted(() => {
  const mockLimit = vi.fn();
  const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

  return {
    mockDb: {
      select: mockSelect,
      _chain: { select: mockSelect, from: mockFrom, where: mockWhere, orderBy: mockOrderBy, limit: mockLimit },
    },
    mockSecurityAuditLog: {
      userId: 'userId',
      eventType: 'eventType',
      resourceType: 'resourceType',
      resourceId: 'resourceId',
      ipAddress: 'ipAddress',
      ipBidx: 'ipBidx',
      timestamp: 'timestamp',
    },
  };
});

vi.mock('@pagespace/db/db', () => ({
  db: mockDb,
}));
vi.mock('@pagespace/db/schema/security-audit', () => ({
  securityAuditLog: mockSecurityAuditLog,
}));
vi.mock('@pagespace/db/operators', () => ({
  desc: vi.fn((col: string) => `desc(${col})`),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  gte: vi.fn((col: string, val: unknown) => ({ gte: [col, val] })),
  lte: vi.fn((col: string, val: unknown) => ({ lte: [col, val] })),
  eq: vi.fn((col: string, val: unknown) => ({ eq: [col, val] })),
}));

import { queryAuditEvents } from '../audit-query';
import { eq, or, gte, lte } from '@pagespace/db/operators';

describe('queryAuditEvents()', () => {
  const mockEvents = [
    { id: 'evt-1', eventType: 'auth.login.success', userId: 'user-1' },
    { id: 'evt-2', eventType: 'auth.logout', userId: 'user-1' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the chain: orderBy resolves to mockEvents by default (no limit)
    mockDb._chain.orderBy.mockResolvedValue(mockEvents);
    mockDb._chain.limit.mockResolvedValue(mockEvents);
    mockDb._chain.where.mockReturnValue({ orderBy: mockDb._chain.orderBy });
    mockDb._chain.from.mockReturnValue({ where: mockDb._chain.where });
    mockDb._chain.select.mockReturnValue({ from: mockDb._chain.from });
  });

  it('given no filters, should return all events ordered by timestamp desc', async () => {
    const result = await queryAuditEvents({});

    expect(mockDb.select).toHaveBeenCalled();
    expect(result).toEqual(mockEvents);
  });

  it('given userId filter, should apply eq condition on userId', async () => {
    await queryAuditEvents({ userId: 'user-1' });

    expect(eq).toHaveBeenCalledWith(mockSecurityAuditLog.userId, 'user-1');
  });

  it('given eventType filter, should apply eq condition on eventType', async () => {
    await queryAuditEvents({ eventType: 'auth.login.failure' });

    expect(eq).toHaveBeenCalledWith(mockSecurityAuditLog.eventType, 'auth.login.failure');
  });

  it('given fromTimestamp filter, should apply gte condition', async () => {
    const from = new Date('2026-01-01');
    await queryAuditEvents({ fromTimestamp: from });

    expect(gte).toHaveBeenCalledWith(mockSecurityAuditLog.timestamp, from);
  });

  it('given toTimestamp filter, should apply lte condition', async () => {
    const to = new Date('2026-01-31');
    await queryAuditEvents({ toTimestamp: to });

    expect(lte).toHaveBeenCalledWith(mockSecurityAuditLog.timestamp, to);
  });

  it('given limit, should apply limit to query', async () => {
    mockDb._chain.orderBy.mockReturnValue({ limit: mockDb._chain.limit });
    mockDb._chain.limit.mockResolvedValue([mockEvents[0]]);

    const result = await queryAuditEvents({ limit: 1 });

    expect(mockDb._chain.limit).toHaveBeenCalledWith(1);
    expect(result).toEqual([mockEvents[0]]);
  });

  it('given resourceType and resourceId filters, should apply both conditions', async () => {
    await queryAuditEvents({ resourceType: 'page', resourceId: 'page-1' });

    expect(eq).toHaveBeenCalledWith(mockSecurityAuditLog.resourceType, 'page');
    expect(eq).toHaveBeenCalledWith(mockSecurityAuditLog.resourceId, 'page-1');
  });

  it('given ipAddress filter with no ENCRYPTION_KEY, should apply a plain eq on ipAddress', async () => {
    const prev = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      await queryAuditEvents({ ipAddress: '10.0.0.1' });
      expect(eq).toHaveBeenCalledWith(mockSecurityAuditLog.ipAddress, '10.0.0.1');
      expect(or).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.ENCRYPTION_KEY = prev;
    }
  });

  it('given ipAddress filter with a key, should match by blind index OR legacy plaintext', async () => {
    const prev = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'audit-query-test-master-key-at-least-32!!';
    try {
      await queryAuditEvents({ ipAddress: '10.0.0.1' });
      // Dual filter: blind-index match for encrypted rows + plaintext for legacy.
      expect(or).toHaveBeenCalled();
      expect(eq).toHaveBeenCalledWith(mockSecurityAuditLog.ipBidx, expect.stringMatching(/^[0-9a-f]{64}$/));
      expect(eq).toHaveBeenCalledWith(mockSecurityAuditLog.ipAddress, '10.0.0.1');
    } finally {
      if (prev === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = prev;
    }
  });

  it('given an undecryptable IP row, should not fail the whole query (per-row fallback)', async () => {
    const prev = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'audit-query-test-master-key-at-least-32!!';
    // Ciphertext-shaped (passes looksEncrypted) but invalid → decrypt throws.
    const bogus = `${'a'.repeat(64)}:${'a'.repeat(32)}:${'a'.repeat(32)}:abcd`;
    const rows = [
      { id: 'ok', ipAddress: '10.0.0.9' },
      { id: 'bad', ipAddress: bogus },
    ];
    mockDb._chain.orderBy.mockResolvedValue(rows);
    try {
      const result = await queryAuditEvents({});
      expect(result).toHaveLength(2);
      // The bad row falls back to its stored value rather than throwing.
      expect(result.find((r) => (r as { id: string }).id === 'bad')!.ipAddress).toBe(bogus);
    } finally {
      if (prev === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = prev;
    }
  });

  it('given limit: 0, should apply limit(0) to query', async () => {
    mockDb._chain.orderBy.mockReturnValue({ limit: mockDb._chain.limit });
    mockDb._chain.limit.mockResolvedValue([]);

    const result = await queryAuditEvents({ limit: 0 });

    expect(mockDb._chain.limit).toHaveBeenCalledWith(0);
    expect(result).toEqual([]);
  });

  it('given negative limit, should throw an error', async () => {
    await expect(queryAuditEvents({ limit: -1 })).rejects.toThrow(
      'limit must be a non-negative integer'
    );
  });

  it('given non-integer limit, should throw an error', async () => {
    await expect(queryAuditEvents({ limit: 1.5 })).rejects.toThrow(
      'limit must be a non-negative integer'
    );
  });
});
