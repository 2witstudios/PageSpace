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
    expect(mockDb.query.integrationProviders.findFirst).toHaveBeenCalledWith({ where: { id: 'prov-1' } });
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
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
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
    expect(mockDb.update).toHaveBeenCalledTimes(1);
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
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });

  it('given provider with active connections, should return null and not delete', async () => {
    mockDb.query.integrationConnections.findMany.mockResolvedValue([{ id: 'conn-1' }]);

    const result = await deleteProvider(mockDb, 'prov-1');

    expect(result).toBeNull();
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEED BUILTIN PROVIDERS
// ═══════════════════════════════════════════════════════════════════════════════

interface BuiltinConfig {
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  documentationUrl?: string;
}

const seedBuiltinProviders = async (
  db: MockDb,
  builtins: BuiltinConfig[],
): Promise<MockProvider[]> => {
  const existing: MockProvider[] = await db.query.integrationProviders.findMany({
    columns: { slug: true },
  }) ?? [];

  const installedSlugs = new Set(existing.map((p) => p.slug));
  const toSeed = builtins.filter((b) => !installedSlugs.has(b.id));

  if (toSeed.length === 0) return [];

  const seeded: MockProvider[] = [];
  for (const builtin of toSeed) {
    const result = await db.insert().values({
      slug: builtin.id,
      name: builtin.name,
      description: builtin.description ?? null,
      iconUrl: builtin.iconUrl ?? null,
      documentationUrl: builtin.documentationUrl ?? null,
      providerType: 'builtin',
      config: builtin,
      isSystem: true,
      enabled: true,
    }).returning();
    seeded.push(result[0]);
  }

  return seeded;
};

describe('seedBuiltinProviders', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given no providers installed, should seed all builtins', async () => {
    mockDb.query.integrationProviders.findMany.mockResolvedValue([]);

    const github: MockProvider = {
      id: 'prov-github', slug: 'github', name: 'GitHub', config: {}, enabled: true, isSystem: true,
    };
    const webhook: MockProvider = {
      id: 'prov-webhook', slug: 'generic-webhook', name: 'Generic Webhook', config: {}, enabled: true, isSystem: true,
    };

    let callCount = 0;
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve([callCount === 1 ? github : webhook]);
        }),
      }),
    });

    const result = await seedBuiltinProviders(mockDb, [
      { id: 'github', name: 'GitHub', description: 'GitHub integration' },
      { id: 'generic-webhook', name: 'Generic Webhook', description: 'Webhook' },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].slug).toBe('github');
    expect(result[1].slug).toBe('generic-webhook');
    expect(mockDb.insert).toHaveBeenCalledTimes(2);
  });

  it('given some providers already installed, should only seed missing ones', async () => {
    mockDb.query.integrationProviders.findMany.mockResolvedValue([
      { id: 'p1', slug: 'github', name: 'GitHub', config: {}, enabled: true, isSystem: true },
    ]);

    const webhook: MockProvider = {
      id: 'prov-webhook', slug: 'generic-webhook', name: 'Generic Webhook', config: {}, enabled: true, isSystem: true,
    };

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([webhook]),
      }),
    });

    const result = await seedBuiltinProviders(mockDb, [
      { id: 'github', name: 'GitHub' },
      { id: 'generic-webhook', name: 'Generic Webhook' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('generic-webhook');
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it('given all providers already installed, should seed nothing', async () => {
    mockDb.query.integrationProviders.findMany.mockResolvedValue([
      { id: 'p1', slug: 'github', name: 'GitHub', config: {}, enabled: true, isSystem: true },
      { id: 'p2', slug: 'generic-webhook', name: 'Webhook', config: {}, enabled: true, isSystem: true },
    ]);

    const result = await seedBuiltinProviders(mockDb, [
      { id: 'github', name: 'GitHub' },
      { id: 'generic-webhook', name: 'Generic Webhook' },
    ]);

    expect(result).toHaveLength(0);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REFRESH BUILTIN PROVIDERS
// ═══════════════════════════════════════════════════════════════════════════════

interface BuiltinConfigWithTools extends BuiltinConfig {
  tools?: Array<{ id: string; inputSchema?: unknown; rateLimit?: unknown }>;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const sorted = Object.keys(value as Record<string, unknown>).sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${sorted.join(',')}}`;
  }
  return JSON.stringify(value);
}

const refreshBuiltinProviders = async (
  db: MockDb,
  builtins: BuiltinConfigWithTools[]
): Promise<number> => {
  let updated = 0;

  for (const builtin of builtins) {
    const existing = await db.query.integrationProviders.findFirst({
      where: { slug: builtin.id, providerType: 'builtin' },
    });
    if (!existing) continue;

    if (stableStringify(existing.config) === stableStringify(builtin)) continue;

    await db.update().set({ config: builtin }).where({ id: existing.id }).returning();
    updated++;
  }

  return updated;
};

describe('refreshBuiltinProviders', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{}]),
        }),
      }),
    });
  });

  it('given provider with new tools added, should update config', async () => {
    const dbConfig = {
      id: 'github',
      name: 'GitHub',
      tools: [{ id: 'list_repos' }, { id: 'get_issues' }],
    };
    mockDb.query.integrationProviders.findFirst.mockResolvedValue({
      id: 'prov-1',
      slug: 'github',
      name: 'GitHub',
      config: dbConfig,
      enabled: true,
      isSystem: true,
    });

    const result = await refreshBuiltinProviders(mockDb, [
      {
        id: 'github',
        name: 'GitHub',
        tools: [
          { id: 'list_repos' },
          { id: 'get_issues' },
          { id: 'get_pull_request' },
        ],
      },
    ]);

    expect(result).toBe(1);
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it('given identical config, should skip update', async () => {
    const config = {
      id: 'github',
      name: 'GitHub',
      tools: [{ id: 'list_repos' }],
    };
    mockDb.query.integrationProviders.findFirst.mockResolvedValue({
      id: 'prov-1',
      slug: 'github',
      name: 'GitHub',
      config,
      enabled: true,
      isSystem: true,
    });

    const result = await refreshBuiltinProviders(mockDb, [
      { id: 'github', name: 'GitHub', tools: [{ id: 'list_repos' }] },
    ]);

    expect(result).toBe(0);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('given provider not in database, should skip it', async () => {
    mockDb.query.integrationProviders.findFirst.mockResolvedValue(undefined);

    const result = await refreshBuiltinProviders(mockDb, [
      { id: 'github', name: 'GitHub', tools: [{ id: 'list_repos' }] },
    ]);

    expect(result).toBe(0);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('given same tool IDs but changed schema, should update config', async () => {
    const dbConfig = {
      id: 'github',
      name: 'GitHub',
      tools: [{ id: 'list_repos', inputSchema: { type: 'object', properties: { owner: { type: 'string' } } } }],
    };
    mockDb.query.integrationProviders.findFirst.mockResolvedValue({
      id: 'prov-1',
      slug: 'github',
      name: 'GitHub',
      config: dbConfig,
      enabled: true,
      isSystem: true,
    });

    const result = await refreshBuiltinProviders(mockDb, [
      {
        id: 'github',
        name: 'GitHub',
        tools: [{
          id: 'list_repos',
          inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } } },
        }],
      },
    ]);

    expect(result).toBe(1);
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it('given same tool IDs but changed rate limit, should update config', async () => {
    const dbConfig = {
      id: 'github',
      name: 'GitHub',
      tools: [{ id: 'list_repos', rateLimit: { requests: 30, windowMs: 60000 } }],
    };
    mockDb.query.integrationProviders.findFirst.mockResolvedValue({
      id: 'prov-1',
      slug: 'github',
      name: 'GitHub',
      config: dbConfig,
      enabled: true,
      isSystem: true,
    });

    const result = await refreshBuiltinProviders(mockDb, [
      {
        id: 'github',
        name: 'GitHub',
        tools: [{ id: 'list_repos', rateLimit: { requests: 10, windowMs: 60000 } }],
      },
    ]);

    expect(result).toBe(1);
    expect(mockDb.update).toHaveBeenCalledTimes(1);
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
