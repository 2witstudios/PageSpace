/**
 * @scaffold - migrate.ts Tests
 *
 * migrate.ts is a script that runs drizzle migrations and calls process.exit.
 * We mock out the migrator and the db to avoid any real database connections,
 * then dynamically import the module to trigger its top-level IIFE.
 *
 * Suggested integration tests:
 * - Real DB test: run migrate against test database, verify tables created
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// Mock drizzle migrator before importing migrate.ts
vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: vi.fn(),
}));

// Mock the db index so no real PG pool is created
vi.mock('../index', () => ({
  db: {},
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  not: vi.fn(),
  inArray: vi.fn(),
  sql: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  sum: vi.fn(),
  avg: vi.fn(),
  max: vi.fn(),
  min: vi.fn(),
  like: vi.fn(),
  ilike: vi.fn(),
  exists: vi.fn(),
  between: vi.fn(),
  gt: vi.fn(),
  gte: vi.fn(),
  lt: vi.fn(),
  lte: vi.fn(),
  ne: vi.fn(),
  isNull: vi.fn(),
  isNotNull: vi.fn(),
}));

describe('migrate.ts', () => {
  let processExitSpy: MockInstance;
  let consoleLogSpy: MockInstance;
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    // Intercept process.exit so the test process doesn't actually exit
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clear module registry so each test gets a fresh import
    vi.resetModules();
  });

  it('calls migrate and exits with 0 on success', async () => {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    vi.mocked(migrate).mockResolvedValueOnce(undefined);

    // Import triggers the IIFE at module load time
    await import('../migrate');

    // Allow all microtasks/promises to settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('calls migrate with the correct migrationsFolder argument', async () => {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    vi.mocked(migrate).mockResolvedValueOnce(undefined);

    await import('../migrate');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const callArgs = vi.mocked(migrate).mock.calls[0];
    expect(callArgs).toBeDefined();
    // Second argument should be an object with migrationsFolder
    const config = callArgs[1] as { migrationsFolder: string };
    expect(config).toHaveProperty('migrationsFolder');
    expect(typeof config.migrationsFolder).toBe('string');
    expect(config.migrationsFolder).toContain('drizzle');
  });

  it('logs migration progress messages', async () => {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    vi.mocked(migrate).mockResolvedValueOnce(undefined);

    await import('../migrate');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Running migrations'));
  });

  it('logs "Not set" when DATABASE_URL is not set', async () => {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    vi.mocked(migrate).mockResolvedValueOnce(undefined);

    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    await import('../migrate');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Restore env
    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    // console.log("DATABASE_URL:", "Not set") - two args
    const logCalls = consoleLogSpy.mock.calls;
    const dbUrlCall = logCalls.find((args) => args[0] === 'DATABASE_URL:');
    expect(dbUrlCall).toBeDefined();
    expect(dbUrlCall?.[1]).toBe('Not set');
  });

  it('calls process.exit(1) and logs error when migration fails', async () => {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const migrationError = new Error('Migration failed: connection refused');
    vi.mocked(migrate).mockRejectedValueOnce(migrationError);

    await import('../migrate');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(consoleErrorSpy).toHaveBeenCalledWith(migrationError);
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
