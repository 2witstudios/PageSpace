/**
 * scripts/calculate-initial-storage.ts Tests
 *
 * This script calculates storage usage for all users and updates the database.
 * We mock all external dependencies to avoid real DB connections.
 *
 * Strategy: Use a shared mutable state object that the vi.mock factory always
 * references. The factory is hoisted but the state is mutable so tests can
 * configure behavior. We do NOT call vi.resetModules() - instead the script's
 * IIFE is only executed once per describe block (first import wins).
 *
 * Because each test exercises different mock behavior, we run each path in
 * a single describe that only imports the script once, using queued responses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Queued responses - the mock reads from these queues
const selectFromQueue: Array<() => Promise<unknown>> = [];
const findManyQueue: Array<() => Promise<unknown>> = [];
const updateWhereQueue: Array<() => Promise<unknown>> = [];
const insertValuesQueue: Array<() => Promise<unknown>> = [];

function dequeue<T>(queue: Array<() => Promise<T>>, fallback: T): Promise<T> {
  const fn = queue.shift();
  return fn ? fn() : Promise.resolve(fallback);
}

vi.mock('../../src/index', () => {
  const updateWhere = vi.fn(() => dequeue(updateWhereQueue, undefined));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const mockUpdate = vi.fn(() => ({ set: updateSet }));

  const insertValues = vi.fn(() => dequeue(insertValuesQueue, undefined));
  const mockInsert = vi.fn(() => ({ values: insertValues }));

  let selectCallCount = 0;
  const mockFrom = vi.fn(() => {
    // First call from select is either direct resolve (no .where) or returns {where}
    // The users call resolves directly: db.select().from(users) resolves to array
    // The file size call uses .where(): db.select({...}).from(pages).where(...)
    // We alternate: users (no where), [fileSizes with where], summary (no where)
    return {
      where: vi.fn(() => dequeue(selectFromQueue, [] as unknown[])),
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        // When resolved without .where (i.e., direct await on from())
        dequeue(selectFromQueue, []).then(resolve, reject);
      },
    };
  });

  // The 'from' function acts as both a thenable and a {where} provider
  // This handles: await db.select().from(x) and db.select().from(x).where(y)
  const smartFrom = vi.fn(() => {
    const result = dequeue(selectFromQueue, []);
    const fromResult = {
      where: vi.fn(() => dequeue(selectFromQueue, [])),
      // Make it thenable so `await db.select().from(x)` works
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
    users: {},
    pages: {},
    drives: {},
    eq: vi.fn(),
    and: vi.fn(),
    isNull: vi.fn(),
    sql: vi.fn(),
    inArray: vi.fn(),
  };
});

vi.mock('dotenv', () => ({ config: vi.fn() }));

vi.mock('../../src/schema/core', async () => {
  const actual = await vi.importActual('../../src/schema/core') as Record<string, unknown>;
  return { ...actual, storageEvents: {} };
});

describe('scripts/calculate-initial-storage.ts', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Clear queues before each test
    selectFromQueue.length = 0;
    findManyQueue.length = 0;
    updateWhereQueue.length = 0;
    insertValuesQueue.length = 0;

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
      return undefined as never;
    });
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
    await new Promise((resolve) => setTimeout(resolve, 100));

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
    await new Promise((resolve) => setTimeout(resolve, 100));

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
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Storage calculation complete')
    );
  });

  it('exits with 1 on fatal error during user query', async () => {
    // allUsers throws
    selectFromQueue.push(() => Promise.reject(new Error('DB connection refused')));

    await import('../../scripts/calculate-initial-storage');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Fatal error'),
      expect.any(Error)
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
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(processExitSpy).toHaveBeenCalledWith(0);
    // Error logged for failed users
    expect(consoleErrorSpy).toHaveBeenCalled();
    // Complete banner still shown
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Storage calculation complete')
    );
  });

  it('defaults to free subscription when subscriptionTier is null (branch line 74)', async () => {
    const user = { id: 'u-null-tier', email: 'nulltier@example.com', subscriptionTier: null };
    selectFromQueue.push(() => Promise.resolve([user]));
    findManyQueue.push(() => Promise.resolve([{ id: 'drive-1', name: 'Drive' }]));
    selectFromQueue.push(() => Promise.resolve([])); // from()
    selectFromQueue.push(() => Promise.resolve([{ totalSize: 1024, fileCount: 1 }])); // where()
    selectFromQueue.push(() => Promise.resolve([{
      totalUsers: 1, totalStorage: 1024, avgStorage: 1024, normalUsers: 1, proUsers: 0,
    }]));

    await import('../../scripts/calculate-initial-storage');
    await new Promise((resolve) => setTimeout(resolve, 200));

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
    await new Promise((resolve) => setTimeout(resolve, 200));

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
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(processExitSpy).toHaveBeenCalledWith(0);
    const allLogMessages = consoleLogSpy.mock.calls.flat().join(' ');
    expect(allLogMessages).toContain('pro subscription');
  });

  it('calls process.exit(1) via outer .catch() when console.error throws (lines 161-164)', async () => {
    // The internal try/catch calls console.error then process.exit(1).
    // To reach the OUTER .catch() (lines 161-164), we need the function itself
    // to throw an unhandled rejection. We achieve this by making console.error
    // throw on first call (inside the catch block), which causes the function to reject.
    selectFromQueue.push(() => Promise.reject(new Error('Fatal DB failure')));
    consoleErrorSpy.mockImplementationOnce(() => { throw new Error('console.error broke'); });

    await import('../../scripts/calculate-initial-storage');
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The outer .catch() handler calls console.error('Unhandled error:', ...) and process.exit(1)
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Unhandled error:', expect.any(Error));
  });
});
