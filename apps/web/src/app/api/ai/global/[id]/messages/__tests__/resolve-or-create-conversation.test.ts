import { describe, it, expect, vi } from 'vitest';

// We test resolveOrCreateConversation in isolation from the route.
// All DB interactions are mocked — no real DB connection.
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col, val) => ({ col, val, op: 'eq' })),
  and: vi.fn((...args) => ({ args, op: 'and' })),
}));
vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: {
    id: 'id',
    userId: 'userId',
    isActive: 'isActive',
    type: 'type',
  },
}));

import { resolveOrCreateConversation, ConversationOwnershipError } from '../resolve-or-create-conversation';

const makeDb = (selectResult: object[], insertResult: object[] = []) => ({
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(selectResult),
      }),
    }),
  }),
  insert: vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(insertResult),
      }),
    }),
  }),
});

const CONV = { id: 'conv1', userId: 'user1', isActive: true, type: 'global' };

describe('resolveOrCreateConversation', () => {
  it('given existing conversation owned by the user, returns it without inserting and isNew=false', async () => {
    const db = makeDb([CONV]);
    const result = await resolveOrCreateConversation('user1', 'conv1', db as never);
    expect(result).toEqual({ conversation: CONV, isNew: false });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('given no existing conversation, creates one with the correct fields and isNew=true', async () => {
    const created = { id: 'conv1', userId: 'user1', type: 'global', isActive: true };
    const db = makeDb([], [created]);
    const result = await resolveOrCreateConversation('user1', 'conv1', db as never);
    expect(result).toEqual({ conversation: created, isNew: true });
    expect(db.insert).toHaveBeenCalled();
  });

  it('given existing conversation owned by a different user, throws ConversationOwnershipError', async () => {
    const otherUserConv = { ...CONV, userId: 'user2' };
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([otherUserConv]),
          }),
        }),
      }),
      insert: vi.fn(),
    };
    await expect(
      resolveOrCreateConversation('user1', 'conv1', db as never)
    ).rejects.toThrow(ConversationOwnershipError);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('given idempotent call (conversation already exists), does not insert a second row', async () => {
    const db = makeDb([CONV]);
    const first = await resolveOrCreateConversation('user1', 'conv1', db as never);
    const second = await resolveOrCreateConversation('user1', 'conv1', db as never);
    expect(first.isNew).toBe(false);
    expect(second.isNew).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('given an invalid conversationId (not CUID2 format), throws ConversationOwnershipError without hitting DB', async () => {
    const db = makeDb([]);
    await expect(
      resolveOrCreateConversation('user1', 'INVALID_ID!!', db as never)
    ).rejects.toThrow(ConversationOwnershipError);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('given an existing conversation with a non-global type, throws ConversationOwnershipError', async () => {
    const pageConv = { ...CONV, type: 'page' };
    const db = makeDb([pageConv]);
    await expect(
      resolveOrCreateConversation('user1', 'conv1', db as never)
    ).rejects.toThrow(ConversationOwnershipError);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('given a concurrent insert race (ON CONFLICT returns no row), falls back to select and returns winner with isNew=true', async () => {
    // insert returns [] (another writer won the race), then fallback select finds the winner
    const winner = { ...CONV };
    const db = {
      select: vi.fn()
        // First call: no existing row (triggers insert path)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
          }),
        })
        // Second call: fallback select finds the winner
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([winner]) }),
          }),
        }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]), // empty — conflict
          }),
        }),
      }),
    };
    const result = await resolveOrCreateConversation('user1', 'conv1', db as never);
    expect(result).toEqual({ conversation: winner, isNew: true });
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});
