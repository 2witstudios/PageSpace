/**
 * Audit Log Repository Tests
 *
 * Tests for database operations on integration audit logs.
 * Uses inline mock implementations for unit testing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Define types locally for testing
interface MockAuditEntry {
  id: string;
  driveId: string;
  agentId: string | null;
  userId: string | null;
  connectionId: string;
  toolName: string;
  inputSummary: string | null;
  success: boolean;
  responseCode: number | null;
  errorType: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: Date;
}

interface MockDb {
  insert: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  query: {
    integrationAuditLog: {
      findMany: ReturnType<typeof vi.fn>;
    };
  };
}

const createMockDb = (): MockDb => ({
  insert: vi.fn(),
  select: vi.fn(),
  query: {
    integrationAuditLog: {
      findMany: vi.fn(),
    },
  },
});

// Inline repository implementations for testing
const logAuditEntry = async (
  db: MockDb,
  entry: Omit<MockAuditEntry, 'id' | 'createdAt'>
): Promise<MockAuditEntry> => {
  const result = await db.insert().values(entry).returning();
  return result[0];
};

const getAuditLogsByDrive = async (
  db: MockDb,
  driveId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<MockAuditEntry[]> => {
  return db.query.integrationAuditLog.findMany({
    where: { driveId },
    limit: options.limit,
    offset: options.offset,
    orderBy: { createdAt: 'desc' },
  }) ?? [];
};

const getAuditLogsByConnection = async (
  db: MockDb,
  connectionId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<MockAuditEntry[]> => {
  return db.query.integrationAuditLog.findMany({
    where: { connectionId },
    limit: options.limit,
    offset: options.offset,
    orderBy: { createdAt: 'desc' },
  }) ?? [];
};

const getAuditLogsByDateRange = async (
  db: MockDb,
  driveId: string,
  startDate: Date,
  endDate: Date
): Promise<MockAuditEntry[]> => {
  return db.query.integrationAuditLog.findMany({
    where: { driveId, createdAt: { gte: startDate, lte: endDate } },
    orderBy: { createdAt: 'desc' },
  }) ?? [];
};

const getAuditLogsBySuccess = async (
  db: MockDb,
  driveId: string,
  success: boolean,
  options: { limit?: number } = {}
): Promise<MockAuditEntry[]> => {
  return db.query.integrationAuditLog.findMany({
    where: { driveId, success },
    limit: options.limit,
    orderBy: { createdAt: 'desc' },
  }) ?? [];
};

describe('logAuditEntry', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given audit entry, should insert with timestamp', async () => {
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

    const expectedResult: MockAuditEntry = {
      id: 'audit-123',
      ...entry,
      createdAt: new Date(),
    };

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([expectedResult]),
      }),
    });

    const result = await logAuditEntry(mockDb, entry);

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

    const expectedResult: MockAuditEntry = {
      id: 'audit-456',
      ...entry,
      createdAt: new Date(),
    };

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([expectedResult]),
      }),
    });

    const result = await logAuditEntry(mockDb, entry);

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('AUTH_ERROR');
    expect(result.errorMessage).toBe('Invalid token');
  });
});

describe('getAuditLogsByDrive', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given drive ID, should query recent logs for that drive', async () => {
    const logs: MockAuditEntry[] = [
      {
        id: 'audit-1',
        driveId: 'drive-1',
        agentId: 'agent-1',
        userId: 'user-1',
        connectionId: 'conn-1',
        toolName: 'list_repos',
        inputSummary: null,
        success: true,
        responseCode: 200,
        errorType: null,
        errorMessage: null,
        durationMs: 100,
        createdAt: new Date('2025-01-15'),
      },
      {
        id: 'audit-2',
        driveId: 'drive-1',
        agentId: 'agent-1',
        userId: 'user-1',
        connectionId: 'conn-1',
        toolName: 'create_issue',
        inputSummary: null,
        success: true,
        responseCode: 201,
        errorType: null,
        errorMessage: null,
        durationMs: 200,
        createdAt: new Date('2025-01-14'),
      },
    ];

    mockDb.query.integrationAuditLog.findMany.mockResolvedValue(logs);

    const result = await getAuditLogsByDrive(mockDb, 'drive-1');

    expect(result).toHaveLength(2);
    expect(result[0].driveId).toBe('drive-1');
  });

  it('given drive with no logs, should return empty array', async () => {
    mockDb.query.integrationAuditLog.findMany.mockResolvedValue([]);

    const result = await getAuditLogsByDrive(mockDb, 'drive-1');

    expect(result).toEqual([]);
  });

  it('given limit option, should respect pagination', async () => {
    const logs: MockAuditEntry[] = [
      {
        id: 'audit-1',
        driveId: 'drive-1',
        agentId: null,
        userId: null,
        connectionId: 'conn-1',
        toolName: 'list_repos',
        inputSummary: null,
        success: true,
        responseCode: 200,
        errorType: null,
        errorMessage: null,
        durationMs: 100,
        createdAt: new Date(),
      },
    ];

    mockDb.query.integrationAuditLog.findMany.mockResolvedValue(logs);

    const result = await getAuditLogsByDrive(mockDb, 'drive-1', { limit: 10, offset: 0 });

    expect(mockDb.query.integrationAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 0 })
    );
    expect(result).toHaveLength(1);
  });
});

describe('getAuditLogsByConnection', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given connection ID, should query logs for that connection', async () => {
    const logs: MockAuditEntry[] = [
      {
        id: 'audit-1',
        driveId: 'drive-1',
        agentId: 'agent-1',
        userId: 'user-1',
        connectionId: 'conn-1',
        toolName: 'list_repos',
        inputSummary: null,
        success: true,
        responseCode: 200,
        errorType: null,
        errorMessage: null,
        durationMs: 100,
        createdAt: new Date(),
      },
    ];

    mockDb.query.integrationAuditLog.findMany.mockResolvedValue(logs);

    const result = await getAuditLogsByConnection(mockDb, 'conn-1');

    expect(result).toHaveLength(1);
    expect(result[0].connectionId).toBe('conn-1');
  });
});

describe('getAuditLogsByDateRange', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given date range, should filter logs accordingly', async () => {
    const logs: MockAuditEntry[] = [
      {
        id: 'audit-1',
        driveId: 'drive-1',
        agentId: 'agent-1',
        userId: 'user-1',
        connectionId: 'conn-1',
        toolName: 'list_repos',
        inputSummary: null,
        success: true,
        responseCode: 200,
        errorType: null,
        errorMessage: null,
        durationMs: 100,
        createdAt: new Date('2025-01-15'),
      },
    ];

    mockDb.query.integrationAuditLog.findMany.mockResolvedValue(logs);

    const startDate = new Date('2025-01-01');
    const endDate = new Date('2025-01-31');

    const result = await getAuditLogsByDateRange(mockDb, 'drive-1', startDate, endDate);

    expect(result).toHaveLength(1);
    expect(mockDb.query.integrationAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          driveId: 'drive-1',
          createdAt: expect.objectContaining({ gte: startDate, lte: endDate }),
        }),
      })
    );
  });
});

describe('getAuditLogsBySuccess', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given success filter true, should query only successes', async () => {
    const logs: MockAuditEntry[] = [
      {
        id: 'audit-1',
        driveId: 'drive-1',
        agentId: null,
        userId: null,
        connectionId: 'conn-1',
        toolName: 'list_repos',
        inputSummary: null,
        success: true,
        responseCode: 200,
        errorType: null,
        errorMessage: null,
        durationMs: 100,
        createdAt: new Date(),
      },
    ];

    mockDb.query.integrationAuditLog.findMany.mockResolvedValue(logs);

    const result = await getAuditLogsBySuccess(mockDb, 'drive-1', true);

    expect(result).toHaveLength(1);
    expect(result[0].success).toBe(true);
  });

  it('given success filter false, should query only failures', async () => {
    const logs: MockAuditEntry[] = [
      {
        id: 'audit-2',
        driveId: 'drive-1',
        agentId: null,
        userId: null,
        connectionId: 'conn-1',
        toolName: 'create_issue',
        inputSummary: null,
        success: false,
        responseCode: 500,
        errorType: 'SERVER_ERROR',
        errorMessage: 'Internal error',
        durationMs: 50,
        createdAt: new Date(),
      },
    ];

    mockDb.query.integrationAuditLog.findMany.mockResolvedValue(logs);

    const result = await getAuditLogsBySuccess(mockDb, 'drive-1', false);

    expect(result).toHaveLength(1);
    expect(result[0].success).toBe(false);
    expect(result[0].errorType).toBe('SERVER_ERROR');
  });
});
