/**
 * @scaffold - migrate.ts Tests
 *
 * migrate.ts is a custom migration runner that executes each migration in its
 * own transaction (fixing PostgreSQL enum ADD VALUE limitations).
 * We mock out readMigrationFiles and the db to avoid any real database connections,
 * then dynamically import the module to trigger its top-level IIFE.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// Mock readMigrationFiles before importing migrate.ts
const mockReadMigrationFiles = vi.fn();
vi.mock('drizzle-orm/migrator', () => ({
  readMigrationFiles: mockReadMigrationFiles,
}));

// Mock drizzle-orm sql template tag
const mockSqlIdentifier = vi.fn(() => 'identifier');
const mockSqlRaw = vi.fn(() => 'raw');
vi.mock('drizzle-orm', () => ({
  sql: Object.assign(vi.fn(), {
    identifier: mockSqlIdentifier,
    raw: mockSqlRaw,
  }),
}));

// Mock the db index so no real PG pool is created
const mockExecute = vi.fn();
const mockTxExecute = vi.fn();
const mockTransaction = vi.fn(async (fn: (tx: { execute: typeof mockTxExecute }) => Promise<void>) => {
  await fn({ execute: mockTxExecute });
});

vi.mock('../index', () => ({
  db: {
    execute: mockExecute,
    transaction: mockTransaction,
  },
}));

describe('migrate.ts', () => {
  let processExitSpy: MockInstance;
  let consoleLogSpy: MockInstance;
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Default: no existing migrations in DB
    mockExecute.mockResolvedValue({ rows: [] });
    // Default: no pending migrations
    mockReadMigrationFiles.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockExecute.mockReset();
    mockTransaction.mockClear();
    mockTxExecute.mockReset();
    mockReadMigrationFiles.mockReset();
  });

  it('runs migrations and exits with 0 on success', async () => {
    mockReadMigrationFiles.mockReturnValue([
      { sql: ['CREATE TABLE test;'], folderMillis: 1000, hash: 'abc123' },
    ]);

    await import('../migrate');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockReadMigrationFiles).toHaveBeenCalledTimes(1);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('reads migrations from the drizzle folder', async () => {
    mockReadMigrationFiles.mockReturnValue([]);

    await import('../migrate');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockReadMigrationFiles).toHaveBeenCalledWith({ migrationsFolder: 'drizzle' });
  });

  it('logs migration progress messages', async () => {
    mockReadMigrationFiles.mockReturnValue([]);

    await import('../migrate');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Running migrations'));
  });

  it('logs "Not set" when DATABASE_URL is not set', async () => {
    mockReadMigrationFiles.mockReturnValue([]);
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    await import('../migrate');
    await new Promise((resolve) => setTimeout(resolve, 10));

    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    const logCalls = consoleLogSpy.mock.calls;
    const dbUrlCall = logCalls.find((args) => args[0] === 'DATABASE_URL:');
    expect(dbUrlCall).toBeDefined();
    expect(dbUrlCall?.[1]).toBe('Not set');
  });

  it('calls process.exit(1) and logs error when migration fails', async () => {
    const migrationError = new TypeError('db.execute is not a function');
    mockExecute.mockRejectedValueOnce(migrationError);

    await import('../migrate');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(Error));
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
