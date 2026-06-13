import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      returning: vi.fn().mockResolvedValue(insertResult),
    }),
  }),
});

const CONV = { id: 'conv1', userId: 'user1', isActive: true, type: 'global' };

describe('resolveOrCreateConversation', () => {
  it('given existing conversation owned by the user, returns it without inserting', async () => {
    const db = makeDb([CONV]);
    const result = await resolveOrCreateConversation('user1', 'conv1', db as never);
    expect(result).toEqual(CONV);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('given no existing conversation, creates one with the correct fields', async () => {
    const created = { id: 'conv1', userId: 'user1', type: 'global', isActive: true };
    const db = makeDb([], [created]);
    const result = await resolveOrCreateConversation('user1', 'conv1', db as never);
    expect(result).toEqual(created);
    expect(db.insert).toHaveBeenCalled();
  });

  it('given existing conversation owned by a different user, throws ConversationOwnershipError', async () => {
    const otherUserConv = { ...CONV, userId: 'user2' };
    // select returns the conversation but userId doesn't match
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            // First call (broad select without userId): return the conv
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
    await resolveOrCreateConversation('user1', 'conv1', db as never);
    await resolveOrCreateConversation('user1', 'conv1', db as never);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
