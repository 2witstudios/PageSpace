/**
 * Grant Repository Tests
 *
 * Tests for database operations on integration tool grants.
 * Uses inline mock implementations for unit testing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Define types locally for testing
interface MockGrant {
  id: string;
  agentId: string;
  connectionId: string;
  allowedTools: string[] | null;
  deniedTools: string[] | null;
  readOnly: boolean;
  rateLimitOverride?: { requestsPerMinute: number } | null;
  createdAt?: Date;
  connection?: MockConnection;
  agent?: MockAgent;
}

interface MockConnection {
  id: string;
  name: string;
  status: string;
  provider?: { slug: string; name: string };
}

interface MockAgent {
  id: string;
  title: string;
}

interface MockDb {
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  query: {
    integrationToolGrants: {
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
    integrationToolGrants: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
});

// Inline repository implementations for testing
const createGrant = async (
  db: MockDb,
  data: Partial<MockGrant>
): Promise<MockGrant> => {
  const result = await db.insert().values(data).returning();
  return result[0];
};

const getGrantById = async (
  db: MockDb,
  grantId: string
): Promise<MockGrant | null> => {
  return db.query.integrationToolGrants.findFirst({ where: { id: grantId } }) ?? null;
};

const findGrant = async (
  db: MockDb,
  agentId: string,
  connectionId: string
): Promise<MockGrant | null> => {
  return db.query.integrationToolGrants.findFirst({
    where: { agentId, connectionId },
  }) ?? null;
};

const listGrantsByAgent = async (
  db: MockDb,
  agentId: string
): Promise<MockGrant[]> => {
  return db.query.integrationToolGrants.findMany({
    where: { agentId },
    with: { connection: { with: { provider: true } } },
  }) ?? [];
};

const listGrantsByConnection = async (
  db: MockDb,
  connectionId: string
): Promise<MockGrant[]> => {
  return db.query.integrationToolGrants.findMany({
    where: { connectionId },
    with: { agent: true },
  }) ?? [];
};

const updateGrant = async (
  db: MockDb,
  grantId: string,
  data: Partial<MockGrant>
): Promise<MockGrant | null> => {
  const result = await db.update().set(data).where({ id: grantId }).returning();
  return result[0] ?? null;
};

const deleteGrant = async (
  db: MockDb,
  grantId: string
): Promise<MockGrant | null> => {
  const result = await db.delete().where({ id: grantId }).returning();
  return result[0] ?? null;
};

describe('createGrant', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given agent ID and connection ID, should create new grant', async () => {
    const newGrant: Partial<MockGrant> = {
      agentId: 'agent-1',
      connectionId: 'conn-1',
      allowedTools: null,
      deniedTools: null,
      readOnly: false,
    };

    const expectedResult: MockGrant = {
      id: 'grant-123',
      ...newGrant as MockGrant,
      createdAt: new Date(),
    };

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([expectedResult]),
      }),
    });

    const result = await createGrant(mockDb, newGrant);

    expect(result).toEqual(expectedResult);
    expect(result.agentId).toBe('agent-1');
    expect(result.connectionId).toBe('conn-1');
  });

  it('given specific allowed tools, should create grant with tool restrictions', async () => {
    const newGrant: Partial<MockGrant> = {
      agentId: 'agent-1',
      connectionId: 'conn-1',
      allowedTools: ['list_repos', 'get_repo'],
      deniedTools: null,
      readOnly: true,
    };

    const expectedResult: MockGrant = {
      id: 'grant-456',
      ...newGrant as MockGrant,
      createdAt: new Date(),
    };

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([expectedResult]),
      }),
    });

    const result = await createGrant(mockDb, newGrant);

    expect(result.allowedTools).toEqual(['list_repos', 'get_repo']);
    expect(result.readOnly).toBe(true);
  });
});

describe('getGrantById', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given existing grant ID, should return grant', async () => {
    const existingGrant: MockGrant = {
      id: 'grant-123',
      agentId: 'agent-1',
      connectionId: 'conn-1',
      allowedTools: null,
      deniedTools: null,
      readOnly: false,
    };

    mockDb.query.integrationToolGrants.findFirst.mockResolvedValue(existingGrant);

    const result = await getGrantById(mockDb, 'grant-123');

    expect(result).toEqual(existingGrant);
  });

  it('given non-existent grant ID, should return null', async () => {
    mockDb.query.integrationToolGrants.findFirst.mockResolvedValue(null);

    const result = await getGrantById(mockDb, 'non-existent');

    expect(result).toBeNull();
  });
});

describe('findGrant', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given agent ID and connection ID, should find existing grant', async () => {
    const grant: MockGrant = {
      id: 'grant-123',
      agentId: 'agent-1',
      connectionId: 'conn-1',
      allowedTools: null,
      deniedTools: null,
      readOnly: false,
    };

    mockDb.query.integrationToolGrants.findFirst.mockResolvedValue(grant);

    const result = await findGrant(mockDb, 'agent-1', 'conn-1');

    expect(result).toEqual(grant);
  });

  it('given no matching grant, should return null', async () => {
    mockDb.query.integrationToolGrants.findFirst.mockResolvedValue(null);

    const result = await findGrant(mockDb, 'agent-1', 'unknown-conn');

    expect(result).toBeNull();
  });
});

describe('listGrantsByAgent', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given agent ID, should list all grants with connection details', async () => {
    const grants: MockGrant[] = [
      {
        id: 'grant-1',
        agentId: 'agent-1',
        connectionId: 'conn-1',
        allowedTools: null,
        deniedTools: null,
        readOnly: false,
        connection: {
          id: 'conn-1',
          name: 'GitHub',
          status: 'active',
          provider: { slug: 'github', name: 'GitHub' },
        },
      },
      {
        id: 'grant-2',
        agentId: 'agent-1',
        connectionId: 'conn-2',
        allowedTools: ['send_message'],
        deniedTools: null,
        readOnly: true,
        connection: {
          id: 'conn-2',
          name: 'Slack',
          status: 'active',
          provider: { slug: 'slack', name: 'Slack' },
        },
      },
    ];

    mockDb.query.integrationToolGrants.findMany.mockResolvedValue(grants);

    const result = await listGrantsByAgent(mockDb, 'agent-1');

    expect(result).toHaveLength(2);
    expect(result[0].connection?.provider?.slug).toBe('github');
    expect(result[1].connection?.provider?.slug).toBe('slack');
  });

  it('given agent with no grants, should return empty array', async () => {
    mockDb.query.integrationToolGrants.findMany.mockResolvedValue([]);

    const result = await listGrantsByAgent(mockDb, 'agent-1');

    expect(result).toEqual([]);
  });
});

describe('listGrantsByConnection', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given connection ID, should list all agents with grants', async () => {
    const grants: MockGrant[] = [
      {
        id: 'grant-1',
        agentId: 'agent-1',
        connectionId: 'conn-1',
        allowedTools: null,
        deniedTools: null,
        readOnly: false,
        agent: { id: 'agent-1', title: 'Code Assistant' },
      },
      {
        id: 'grant-2',
        agentId: 'agent-2',
        connectionId: 'conn-1',
        allowedTools: ['list_repos'],
        deniedTools: null,
        readOnly: true,
        agent: { id: 'agent-2', title: 'Research Bot' },
      },
    ];

    mockDb.query.integrationToolGrants.findMany.mockResolvedValue(grants);

    const result = await listGrantsByConnection(mockDb, 'conn-1');

    expect(result).toHaveLength(2);
    expect(result[0].agent?.title).toBe('Code Assistant');
    expect(result[1].agent?.title).toBe('Research Bot');
  });
});

describe('updateGrant', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given grant update, should update allowed/denied tools', async () => {
    const updatedGrant: MockGrant = {
      id: 'grant-123',
      agentId: 'agent-1',
      connectionId: 'conn-1',
      allowedTools: ['list_repos', 'create_issue'],
      deniedTools: ['delete_repo'],
      readOnly: false,
    };

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedGrant]),
        }),
      }),
    });

    const result = await updateGrant(mockDb, 'grant-123', {
      allowedTools: ['list_repos', 'create_issue'],
      deniedTools: ['delete_repo'],
    });

    expect(result?.allowedTools).toEqual(['list_repos', 'create_issue']);
    expect(result?.deniedTools).toEqual(['delete_repo']);
  });

  it('given non-existent grant, should return null', async () => {
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const result = await updateGrant(mockDb, 'non-existent', { readOnly: true });

    expect(result).toBeNull();
  });
});

describe('deleteGrant', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given grant ID, should delete and return deleted grant', async () => {
    const deletedGrant: MockGrant = {
      id: 'grant-123',
      agentId: 'agent-1',
      connectionId: 'conn-1',
      allowedTools: null,
      deniedTools: null,
      readOnly: false,
    };

    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([deletedGrant]),
      }),
    });

    const result = await deleteGrant(mockDb, 'grant-123');

    expect(result).toEqual(deletedGrant);
    expect(mockDb.delete).toHaveBeenCalled();
  });

  it('given non-existent grant, should return null', async () => {
    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await deleteGrant(mockDb, 'non-existent');

    expect(result).toBeNull();
  });
});
