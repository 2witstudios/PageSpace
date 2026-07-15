import { describe, it, expect, vi, beforeEach } from 'vitest';

// -------------------------------------------------------------------------
// Mocks — hoisted before imports
// -------------------------------------------------------------------------
//
// A client-supplied message id is accepted by both chat routes (route.ts,
// global/[id]/messages/route.ts) and reaches this module's upsert unscoped.
// Before this fix, `onConflictDoUpdate` had no `where` clause: a colliding id
// from a DIFFERENT conversation silently overwrote that row's content
// (chatMessages) and, worse, re-parented it (chatMessages sets
// `conversationId` in its update SET) — moving another user's message into
// the attacker/bug-triggering caller's conversation. A colliding id from the
// SAME conversation but a DIFFERENT role (e.g. a 'user' save id-colliding
// with an existing 'assistant' row) was a second, narrower gap: `role` is
// never written in `set` (a message's role is immutable), but without also
// requiring it in `where`, the update still proceeded and silently
// overwrote that assistant reply's content. These tests pin the fix: the
// upsert's ON CONFLICT DO UPDATE is scoped with `WHERE conversationId =
// <caller's> AND role = <caller's>`, so Postgres skips the update entirely
// (no insert, no update — the row is simply left alone, and the function
// THROWS rather than silently returning) on either kind of collision.

const { mockOnConflictDoUpdate, mockReturning } = vi.hoisted(() => ({
  mockOnConflictDoUpdate: vi.fn(),
  mockReturning: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: mockOnConflictDoUpdate,
      }),
    }),
  },
}));

vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: { id: 'chat_messages.id', conversationId: 'chat_messages.conversation_id', role: 'chat_messages.role' },
}));

vi.mock('@pagespace/db/schema/conversations', () => ({
  messages: { id: 'messages.id', conversationId: 'messages.conversation_id', role: 'messages.role' },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ kind: 'eq', field, value })),
  and: vi.fn((...conds: unknown[]) => ({ kind: 'and', conds })),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: {
      debug: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock('@/lib/channels/notify-mentioned-users', () => ({
  notifyMentionedUsers: vi.fn(),
}));

// -------------------------------------------------------------------------
// Import after mocks
// -------------------------------------------------------------------------

import { saveMessageToDatabase, saveGlobalAssistantMessageToDatabase, MessageConversationConflictError } from '../message-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';

const baseArgs = {
  messageId: 'msg-1',
  pageId: 'page-1',
  conversationId: 'conv-1',
  userId: null as string | null,
  role: 'user' as const,
  content: 'hello',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockOnConflictDoUpdate.mockReturnValue({ returning: mockReturning });
  // Default: the row exists in the CALLER's own conversation and role (or is a
  // fresh insert) — the upsert succeeds and returns the affected row.
  mockReturning.mockResolvedValue([{ id: 'msg-1' }]);
});

describe('saveMessageToDatabase — scoped upsert (chatMessages)', () => {
  it('scopes ON CONFLICT DO UPDATE to a row already in the CALLER conversation AND role', async () => {
    await saveMessageToDatabase({ ...baseArgs });

    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    const call = mockOnConflictDoUpdate.mock.calls[0][0] as { where?: unknown };
    expect(call.where).toEqual({
      kind: 'and',
      conds: [
        { kind: 'eq', field: 'chat_messages.conversation_id', value: 'conv-1' },
        { kind: 'eq', field: 'chat_messages.role', value: 'user' },
      ],
    });
  });

  it('does not re-parent: the ON CONFLICT DO UPDATE SET no longer writes conversationId', async () => {
    await saveMessageToDatabase({ ...baseArgs });

    const call = mockOnConflictDoUpdate.mock.calls[0][0] as { set?: Record<string, unknown> };
    expect(call.set).not.toHaveProperty('conversationId');
  });

  it('does not mutate role: the ON CONFLICT DO UPDATE SET never writes role (immutable)', async () => {
    await saveMessageToDatabase({ ...baseArgs });

    const call = mockOnConflictDoUpdate.mock.calls[0][0] as { set?: Record<string, unknown> };
    expect(call.set).not.toHaveProperty('role');
  });

  it('given the upsert affects zero rows (id collided with a different conversation), throws MessageConversationConflictError after warning', async () => {
    mockReturning.mockResolvedValue([]);

    await expect(saveMessageToDatabase({ ...baseArgs })).rejects.toBeInstanceOf(MessageConversationConflictError);

    expect(loggers.ai.warn).toHaveBeenCalledWith(
      'saveMessageToDatabase: client-supplied id collided with a message in a different conversation — rejected',
      expect.objectContaining({ messageId: 'msg-1', conversationId: 'conv-1' }),
    );
  });

  it('given the upsert affects a row (same-conversation-and-role resend, or a fresh insert), resolves without warning', async () => {
    await expect(saveMessageToDatabase({ ...baseArgs })).resolves.toBeUndefined();

    expect(loggers.ai.warn).not.toHaveBeenCalled();
  });
});

describe('saveGlobalAssistantMessageToDatabase — scoped upsert (messages)', () => {
  const globalArgs = {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    role: 'user' as const,
    content: 'hello',
  };

  it('scopes ON CONFLICT DO UPDATE to a row already in the CALLER conversation AND role', async () => {
    await saveGlobalAssistantMessageToDatabase({ ...globalArgs });

    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    const call = mockOnConflictDoUpdate.mock.calls[0][0] as { where?: unknown };
    expect(call.where).toEqual({
      kind: 'and',
      conds: [
        { kind: 'eq', field: 'messages.conversation_id', value: 'conv-1' },
        { kind: 'eq', field: 'messages.role', value: 'user' },
      ],
    });
  });

  it('given the upsert affects zero rows (id collided with a different conversation OR role), throws MessageConversationConflictError after warning', async () => {
    mockReturning.mockResolvedValue([]);

    await expect(saveGlobalAssistantMessageToDatabase({ ...globalArgs })).rejects.toBeInstanceOf(
      MessageConversationConflictError,
    );

    expect(loggers.ai.warn).toHaveBeenCalledWith(
      'saveGlobalAssistantMessageToDatabase: client-supplied id collided with a message in a different conversation — rejected',
      expect.objectContaining({ messageId: 'msg-1', conversationId: 'conv-1' }),
    );
  });

  it('given a "user"-role save whose id collides with an existing "assistant" row in the SAME conversation, throws (does not spoof the assistant reply)', async () => {
    // Simulates: WHERE conversationId = ... AND role = 'user' does not match an
    // existing row whose role is 'assistant' — Postgres skips the conflict action,
    // .returning() comes back empty, same as the cross-conversation case.
    mockReturning.mockResolvedValue([]);

    await expect(
      saveGlobalAssistantMessageToDatabase({ ...globalArgs, role: 'user' }),
    ).rejects.toBeInstanceOf(MessageConversationConflictError);
  });
});
