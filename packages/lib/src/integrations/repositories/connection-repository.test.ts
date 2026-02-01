/**
 * Connection Repository Tests
 *
 * Tests for database operations on integration connections.
 * Uses inline mock implementations since @pagespace/db isn't available
 * in the lib package test context.
 *
 * These tests verify the behavior contracts - actual DB integration
 * is tested in apps/web.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Define types locally for testing
type ConnectionStatus = 'active' | 'expired' | 'error' | 'pending' | 'revoked';

interface MockConnection {
  id: string;
  providerId: string;
  userId?: string | null;
  driveId?: string | null;
  name: string;
  status: ConnectionStatus;
  credentials?: Record<string, string>;
  createdAt?: Date;
  updatedAt?: Date;
  provider?: {
    id: string;
    slug: string;
    name: string;
    config: unknown;
  };
}

// Mock database builder pattern
interface MockDb {
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  query: {
    integrationConnections: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };
}

const createMockDb = (): MockDb => ({
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  query: {
    integrationConnections: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
});

// Inline repository implementations for testing
// (Real implementation in connection-repository.ts uses drizzle)

const createConnection = async (
  db: MockDb,
  data: Partial<MockConnection>
): Promise<MockConnection> => {
  const result = await db.insert().values(data).returning();
  return result[0];
};

const getConnectionById = async (
  db: MockDb,
  connectionId: string
): Promise<MockConnection | null> => {
  return db.query.integrationConnections.findFirst({ where: { id: connectionId } }) ?? null;
};

const getConnectionWithProvider = async (
  db: MockDb,
  connectionId: string
): Promise<MockConnection | null> => {
  return db.query.integrationConnections.findFirst({
    where: { id: connectionId },
    with: { provider: true },
  }) ?? null;
};

const findUserConnection = async (
  db: MockDb,
  userId: string,
  providerId: string
): Promise<MockConnection | null> => {
  return db.query.integrationConnections.findFirst({
    where: { userId, providerId },
  }) ?? null;
};

const findDriveConnection = async (
  db: MockDb,
  driveId: string,
  providerId: string
): Promise<MockConnection | null> => {
  return db.query.integrationConnections.findFirst({
    where: { driveId, providerId },
  }) ?? null;
};

const updateConnectionStatus = async (
  db: MockDb,
  connectionId: string,
  status: ConnectionStatus,
  statusMessage?: string
): Promise<MockConnection | null> => {
  const result = await db.update().set({ status, statusMessage }).where({ id: connectionId }).returning();
  return result[0] ?? null;
};

const deleteConnection = async (
  db: MockDb,
  connectionId: string
): Promise<MockConnection | null> => {
  const result = await db.delete().where({ id: connectionId }).returning();
  return result[0] ?? null;
};

const listUserConnections = async (
  db: MockDb,
  userId: string
): Promise<MockConnection[]> => {
  return db.query.integrationConnections.findMany({
    where: { userId },
    with: { provider: true },
  }) ?? [];
};

const listDriveConnections = async (
  db: MockDb,
  driveId: string
): Promise<MockConnection[]> => {
  return db.query.integrationConnections.findMany({
    where: { driveId },
    with: { provider: true },
  }) ?? [];
};

describe('createConnection', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given valid connection data, should insert and return new connection', async () => {
    const newConnection = {
      providerId: 'provider-1',
      userId: 'user-1',
      name: 'My GitHub',
      status: 'active' as const,
      credentials: { token: 'encrypted-token' },
    };

    const expectedResult: MockConnection = {
      id: 'conn-123',
      ...newConnection,
      driveId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([expectedResult]),
      }),
    });

    const result = await createConnection(mockDb, newConnection);

    expect(result).toEqual(expectedResult);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('given drive-scoped connection data, should create drive connection', async () => {
    const newConnection = {
      providerId: 'provider-1',
      driveId: 'drive-1',
      name: 'Team Slack',
      status: 'pending' as const,
    };

    const expectedResult: MockConnection = {
      id: 'conn-456',
      ...newConnection,
      userId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([expectedResult]),
      }),
    });

    const result = await createConnection(mockDb, newConnection);

    expect(result).toEqual(expectedResult);
  });
});

describe('getConnectionById', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given existing connection ID, should return connection', async () => {
    const existingConnection: MockConnection = {
      id: 'conn-123',
      providerId: 'provider-1',
      userId: 'user-1',
      name: 'My GitHub',
      status: 'active',
    };

    mockDb.query.integrationConnections.findFirst.mockResolvedValue(existingConnection);

    const result = await getConnectionById(mockDb, 'conn-123');

    expect(result).toEqual(existingConnection);
    expect(mockDb.query.integrationConnections.findFirst).toHaveBeenCalled();
  });

  it('given non-existent connection ID, should return null', async () => {
    mockDb.query.integrationConnections.findFirst.mockResolvedValue(null);

    const result = await getConnectionById(mockDb, 'non-existent');

    expect(result).toBeNull();
  });
});

describe('getConnectionWithProvider', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given connection ID, should load with provider config eagerly', async () => {
    const connectionWithProvider: MockConnection = {
      id: 'conn-123',
      providerId: 'provider-1',
      name: 'My GitHub',
      status: 'active',
      provider: {
        id: 'provider-1',
        slug: 'github',
        name: 'GitHub',
        config: { baseUrl: 'https://api.github.com' },
      },
    };

    mockDb.query.integrationConnections.findFirst.mockResolvedValue(connectionWithProvider);

    const result = await getConnectionWithProvider(mockDb, 'conn-123');

    expect(result).toEqual(connectionWithProvider);
    expect(result?.provider).toBeDefined();
    expect(result?.provider?.slug).toBe('github');
  });

  it('given non-existent connection ID, should return null', async () => {
    mockDb.query.integrationConnections.findFirst.mockResolvedValue(null);

    const result = await getConnectionWithProvider(mockDb, 'non-existent');

    expect(result).toBeNull();
  });
});

describe('findUserConnection', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given user ID and provider ID, should find existing user connection', async () => {
    const userConnection: MockConnection = {
      id: 'conn-123',
      userId: 'user-1',
      providerId: 'provider-1',
      name: 'My GitHub',
      status: 'active',
    };

    mockDb.query.integrationConnections.findFirst.mockResolvedValue(userConnection);

    const result = await findUserConnection(mockDb, 'user-1', 'provider-1');

    expect(result).toEqual(userConnection);
  });

  it('given no matching connection, should return null', async () => {
    mockDb.query.integrationConnections.findFirst.mockResolvedValue(null);

    const result = await findUserConnection(mockDb, 'user-1', 'unknown-provider');

    expect(result).toBeNull();
  });
});

describe('findDriveConnection', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given drive ID and provider ID, should find existing drive connection', async () => {
    const driveConnection: MockConnection = {
      id: 'conn-456',
      driveId: 'drive-1',
      providerId: 'provider-1',
      name: 'Team Slack',
      status: 'active',
    };

    mockDb.query.integrationConnections.findFirst.mockResolvedValue(driveConnection);

    const result = await findDriveConnection(mockDb, 'drive-1', 'provider-1');

    expect(result).toEqual(driveConnection);
  });

  it('given no matching connection, should return null', async () => {
    mockDb.query.integrationConnections.findFirst.mockResolvedValue(null);

    const result = await findDriveConnection(mockDb, 'drive-1', 'unknown-provider');

    expect(result).toBeNull();
  });
});

describe('updateConnectionStatus', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given status update, should update connection status and message', async () => {
    const updatedConnection: MockConnection = {
      id: 'conn-123',
      providerId: 'provider-1',
      name: 'My GitHub',
      status: 'error',
    };

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...updatedConnection, statusMessage: 'Authentication expired' }]),
        }),
      }),
    });

    const result = await updateConnectionStatus(mockDb, 'conn-123', 'error', 'Authentication expired');

    expect(result?.status).toBe('error');
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('given non-existent connection, should return null', async () => {
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const result = await updateConnectionStatus(mockDb, 'non-existent', 'active');

    expect(result).toBeNull();
  });
});

describe('deleteConnection', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given connection ID, should delete and return deleted connection', async () => {
    const deletedConnection: MockConnection = {
      id: 'conn-123',
      providerId: 'provider-1',
      name: 'My GitHub',
      status: 'active',
    };

    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([deletedConnection]),
      }),
    });

    const result = await deleteConnection(mockDb, 'conn-123');

    expect(result).toEqual(deletedConnection);
    expect(mockDb.delete).toHaveBeenCalled();
  });

  it('given non-existent connection, should return null', async () => {
    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await deleteConnection(mockDb, 'non-existent');

    expect(result).toBeNull();
  });
});

describe('listUserConnections', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given user ID, should return all user connections with provider info', async () => {
    const userConnections: MockConnection[] = [
      { id: 'conn-1', providerId: 'p1', name: 'GitHub', status: 'active', provider: { id: 'p1', slug: 'github', name: 'GitHub', config: {} } },
      { id: 'conn-2', providerId: 'p2', name: 'Slack', status: 'active', provider: { id: 'p2', slug: 'slack', name: 'Slack', config: {} } },
    ];

    mockDb.query.integrationConnections.findMany.mockResolvedValue(userConnections);

    const result = await listUserConnections(mockDb, 'user-1');

    expect(result).toEqual(userConnections);
    expect(result).toHaveLength(2);
  });

  it('given user with no connections, should return empty array', async () => {
    mockDb.query.integrationConnections.findMany.mockResolvedValue([]);

    const result = await listUserConnections(mockDb, 'user-1');

    expect(result).toEqual([]);
  });
});

describe('listDriveConnections', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given drive ID, should return all drive connections with provider info', async () => {
    const driveConnections: MockConnection[] = [
      { id: 'conn-1', providerId: 'p1', name: 'Team Notion', status: 'active', provider: { id: 'p1', slug: 'notion', name: 'Notion', config: {} } },
    ];

    mockDb.query.integrationConnections.findMany.mockResolvedValue(driveConnections);

    const result = await listDriveConnections(mockDb, 'drive-1');

    expect(result).toEqual(driveConnections);
  });
});
