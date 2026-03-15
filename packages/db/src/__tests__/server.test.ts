/**
 * server.ts Tests
 *
 * server.ts re-exports everything from ./index with the 'server-only' guard.
 * We mock 'server-only' so we can test in a non-Next.js environment and verify
 * that all expected symbols are re-exported.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock 'server-only' to prevent the Next.js server guard from throwing
vi.mock('server-only', () => ({}));

// We also need to ensure the db module itself doesn't try a real PG connection
// The db module is already covered (100%), we just need server.ts imported
vi.mock('../index', async () => {
  const actual = await vi.importActual('../schema');
  return {
    ...(actual as object),
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
  };
});

describe('server.ts', () => {
  let serverModule: Record<string, unknown>;

  beforeAll(async () => {
    serverModule = await import('../server');
  });

  it('re-exports db', () => {
    expect(serverModule).toHaveProperty('db');
  });

  it('re-exports schema tables', () => {
    expect(serverModule).toHaveProperty('users');
    expect(serverModule).toHaveProperty('drives');
    expect(serverModule).toHaveProperty('pages');
    expect(serverModule).toHaveProperty('sessions');
  });

  it('re-exports drizzle utility functions', () => {
    expect(serverModule).toHaveProperty('eq');
    expect(serverModule).toHaveProperty('and');
    expect(serverModule).toHaveProperty('or');
    expect(serverModule).toHaveProperty('sql');
  });

  it('is a module object', () => {
    expect(typeof serverModule).toBe('object');
    expect(serverModule).not.toBeNull();
  });
});
