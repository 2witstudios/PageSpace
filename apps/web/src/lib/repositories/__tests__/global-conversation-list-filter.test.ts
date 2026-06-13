/**
 * Tests for listConversations / listConversationsPaginated excluding empty conversations,
 * and getActiveGlobalConversation preferring most-recently-messaged conversation.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const mockExists = vi.hoisted(() => vi.fn((sub) => ({ op: 'exists', sub })));

// Records calls at module-load time (when hasMessages constant is built).
// Must be captured BEFORE vi.clearAllMocks() in beforeEach runs.
let existsCallCountAtModuleLoad = 0;

vi.mock('@pagespace/db/db', () => ({
  db: {
    // select needed at module load time for: const hasMessages = exists(db.select(...))
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ orderBy: vi.fn().mockResolvedValue([]), limit: vi.fn().mockResolvedValue([]) }),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }) }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col, val) => ({ op: 'eq', col, val })),
  and: vi.fn((...args) => ({ op: 'and', args })),
  desc: vi.fn((field) => ({ op: 'desc', field })),
  sql: vi.fn((s) => ({ op: 'sql', s })),
  lt: vi.fn((col, val) => ({ op: 'lt', col, val })),
  exists: mockExists,
  isNull: vi.fn((f) => ({ op: 'isNull', f })),
  isNotNull: vi.fn((f) => ({ op: 'isNotNull', f })),
}));
vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: {
    id: 'id', userId: 'userId', isActive: 'isActive', type: 'type',
    title: 'title', contextId: 'contextId', lastMessageAt: 'lastMessageAt',
    createdAt: 'createdAt',
  },
  messages: { conversationId: 'conversationId', isActive: 'isActive' },
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  aiUsageLogs: { conversationId: 'conversationId', userId: 'userId' },
}));
vi.mock('@/lib/ai/core/compaction/compaction-repository', () => ({
  invalidate: vi.fn(),
}));

import { globalConversationRepository } from '../global-conversation-repository';

// Thenable query result: awaitable AND has .limit() for pagination.
function queryResult(data: object[]) {
  const p = Promise.resolve(data);
  return Object.assign(p, {
    limit: vi.fn().mockResolvedValue(data),
  });
}

const CONV = {
  id: 'conv-a', userId: 'user1', type: 'global', contextId: null,
  title: 'Hello', lastMessageAt: new Date('2026-06-10'), createdAt: new Date('2026-06-01'),
};

function makeDb(data: object[]) {
  const mockLimit = vi.fn().mockResolvedValue(data);
  const mockOrderBy = vi.fn().mockReturnValue(queryResult(data));
  const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy, limit: mockLimit });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
  return { db: { select: mockSelect }, mockWhere, mockOrderBy, mockLimit };
}

// Monkey-patch the db used by the repository for each test.
// Since the module imports db at the top, we patch through the mock module.
import { db as dbRef } from '@pagespace/db/db';

beforeAll(() => {
  // Capture how many times exists() was called when the module initialised
  // (i.e. when `const hasMessages = exists(...)` ran at module load time).
  existsCallCountAtModuleLoad = mockExists.mock.calls.length;
});

describe('globalConversationRepository — hasMessages constant', () => {
  it('calls exists() exactly once when the module loads (to build hasMessages)', () => {
    expect(existsCallCountAtModuleLoad).toBe(1);
  });
});

describe('globalConversationRepository.listConversations — EXISTS filter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes the EXISTS condition in the WHERE clause', async () => {
    const { db, mockWhere } = makeDb([CONV]);
    Object.assign(dbRef, db);

    await globalConversationRepository.listConversations('user1');

    const whereArg = mockWhere.mock.calls[0]?.[0];
    // and() wraps conditions including hasMessages ({ op: 'exists', ... })
    expect(JSON.stringify(whereArg)).toContain('exists');
  });

  it('returns conversations returned by the DB', async () => {
    const { db } = makeDb([CONV]);
    Object.assign(dbRef, db);

    const result = await globalConversationRepository.listConversations('user1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('conv-a');
  });

  it('returns empty array when DB returns nothing', async () => {
    const { db } = makeDb([]);
    Object.assign(dbRef, db);

    const result = await globalConversationRepository.listConversations('user1');
    expect(result).toHaveLength(0);
  });
});

describe('globalConversationRepository.getActiveGlobalConversation — ordering', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls orderBy with 2 arguments (lastMessageAt DESC NULLS LAST, then createdAt DESC)', async () => {
    const { db, mockOrderBy } = makeDb([CONV]);
    Object.assign(dbRef, db);

    await globalConversationRepository.getActiveGlobalConversation('user1');

    expect(mockOrderBy).toHaveBeenCalled();
    const args = mockOrderBy.mock.calls[0];
    expect(args.length).toBeGreaterThanOrEqual(2);
  });

  it('returns null when DB returns no rows', async () => {
    const { db } = makeDb([]);
    Object.assign(dbRef, db);

    const result = await globalConversationRepository.getActiveGlobalConversation('user1');
    expect(result).toBeNull();
  });

  it('returns the first conversation from the DB', async () => {
    const { db } = makeDb([CONV]);
    Object.assign(dbRef, db);

    const result = await globalConversationRepository.getActiveGlobalConversation('user1');
    expect(result?.id).toBe('conv-a');
  });
});
