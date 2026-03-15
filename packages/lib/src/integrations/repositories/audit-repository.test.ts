/**
 * Audit Log Repository Tests
 *
 * Tests for database operations on integration audit logs.
 * Imports from the actual source and mocks @pagespace/db.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @pagespace/db
const mockFindMany = vi.fn();
const mockInsertValues = vi.fn();
const mockInsertReturning = vi.fn();
const mockSelectFrom = vi.fn();
const mockSelectWhere = vi.fn();
const mockSelectGroupBy = vi.fn();

vi.mock('@pagespace/db', () => {
  const integrationAuditLog = {
    driveId: 'driveId',
    connectionId: 'connectionId',
    createdAt: 'createdAt',
    success: 'success',
    agentId: 'agentId',
    toolName: 'toolName',
    errorType: 'errorType',
  };

  return {
    db: {},
    eq: (field: string, value: unknown) => ({ eq: [field, value] }),
    and: (...conditions: unknown[]) => ({ and: conditions }),
    desc: (field: string) => ({ desc: field }),
    gte: (field: string, value: unknown) => ({ gte: [field, value] }),
    lte: (field: string, value: unknown) => ({ lte: [field, value] }),
    count: () => 'count()',
    isNotNull: (field: string) => ({ isNotNull: field }),
    integrationAuditLog,
  };
});

import {
  logAuditEntry,
  getAuditLogsByDrive,
  getAuditLogsByConnection,
  getAuditLogsByDateRange,
  getAuditLogsBySuccess,
  getAuditLogsByAgent,
  getAuditLogsByTool,
  countAuditLogsByErrorType,
} from './audit-repository';

// Helper to create a mock database with chainable methods
const createMockDb = () => {
  mockFindMany.mockReset();
  mockInsertValues.mockReset();
  mockInsertReturning.mockReset();
  mockSelectFrom.mockReset();
  mockSelectWhere.mockReset();
  mockSelectGroupBy.mockReset();

  const db = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: mockInsertReturning,
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          groupBy: mockSelectGroupBy,
        }),
      }),
    }),
    query: {
      integrationAuditLog: {
        findMany: mockFindMany,
      },
    },
  };

  return db;
};

describe('logAuditEntry', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given audit entry, should insert and return the logged entry', async () => {
    const entry = {
      driveId: 'drive-1',
      agentId: 'agent-1',
      userId: 'user-1',
      connectionId: 'conn-1',
      toolName: 'list_repos',
      inputSummary: 'owner=acme',
      success: true,
      responseCode: 200,
      errorType: null,
      errorMessage: null,
      durationMs: 150,
    };

    const expectedResult = {
      id: 'audit-123',
      ...entry,
      createdAt: new Date(),
    };

    mockInsertReturning.mockResolvedValue([expectedResult]);

    const result = await logAuditEntry(mockDb as never, entry as never);

    expect(result.id).toBe('audit-123');
    expect(result.success).toBe(true);
    expect(result.durationMs).toBe(150);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('given failed audit entry, should include error details', async () => {
    const entry = {
      driveId: 'drive-1',
      agentId: 'agent-1',
      userId: 'user-1',
      connectionId: 'conn-1',
      toolName: 'create_issue',
      inputSummary: 'title=Bug report',
      success: false,
      responseCode: 401,
      errorType: 'AUTH_ERROR',
      errorMessage: 'Invalid token',
      durationMs: 50,
    };

    const expectedResult = {
      id: 'audit-456',
      ...entry,
      createdAt: new Date(),
    };

    mockInsertReturning.mockResolvedValue([expectedResult]);

    const result = await logAuditEntry(mockDb as never, entry as never);

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('AUTH_ERROR');
    expect(result.errorMessage).toBe('Invalid token');
  });
});

describe('getAuditLogsByDrive', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given drive ID, should query recent logs for that drive', async () => {
    const logs = [
      { id: 'audit-1', driveId: 'drive-1', toolName: 'list_repos' },
      { id: 'audit-2', driveId: 'drive-1', toolName: 'create_issue' },
    ];

    mockFindMany.mockResolvedValue(logs);

    const result = await getAuditLogsByDrive(mockDb as never, 'drive-1');

    expect(result).toHaveLength(2);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100,
        offset: 0,
      })
    );
  });

  it('given drive with no logs, should return empty array', async () => {
    mockFindMany.mockResolvedValue([]);

    const result = await getAuditLogsByDrive(mockDb as never, 'drive-1');

    expect(result).toEqual([]);
  });

  it('given limit option, should respect pagination', async () => {
    mockFindMany.mockResolvedValue([]);

    await getAuditLogsByDrive(mockDb as never, 'drive-1', { limit: 10, offset: 5 });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 5 })
    );
  });
});

describe('getAuditLogsByConnection', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given connection ID, should query logs for that connection', async () => {
    const logs = [
      { id: 'audit-1', driveId: 'drive-1', connectionId: 'conn-1' },
    ];

    mockFindMany.mockResolvedValue(logs);

    const result = await getAuditLogsByConnection(mockDb as never, 'drive-1', 'conn-1');

    expect(result).toHaveLength(1);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100,
        offset: 0,
      })
    );
  });

  it('given pagination options, should pass them through', async () => {
    mockFindMany.mockResolvedValue([]);

    await getAuditLogsByConnection(mockDb as never, 'drive-1', 'conn-1', { limit: 50, offset: 10 });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, offset: 10 })
    );
  });
});

describe('getAuditLogsByDateRange', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given date range, should filter logs accordingly', async () => {
    const logs = [
      { id: 'audit-1', driveId: 'drive-1', createdAt: new Date('2025-01-15') },
    ];

    mockFindMany.mockResolvedValue(logs);

    const startDate = new Date('2025-01-01');
    const endDate = new Date('2025-01-31');

    const result = await getAuditLogsByDateRange(mockDb as never, 'drive-1', startDate, endDate);

    expect(result).toHaveLength(1);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 1000,
        offset: 0,
      })
    );
  });

  it('given pagination options, should pass them through', async () => {
    mockFindMany.mockResolvedValue([]);

    await getAuditLogsByDateRange(
      mockDb as never,
      'drive-1',
      new Date('2025-01-01'),
      new Date('2025-01-31'),
      { limit: 500, offset: 100 }
    );

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 500, offset: 100 })
    );
  });
});

describe('getAuditLogsBySuccess', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given success filter true, should query only successes', async () => {
    const logs = [
      { id: 'audit-1', driveId: 'drive-1', success: true },
    ];

    mockFindMany.mockResolvedValue(logs);

    const result = await getAuditLogsBySuccess(mockDb as never, 'drive-1', true);

    expect(result).toHaveLength(1);
    expect(mockFindMany).toHaveBeenCalled();
  });

  it('given success filter false, should query only failures', async () => {
    const logs = [
      { id: 'audit-2', driveId: 'drive-1', success: false, errorType: 'SERVER_ERROR' },
    ];

    mockFindMany.mockResolvedValue(logs);

    const result = await getAuditLogsBySuccess(mockDb as never, 'drive-1', false);

    expect(result).toHaveLength(1);
    expect(result[0].success).toBe(false);
  });
});

describe('getAuditLogsByAgent', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given agent ID, should query logs for that agent', async () => {
    const logs = [
      { id: 'audit-1', agentId: 'agent-1', toolName: 'list_repos' },
    ];

    mockFindMany.mockResolvedValue(logs);

    const result = await getAuditLogsByAgent(mockDb as never, 'agent-1');

    expect(result).toHaveLength(1);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100,
        offset: 0,
      })
    );
  });

  it('given pagination options, should pass them through', async () => {
    mockFindMany.mockResolvedValue([]);

    await getAuditLogsByAgent(mockDb as never, 'agent-1', { limit: 25, offset: 50 });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25, offset: 50 })
    );
  });
});

describe('getAuditLogsByTool', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given tool name, should query logs for that tool', async () => {
    const logs = [
      { id: 'audit-1', driveId: 'drive-1', toolName: 'list_repos' },
    ];

    mockFindMany.mockResolvedValue(logs);

    const result = await getAuditLogsByTool(mockDb as never, 'drive-1', 'list_repos');

    expect(result).toHaveLength(1);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100,
        offset: 0,
      })
    );
  });

  it('given pagination options, should pass them through', async () => {
    mockFindMany.mockResolvedValue([]);

    await getAuditLogsByTool(mockDb as never, 'drive-1', 'list_repos', { limit: 20, offset: 10 });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, offset: 10 })
    );
  });
});

describe('countAuditLogsByErrorType', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given drive ID, should count errors grouped by type', async () => {
    const rows = [
      { errorType: 'AUTH_ERROR', count: 5 },
      { errorType: 'TIMEOUT', count: 3 },
    ];

    mockSelectGroupBy.mockResolvedValue(rows);

    const result = await countAuditLogsByErrorType(mockDb as never, 'drive-1');

    expect(result).toEqual([
      { errorType: 'AUTH_ERROR', count: 5 },
      { errorType: 'TIMEOUT', count: 3 },
    ]);
  });

  it('given null errorType in row, should default to UNKNOWN_ERROR', async () => {
    const rows = [
      { errorType: null, count: 2 },
    ];

    mockSelectGroupBy.mockResolvedValue(rows);

    const result = await countAuditLogsByErrorType(mockDb as never, 'drive-1');

    expect(result).toEqual([
      { errorType: 'UNKNOWN_ERROR', count: 2 },
    ]);
  });

  it('given date range, should include date filters', async () => {
    mockSelectGroupBy.mockResolvedValue([]);

    const startDate = new Date('2025-01-01');
    const endDate = new Date('2025-01-31');

    await countAuditLogsByErrorType(mockDb as never, 'drive-1', startDate, endDate);

    expect(mockDb.select).toHaveBeenCalled();
    expect(mockSelectGroupBy).toHaveBeenCalled();
  });

  it('given only startDate, should include only startDate filter', async () => {
    mockSelectGroupBy.mockResolvedValue([]);

    const startDate = new Date('2025-01-01');

    await countAuditLogsByErrorType(mockDb as never, 'drive-1', startDate);

    expect(mockSelectGroupBy).toHaveBeenCalled();
  });

  it('given string count, should convert to number', async () => {
    const rows = [
      { errorType: 'NETWORK', count: '7' },
    ];

    mockSelectGroupBy.mockResolvedValue(rows);

    const result = await countAuditLogsByErrorType(mockDb as never, 'drive-1');

    expect(result[0].count).toBe(7);
    expect(typeof result[0].count).toBe('number');
  });
});
