import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSelectWhere, mockLimit } = vi.hoisted(() => ({
  mockSelectWhere: vi.fn(),
  mockLimit: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((...args: unknown[]) => {
          const result = mockSelectWhere(...args);
          // `canSubscribeToStream` chains .limit(1); `filterSubscribableStreams` awaits directly.
          return Object.assign(Promise.resolve(result), { limit: mockLimit });
        }),
      })),
    })),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
}));

vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: { id: 'id', userId: 'userId', isShared: 'isShared', type: 'type', contextId: 'contextId' },
}));

// The ONE conversation-subscription predicate (SSoT Phase 2) — mocked so this
// file pins the DELEGATION (all three enforcement points share it; its own
// rule matrix is pinned in packages/lib's conversation-access.test.ts).
const { mockCanAccessConversation } = vi.hoisted(() => ({
  mockCanAccessConversation: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/conversation-access', () => ({
  canAccessConversation: mockCanAccessConversation,
  decideConversationAccess: ({ isOwner, isShared, hasPageAccess }: { isOwner: boolean; isShared: boolean; hasPageAccess: boolean }) =>
    isOwner || (isShared && hasPageAccess),
}));

import { canSubscribeToStream, filterSubscribableStreams } from '../stream-subscription-authz';

// A page channel carries EVERY conversation on that page, and conversations are private
// by default. Authorizing a stream subscription on page access alone therefore hands one
// member's private conversation — token by token, including its buffered parts snapshot —
// to every other member who can open the page.
describe('canSubscribeToStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectWhere.mockReturnValue([]);
    mockLimit.mockResolvedValue([]);
  });

  it('given the caller started the stream, should allow without even looking up the conversation', async () => {
    const allowed = await canSubscribeToStream({
      userId: 'user-1',
      streamOwnerId: 'user-1',
      conversationId: 'conv-1',
    });

    expect(allowed).toBe(true);
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it("given another user's stream in a PRIVATE conversation, should deny", async () => {
    const row = { userId: 'user-a', isShared: false, type: 'page', contextId: 'page-1' };
    mockLimit.mockResolvedValue([row]);
    mockCanAccessConversation.mockResolvedValue(false);

    const allowed = await canSubscribeToStream({
      userId: 'user-b',
      streamOwnerId: 'user-a',
      conversationId: 'their-private-conv',
    });

    expect(allowed).toBe(false);
    expect(mockCanAccessConversation).toHaveBeenCalledWith('user-b', row);
  });

  it("given another user's stream in an explicitly SHARED conversation the caller can access, should allow", async () => {
    const row = { userId: 'user-a', isShared: true, type: 'page', contextId: 'page-1' };
    mockLimit.mockResolvedValue([row]);
    mockCanAccessConversation.mockResolvedValue(true);

    const allowed = await canSubscribeToStream({
      userId: 'user-b',
      streamOwnerId: 'user-a',
      conversationId: 'shared-conv',
    });

    expect(allowed).toBe(true);
    expect(mockCanAccessConversation).toHaveBeenCalledWith('user-b', row);
  });

  // Fail closed: an unknown conversation is not a shared one.
  it("given another user's stream whose conversation has no row, should deny", async () => {
    mockLimit.mockResolvedValue([]);

    const allowed = await canSubscribeToStream({
      userId: 'user-b',
      streamOwnerId: 'user-a',
      conversationId: 'missing',
    });

    expect(allowed).toBe(false);
    expect(mockCanAccessConversation).not.toHaveBeenCalled();
  });
});

describe('filterSubscribableStreams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectWhere.mockReturnValue([]);
  });

  it('given only the caller\'s own streams, should return them all without a query', async () => {
    const rows = [
      { userId: 'user-1', conversationId: 'c1', messageId: 'm1' },
      { userId: 'user-1', conversationId: 'c2', messageId: 'm2' },
    ];

    const result = await filterSubscribableStreams({ userId: 'user-1', rows });

    expect(result).toEqual(rows);
    expect(mockSelectWhere).not.toHaveBeenCalled();
  });

  it("given a mix, should keep own streams and shared ones and drop another user's private stream", async () => {
    mockSelectWhere.mockReturnValue([{ id: 'shared-conv' }]);
    const mine = { userId: 'user-1', conversationId: 'c1', messageId: 'mine' };
    const theirShared = { userId: 'user-2', conversationId: 'shared-conv', messageId: 'shared' };
    const theirPrivate = { userId: 'user-2', conversationId: 'private-conv', messageId: 'private' };

    const result = await filterSubscribableStreams({
      userId: 'user-1',
      rows: [mine, theirShared, theirPrivate],
    });

    expect(result).toEqual([mine, theirShared]);
  });

  it("given only another user's private streams, should return nothing", async () => {
    mockSelectWhere.mockReturnValue([]);

    const result = await filterSubscribableStreams({
      userId: 'user-1',
      rows: [{ userId: 'user-2', conversationId: 'private-conv', messageId: 'x' }],
    });

    expect(result).toEqual([]);
  });
});
