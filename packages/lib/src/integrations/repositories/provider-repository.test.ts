/**
 * Provider Repository Tests
 *
 * Tests for database operations on integration providers.
 * Uses inline mock implementations following the same pattern
 * as connection-repository.test.ts and grant-repository.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface MockProvider {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  iconUrl?: string | null;
  documentationUrl?: string | null;
  config: unknown;
  enabled: boolean;
  isSystem: boolean;
  driveId?: string | null;
  createdBy?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

interface MockDb {
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  query: {
    integrationProviders: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    integrationConnections: {
      findMany: ReturnType<typeof vi.fn>;
    };
  };
}

const createMockDb = (): MockDb => ({
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  query: {
    integrationProviders: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    integrationConnections: {
      findMany: vi.fn(),
    },
  },
});

// Inline repository implementations matching real function signatures

const getProviderById = async (
  db: MockDb,
  providerId: string
): Promise<MockProvider | null> => {
  const provider = await db.query.integrationProviders.findFirst({ where: { id: providerId } });
  return provider ?? null;
};

const getProviderBySlug = async (
  db: MockDb,
  slug: string
): Promise<MockProvider | null> => {
  const provider = await db.query.integrationProviders.findFirst({ where: { slug } });
  return provider ?? null;
};

const listEnabledProviders = async (
  db: MockDb
): Promise<MockProvider[]> => {
  return db.query.integrationProviders.findMany({ where: { enabled: true } }) ?? [];
};

const listProvidersForDrive = async (
  db: MockDb,
  driveId: string
): Promise<MockProvider[]> => {
  const providers: MockProvider[] = await db.query.integrationProviders.findMany({ where: { enabled: true } }) ?? [];
  return providers.filter(
    (p) => p.isSystem || p.driveId === driveId || p.driveId === null
  );
};

const createProvider = async (
  db: MockDb,
  data: Partial<MockProvider>
): Promise<MockProvider> => {
  const result = await db.insert().values(data).returning();
  return result[0];
};

const updateProvider = async (
  db: MockDb,
  providerId: string,
  data: Partial<MockProvider>
): Promise<MockProvider | null> => {
  const result = await db.update().set(data).where({ id: providerId }).returning();
  return result[0] ?? null;
};

const deleteProvider = async (
  db: MockDb,
  providerId: string
): Promise<MockProvider | null> => {
  const connections = await db.query.integrationConnections.findMany({ where: { providerId } });
  if (connections.length > 0) return null;

  const result = await db.delete().where({ id: providerId }).returning();
  return result[0] ?? null;
};

const countProviderConnections = async (
  db: MockDb,
  providerId: string
): Promise<number> => {
  const connections = await db.query.integrationConnections.findMany({ where: { providerId } });
  return connections.length;
};

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('getProviderById', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given existing provider ID, should return provider', async () => {
    const provider: MockProvider = {
      id: 'prov-1',
      slug: 'github',
      name: 'GitHub',
      config: { baseUrl: 'https://api.github.com' },
      enabled: true,
      isSystem: true,
    };

    mockDb.query.integrationProviders.findFirst.mockResolvedValue(provider);

    const result = await getProviderById(mockDb, 'prov-1');

    expect(result).toEqual(provider);
    expect(mockDb.query.integrationProviders.findFirst).toHaveBeenCalled();
  });

  it('given non-existent provider ID, should return null', async () => {
    mockDb.query.integrationProviders.findFirst.mockResolvedValue(undefined);

    const result = await getProviderById(mockDb, 'non-existent');

    expect(result).toBeNull();
  });
});

describe('getProviderBySlug', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given existing slug, should return provider', async () => {
    const provider: MockProvider = {
      id: 'prov-1',
      slug: 'google-calendar',
      name: 'Google Calendar',
      config: {},
      enabled: true,
      isSystem: true,
    };

    mockDb.query.integrationProviders.findFirst.mockResolvedValue(provider);

    const result = await getProviderBySlug(mockDb, 'google-calendar');

    expect(result).toEqual(provider);
  });

  it('given non-existent slug, should return null', async () => {
    mockDb.query.integrationProviders.findFirst.mockResolvedValue(undefined);

    const result = await getProviderBySlug(mockDb, 'nonexistent');

    expect(result).toBeNull();
  });
});

describe('listEnabledProviders', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given enabled providers exist, should return all enabled providers', async () => {
    const providers: MockProvider[] = [
      { id: 'p1', slug: 'github', name: 'GitHub', config: {}, enabled: true, isSystem: true },
      { id: 'p2', slug: 'slack', name: 'Slack', config: {}, enabled: true, isSystem: true },
    ];

    mockDb.query.integrationProviders.findMany.mockResolvedValue(providers);

    const result = await listEnabledProviders(mockDb);

    expect(result).toHaveLength(2);
    expect(result[0].slug).toBe('github');
  });

  it('given no enabled providers, should return empty array', async () => {
    mockDb.query.integrationProviders.findMany.mockResolvedValue([]);

    const result = await listEnabledProviders(mockDb);

    expect(result).toEqual([]);
  });
});

describe('listProvidersForDrive', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given system and drive-specific providers, should return matching providers', async () => {
    const providers: MockProvider[] = [
      { id: 'p1', slug: 'github', name: 'GitHub', config: {}, enabled: true, isSystem: true, driveId: null },
      { id: 'p2', slug: 'custom', name: 'Custom', config: {}, enabled: true, isSystem: false, driveId: 'drive-1' },
      { id: 'p3', slug: 'other', name: 'Other Drive', config: {}, enabled: true, isSystem: false, driveId: 'drive-2' },
    ];

    mockDb.query.integrationProviders.findMany.mockResolvedValue(providers);

    const result = await listProvidersForDrive(mockDb, 'drive-1');

    expect(result).toHaveLength(2);
    expect(result.map((p) => p.slug)).toContain('github');
    expect(result.map((p) => p.slug)).toContain('custom');
    expect(result.map((p) => p.slug)).not.toContain('other');
  });

  it('given null driveId providers, should include them for any drive', async () => {
    const providers: MockProvider[] = [
      { id: 'p1', slug: 'global', name: 'Global', config: {}, enabled: true, isSystem: false, driveId: null },
    ];

    mockDb.query.integrationProviders.findMany.mockResolvedValue(providers);

    const result = await listProvidersForDrive(mockDb, 'any-drive');

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('global');
  });
});

describe('createProvider', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given valid provider data, should insert and return provider', async () => {
    const newProvider: MockProvider = {
      id: 'prov-new',
      slug: 'jira',
      name: 'Jira',
      config: { baseUrl: 'https://jira.example.com' },
      enabled: true,
      isSystem: false,
    };

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([newProvider]),
      }),
    });

    const result = await createProvider(mockDb, {
      slug: 'jira',
      name: 'Jira',
      config: { baseUrl: 'https://jira.example.com' },
    });

    expect(result).toEqual(newProvider);
    expect(mockDb.insert).toHaveBeenCalled();
  });
});

describe('updateProvider', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given valid update data, should update and return provider', async () => {
    const updated: MockProvider = {
      id: 'prov-1',
      slug: 'github',
      name: 'GitHub (Updated)',
      config: {},
      enabled: true,
      isSystem: true,
    };

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updated]),
        }),
      }),
    });

    const result = await updateProvider(mockDb, 'prov-1', { name: 'GitHub (Updated)' });

    expect(result?.name).toBe('GitHub (Updated)');
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('given non-existent provider ID, should return null', async () => {
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const result = await updateProvider(mockDb, 'non-existent', { name: 'Test' });

    expect(result).toBeNull();
  });
});

describe('deleteProvider', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given provider with no connections, should delete and return provider', async () => {
    mockDb.query.integrationConnections.findMany.mockResolvedValue([]);

    const deleted: MockProvider = {
      id: 'prov-1',
      slug: 'custom',
      name: 'Custom',
      config: {},
      enabled: true,
      isSystem: false,
    };

    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([deleted]),
      }),
    });

    const result = await deleteProvider(mockDb, 'prov-1');

    expect(result).toEqual(deleted);
    expect(mockDb.delete).toHaveBeenCalled();
  });

  it('given provider with active connections, should return null and not delete', async () => {
    mockDb.query.integrationConnections.findMany.mockResolvedValue([{ id: 'conn-1' }]);

    const result = await deleteProvider(mockDb, 'prov-1');

    expect(result).toBeNull();
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});

describe('countProviderConnections', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given provider with connections, should return count', async () => {
    mockDb.query.integrationConnections.findMany.mockResolvedValue([
      { id: 'conn-1' },
      { id: 'conn-2' },
      { id: 'conn-3' },
    ]);

    const count = await countProviderConnections(mockDb, 'prov-1');

    expect(count).toBe(3);
  });

  it('given provider with no connections, should return 0', async () => {
    mockDb.query.integrationConnections.findMany.mockResolvedValue([]);

    const count = await countProviderConnections(mockDb, 'prov-1');

    expect(count).toBe(0);
  });
});
