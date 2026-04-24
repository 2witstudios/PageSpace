/**
 * @scaffold - characterizing calculate-initial-storage.ts with ORM chain mocking.
 *
 * scripts/calculate-initial-storage.ts is a standalone IIFE script that directly
 * queries and updates the database via Drizzle ORM. No repository seam exists.
 *
 * @REVIEW Fake thenables (smartFrom with `then`/`catch`) simulate Drizzle's
 * combined thenable+chainable select().from() pattern. This violates the rubric
 * rule against simulating Promise internals, but cannot be eliminated without
 * extracting a repository seam from the script.
 *
 * @REVIEW Order-dependent mock ladders (selectFromQueue/findManyQueue) encode
 * internal query execution order. Tests break if the script's query order changes.
 * This is accepted as temporary characterization until a service seam is introduced.
 *
 * Strategy: Use a shared mutable state object that the vi.mock factory always
 * references. The factory is hoisted but the state is mutable so tests can
 * configure behavior. We do NOT call vi.resetModules() - instead the script's
 * IIFE is only executed once per describe block (first import wins).
 *
 * Because each test exercises different mock behavior, we run each path in
 * a single describe that only imports the script once, using queued responses.
 *
 * Suggested integration tests:
 * - Real DB test: verify storage calculation with seeded user/drive/page data
 * - Real DB test: verify summary statistics accuracy
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// Queued responses - the mock reads from these queues
const selectFromQueue: Array<() => Promise<unknown>> = [];
const findManyQueue: Array<() => Promise<unknown>> = [];
const updateWhereQueue: Array<() => Promise<unknown>> = [];
const insertValuesQueue: Array<() => Promise<unknown>> = [];

function dequeue<T>(queue: Array<() => Promise<T>>, fallback: T): Promise<T> {
  const fn = queue.shift();
  return fn ? fn() : Promise.resolve(fallback);
}

vi.mock('../db', () => {
  const updateWhere = vi.fn(() => dequeue(updateWhereQueue, undefined));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const mockUpdate = vi.fn(() => ({ set: updateSet }));

  const insertValues = vi.fn(() => dequeue(insertValuesQueue, undefined));
  const mockInsert = vi.fn(() => ({ values: insertValues }));

  const smartFrom = vi.fn(() => {
    const result = dequeue(selectFromQueue, []);
    const fromResult = {
      where: vi.fn(() => dequeue(selectFromQueue, [])),
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        result.then(resolve, reject);
      },
      catch: (reject: (e: unknown) => void) => {
        result.catch(reject);
      },
    };
    return fromResult;
  });

  const mockSelect = vi.fn(() => ({ from: smartFrom }));
  const mockFindMany = vi.fn(() => dequeue(findManyQueue, []));

  return {
    db: {
      select: mockSelect,
      insert: mockInsert,
      update: mockUpdate,
      query: {
        drives: {
          findMany: mockFindMany,
        },
      },
    },
  };
});

vi.mock('../schema/auth', () => ({ users: {} }));

vi.mock('../schema/core', async () => {
  const actual = await vi.importActual('../schema/core') as Record<string, unknown>;
  return { ...actual, storageEvents: {} };
});

vi.mock('../operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('dotenv', () => ({ config: vi.fn() }));

/** @scaffold */
describe('scripts/calculate-initial-storage.ts', () => {
  let processExitSpy: MockInstance;
  let consoleLogSpy: MockInstance;
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    // Clear queues before each test
    selectFromQueue.length = 0;
    findManyQueue.length = 0;
    updateWhereQueue.length = 0;
    insertValuesQueue.length = 0;

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits with 0 when there are no users', async () => {
    // Queue: users query returns empty, summary returns stats
    selectFromQueue.push(() => Promise.resolve([])); // allUsers
    selectFromQueue.push(() => Promise.resolve([{  // summary
      totalUsers: 0, totalStorage: 0, avgStorage: 0, normalUsers: 0, proUsers: 0,
    }]));

    await import('../../scripts/calculate-initial-storage');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Storage calculation complete')
    );
  });

  it('processes users with no drives and sets storage to 0', async () => {
    const user = { id: 'u1', email: 'nodrive@example.com', subscriptionTier: 'free' };
    // allUsers
    selectFromQueue.push(() => Promise.resolve([user]));
    // drives for user: empty
    findManyQueue.push(() => Promise.resolve([]));
    // summary
    selectFromQueue.push(() => Promise.resolve([{
      totalUsers: 1, totalStorage: 0, avgStorage: 0, normalUsers: 1, proUsers: 0,
    }]));

    await import('../../scripts/calculate-initial-storage');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('processes users with drives and files correctly', async () => {
    const user = { id: 'u2', email: 'files@example.com', subscriptionTier: 'pro' };
    // allUsers
    selectFromQueue.push(() => Promise.resolve([user]));
    // drives for user
    findManyQueue.push(() => Promise.resolve([{ id: 'drive-1', name: 'My Drive' }]));
    // file size query (db.select({...}).from(pages).where())
    selectFromQueue.push(() => Promise.resolve([{ totalSize: 1024000, fileCount: 5 }]));
    // summary
    selectFromQueue.push(() => Promise.resolve([{
      totalUsers: 1, totalStorage: 1024000, avgStorage: 1024000, normalUsers: 0, proUsers: 1,
    }]));

    await import('../../scripts/calculate-initial-storage');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Storage calculation complete')
    );
  });

  it('exits with 1 on fatal error during user query', async () => {
    // allUsers throws
    selectFromQueue.push(() => Promise.reject(new Error('DB connection refused')));

    await import('../../scripts/calculate-initial-storage');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Fatal error'),
      expect.objectContaining({ message: 'DB connection refused' })
    );
  });

  it('continues processing remaining users when one user processing fails', async () => {
    const users = [
      { id: 'u3', email: 'ok@example.com', subscriptionTier: 'free' },
      { id: 'u4', email: 'err@example.com', subscriptionTier: 'free' },
    ];
    // allUsers
    selectFromQueue.push(() => Promise.resolve(users));
    // user 1: drives throws
    findManyQueue.push(() => Promise.reject(new Error('Drive query failed')));
    // user 2: drives also throws
    findManyQueue.push(() => Promise.reject(new Error('Drive query 2 failed')));
    // summary
    selectFromQueue.push(() => Promise.resolve([{
      totalUsers: 2, totalStorage: 0, avgStorage: 0, normalUsers: 2, proUsers: 0,
    }]));

    await import('../../scripts/calculate-initial-storage');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processExitSpy).toHaveBeenCalledWith(0);
    // Error logged for failed users
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error'), expect.objectContaining({ message: 'Drive query failed' }));
    // Complete banner still shown
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Storage calculation complete')
    );
  });

  it('defaults to free subscription when subscriptionTier is null', async () => {
    const user = { id: 'u-null-tier', email: 'nulltier@example.com', subscriptionTier: null };
    selectFromQueue.push(() => Promise.resolve([user]));
    findManyQueue.push(() => Promise.resolve([{ id: 'drive-1', name: 'Drive' }]));
    selectFromQueue.push(() => Promise.resolve([])); // from()
    selectFromQueue.push(() => Promise.resolve([{ totalSize: 1024, fileCount: 1 }])); // where()
    selectFromQueue.push(() => Promise.resolve([{
      totalUsers: 1, totalStorage: 1024, avgStorage: 1024, normalUsers: 1, proUsers: 0,
    }]));

    await import('../../scripts/calculate-initial-storage');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processExitSpy).toHaveBeenCalledWith(0);
    const allLogMessages = consoleLogSpy.mock.calls.flat().join(' ');
    expect(allLogMessages).toContain('free subscription');
  });

  it('logs a warning when a free user exceeds the 500MB storage limit', async () => {
    const bigSize = 600 * 1024 * 1024; // 600MB > 500MB free limit
    const user = { id: 'u5', email: 'heavy@example.com', subscriptionTier: 'free' };
    // allUsers - consumed by smartFrom's thenable
    selectFromQueue.push(() => Promise.resolve([user]));
    // drives
    findManyQueue.push(() => Promise.resolve([{ id: 'drive-1', name: 'Drive' }]));
    // file sizes query: smartFrom dequeues once (from()), then .where() dequeues again
    selectFromQueue.push(() => Promise.resolve([])); // consumed by from() - unused
    selectFromQueue.push(() => Promise.resolve([{ totalSize: bigSize, fileCount: 100 }])); // consumed by where()
    // summary - consumed by smartFrom's thenable
    selectFromQueue.push(() => Promise.resolve([{
      totalUsers: 1, totalStorage: bigSize, avgStorage: bigSize, normalUsers: 1, proUsers: 0,
    }]));

    await import('../../scripts/calculate-initial-storage');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processExitSpy).toHaveBeenCalledWith(0);
    const allLogMessages = consoleLogSpy.mock.calls.flat().join(' ');
    expect(allLogMessages).toContain('free subscription');
  });

  it('logs a warning when a pro user exceeds the 2GB storage limit', async () => {
    const bigSize = 3 * 1024 * 1024 * 1024; // 3GB > 2GB pro limit
    const user = { id: 'u6', email: 'probig@example.com', subscriptionTier: 'pro' };
    // allUsers - consumed by smartFrom's thenable
    selectFromQueue.push(() => Promise.resolve([user]));
    // drives
    findManyQueue.push(() => Promise.resolve([{ id: 'drive-1', name: 'Drive' }]));
    // file sizes query: smartFrom dequeues once (from()), then .where() dequeues again
    selectFromQueue.push(() => Promise.resolve([])); // consumed by from() - unused
    selectFromQueue.push(() => Promise.resolve([{ totalSize: bigSize, fileCount: 500 }])); // consumed by where()
    // summary - consumed by smartFrom's thenable
    selectFromQueue.push(() => Promise.resolve([{
      totalUsers: 1, totalStorage: bigSize, avgStorage: bigSize, normalUsers: 0, proUsers: 1,
    }]));

    await import('../../scripts/calculate-initial-storage');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processExitSpy).toHaveBeenCalledWith(0);
    const allLogMessages = consoleLogSpy.mock.calls.flat().join(' ');
    expect(allLogMessages).toContain('pro subscription');
  });

  it('calls process.exit(1) via outer .catch() when console.error throws', async () => {
    // The internal try/catch calls console.error then process.exit(1).
    // To reach the outer .catch(), we need the function itself
    // to throw an unhandled rejection. We achieve this by making console.error
    // throw on first call (inside the catch block), which causes the function to reject.
    selectFromQueue.push(() => Promise.reject(new Error('Fatal DB failure')));
    consoleErrorSpy.mockImplementationOnce(() => { throw new Error('console.error broke'); });

    await import('../../scripts/calculate-initial-storage');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The outer .catch() handler calls console.error('Unhandled error:', ...) and process.exit(1)
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Unhandled error:', expect.objectContaining({ message: 'console.error broke' }));
  });
});
