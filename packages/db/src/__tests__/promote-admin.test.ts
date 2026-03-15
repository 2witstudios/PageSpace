/**
 * @scaffold - promote-admin.ts Tests
 *
 * promote-admin.ts is a CLI script that reads process.argv[2] for the email
 * and then queries/updates the database. No repository seam exists.
 *
 * @REVIEW ORM chain mock (db.update().set().where()) encodes internal query
 * composition. This is accepted as temporary characterization until a service
 * seam is introduced in the script.
 *
 * Strategy: vi.mock() is hoisted and evaluated once. We use module-level mock
 * factories that expose their mocks so tests can configure them per-test.
 * We reset modules in afterEach and re-import for isolation.
 *
 * Suggested integration tests:
 * - Real DB test: promote user and verify role change persisted
 * - Real DB test: verify idempotent promotion of already-admin user
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// Shared mutable mock state - these are module-level so tests can configure them.
// vi.mock() is hoisted, but the factory re-runs after vi.resetModules().
const mockFindFirst = vi.fn();
const mockWhere = vi.fn().mockResolvedValue(undefined);
const mockSet = vi.fn();
const mockUpdate = vi.fn();

mockSet.mockReturnValue({ where: mockWhere });
mockUpdate.mockReturnValue({ set: mockSet });

vi.mock('../index', () => ({
  db: {
    query: {
      users: {
        findFirst: mockFindFirst,
      },
    },
    update: mockUpdate,
  },
  users: { email: 'email_column' },
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

/** @scaffold */
describe('promote-admin.ts', () => {
  let processExitSpy: MockInstance;
  let consoleLogSpy: MockInstance;
  let consoleErrorSpy: MockInstance;
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = [...process.argv];
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Reset mock call history between tests
    mockFindFirst.mockReset();
    mockUpdate.mockReset();
    mockSet.mockReset();
    mockWhere.mockReset();
    // Re-establish the chain
    mockWhere.mockResolvedValue(undefined);
    mockSet.mockReturnValue({ where: mockWhere });
    mockUpdate.mockReturnValue({ set: mockSet });
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('exits with 1 and prints usage when no email is provided', async () => {
    process.argv = ['node', 'promote-admin.ts']; // No email argument

    await import('../promote-admin');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage')
    );
  });

  it('exits with 1 when user is not found', async () => {
    process.argv = ['node', 'promote-admin.ts', 'notfound@example.com'];
    mockFindFirst.mockResolvedValueOnce(undefined);

    await import('../promote-admin');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('not found')
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('logs message and exits with 0 when user is already admin', async () => {
    process.argv = ['node', 'promote-admin.ts', 'admin@example.com'];
    mockFindFirst.mockResolvedValueOnce({
      id: 'user-1',
      email: 'admin@example.com',
      role: 'admin',
    });

    await import('../promote-admin');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('already an admin')
    );
    // Should still call process.exit(0) from the finally block
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('promotes user to admin and exits with 0', async () => {
    process.argv = ['node', 'promote-admin.ts', 'user@example.com'];
    mockFindFirst.mockResolvedValueOnce({
      id: 'user-1',
      email: 'user@example.com',
      role: 'user',
    });

    await import('../promote-admin');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Successfully promoted')
    );
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('exits with 1 when database throws an error during findFirst', async () => {
    process.argv = ['node', 'promote-admin.ts', 'error@example.com'];
    mockFindFirst.mockRejectedValueOnce(new Error('Database connection failed'));

    await import('../promote-admin');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error promoting user'),
      expect.objectContaining({ message: 'Database connection failed' })
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
