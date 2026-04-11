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
      timestamp: 'timestamp',
    },
  };
});

vi.mock('@pagespace/db', () => ({
  db: mockDb,
  securityAuditLog: mockSecurityAuditLog,
  desc: vi.fn((col: string) => `desc(${col})`),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  gte: vi.fn((col: string, val: unknown) => ({ gte: [col, val] })),
  lte: vi.fn((col: string, val: unknown) => ({ lte: [col, val] })),
  eq: vi.fn((col: string, val: unknown) => ({ eq: [col, val] })),
}));

import { queryAuditEvents } from '../audit-query';
import { eq, gte, lte } from '@pagespace/db';

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

  it('given ipAddress filter, should apply eq condition on ipAddress', async () => {
    await queryAuditEvents({ ipAddress: '10.0.0.1' });

    expect(eq).toHaveBeenCalledWith(mockSecurityAuditLog.ipAddress, '10.0.0.1');
  });
});
