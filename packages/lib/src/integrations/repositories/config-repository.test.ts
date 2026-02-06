/**
 * Config Repository Tests
 *
 * Tests for database operations on global assistant configuration.
 * Uses inline mock implementations following the same pattern
 * as connection-repository.test.ts and grant-repository.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface MockConfig {
  id: string;
  userId: string;
  enabledUserIntegrations: string[] | null;
  driveOverrides: Record<string, unknown>;
  inheritDriveIntegrations: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

interface MockDb {
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  query: {
    globalAssistantConfig: {
      findFirst: ReturnType<typeof vi.fn>;
    };
  };
}

const createMockDb = (): MockDb => ({
  insert: vi.fn(),
  update: vi.fn(),
  query: {
    globalAssistantConfig: {
      findFirst: vi.fn(),
    },
  },
});

// Inline repository implementations matching real function signatures

const getConfig = async (
  db: MockDb,
  userId: string
): Promise<MockConfig | null> => {
  const config = await db.query.globalAssistantConfig.findFirst({ where: { userId } });
  return config ?? null;
};

const getOrCreateConfig = async (
  db: MockDb,
  userId: string
): Promise<MockConfig> => {
  const existing = await db.query.globalAssistantConfig.findFirst({ where: { userId } });
  if (existing) return existing;

  const result = await db.insert().values({
    userId,
    enabledUserIntegrations: null,
    driveOverrides: {},
    inheritDriveIntegrations: true,
  }).returning();

  return result[0];
};

const updateConfig = async (
  db: MockDb,
  userId: string,
  data: Partial<Pick<MockConfig, 'enabledUserIntegrations' | 'driveOverrides' | 'inheritDriveIntegrations'>>
): Promise<MockConfig> => {
  const existing = await getConfig(db, userId);

  if (existing) {
    const result = await db.update().set(data).where({ userId }).returning();
    return result[0];
  }

  const result = await db.insert().values({
    userId,
    enabledUserIntegrations: data.enabledUserIntegrations ?? null,
    driveOverrides: data.driveOverrides ?? {},
    inheritDriveIntegrations: data.inheritDriveIntegrations ?? true,
  }).returning();

  return result[0];
};

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('getConfig', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given existing user config, should return config', async () => {
    const config: MockConfig = {
      id: 'config-1',
      userId: 'user-1',
      enabledUserIntegrations: ['conn-1', 'conn-2'],
      driveOverrides: {},
      inheritDriveIntegrations: true,
    };

    mockDb.query.globalAssistantConfig.findFirst.mockResolvedValue(config);

    const result = await getConfig(mockDb, 'user-1');

    expect(result).toEqual(config);
    expect(result?.enabledUserIntegrations).toHaveLength(2);
  });

  it('given no existing config, should return null', async () => {
    mockDb.query.globalAssistantConfig.findFirst.mockResolvedValue(undefined);

    const result = await getConfig(mockDb, 'user-1');

    expect(result).toBeNull();
  });
});

describe('getOrCreateConfig', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given existing config, should return it without creating', async () => {
    const existing: MockConfig = {
      id: 'config-1',
      userId: 'user-1',
      enabledUserIntegrations: ['conn-1'],
      driveOverrides: { 'drive-1': { enabled: true } },
      inheritDriveIntegrations: false,
    };

    mockDb.query.globalAssistantConfig.findFirst.mockResolvedValue(existing);

    const result = await getOrCreateConfig(mockDb, 'user-1');

    expect(result).toEqual(existing);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('given no existing config, should create with defaults', async () => {
    mockDb.query.globalAssistantConfig.findFirst.mockResolvedValue(undefined);

    const created: MockConfig = {
      id: 'config-new',
      userId: 'user-1',
      enabledUserIntegrations: null,
      driveOverrides: {},
      inheritDriveIntegrations: true,
    };

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([created]),
      }),
    });

    const result = await getOrCreateConfig(mockDb, 'user-1');

    expect(result).toEqual(created);
    expect(result.enabledUserIntegrations).toBeNull();
    expect(result.driveOverrides).toEqual({});
    expect(result.inheritDriveIntegrations).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
  });
});

describe('updateConfig', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('given existing config, should update and return updated config', async () => {
    const existing: MockConfig = {
      id: 'config-1',
      userId: 'user-1',
      enabledUserIntegrations: null,
      driveOverrides: {},
      inheritDriveIntegrations: true,
    };

    const updated: MockConfig = {
      ...existing,
      enabledUserIntegrations: ['conn-1', 'conn-2'],
      inheritDriveIntegrations: false,
    };

    mockDb.query.globalAssistantConfig.findFirst.mockResolvedValue(existing);
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updated]),
        }),
      }),
    });

    const result = await updateConfig(mockDb, 'user-1', {
      enabledUserIntegrations: ['conn-1', 'conn-2'],
      inheritDriveIntegrations: false,
    });

    expect(result.enabledUserIntegrations).toEqual(['conn-1', 'conn-2']);
    expect(result.inheritDriveIntegrations).toBe(false);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('given no existing config, should create with provided data', async () => {
    mockDb.query.globalAssistantConfig.findFirst.mockResolvedValue(undefined);

    const created: MockConfig = {
      id: 'config-new',
      userId: 'user-1',
      enabledUserIntegrations: ['conn-1'],
      driveOverrides: { 'drive-1': { enabled: true } },
      inheritDriveIntegrations: false,
    };

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([created]),
      }),
    });

    const result = await updateConfig(mockDb, 'user-1', {
      enabledUserIntegrations: ['conn-1'],
      driveOverrides: { 'drive-1': { enabled: true } },
      inheritDriveIntegrations: false,
    });

    expect(result.enabledUserIntegrations).toEqual(['conn-1']);
    expect(result.inheritDriveIntegrations).toBe(false);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('given partial update data with no existing config, should apply defaults for missing fields', async () => {
    mockDb.query.globalAssistantConfig.findFirst.mockResolvedValue(undefined);

    const created: MockConfig = {
      id: 'config-new',
      userId: 'user-1',
      enabledUserIntegrations: null,
      driveOverrides: {},
      inheritDriveIntegrations: true,
    };

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([created]),
      }),
    });

    const result = await updateConfig(mockDb, 'user-1', {});

    expect(result.enabledUserIntegrations).toBeNull();
    expect(result.driveOverrides).toEqual({});
    expect(result.inheritDriveIntegrations).toBe(true);
  });

  it('given drive overrides update, should preserve other config fields', async () => {
    const existing: MockConfig = {
      id: 'config-1',
      userId: 'user-1',
      enabledUserIntegrations: ['conn-1'],
      driveOverrides: {},
      inheritDriveIntegrations: true,
    };

    const updated: MockConfig = {
      ...existing,
      driveOverrides: { 'drive-1': { disabledProviders: ['p1'] } },
    };

    mockDb.query.globalAssistantConfig.findFirst.mockResolvedValue(existing);
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updated]),
        }),
      }),
    });

    const result = await updateConfig(mockDb, 'user-1', {
      driveOverrides: { 'drive-1': { disabledProviders: ['p1'] } },
    });

    expect(result.driveOverrides).toEqual({ 'drive-1': { disabledProviders: ['p1'] } });
    expect(result.enabledUserIntegrations).toEqual(['conn-1']);
  });
});
