import { describe, it, expect, vi, beforeEach } from 'vitest';

// -------------------------------------------------------------------------
// Mocks — hoisted before imports
// -------------------------------------------------------------------------
//
// A client-supplied message id is accepted by both chat routes (route.ts:564,
// global/[id]/messages/route.ts:441) and reaches this module's upsert
// unscoped. Before this fix, `onConflictDoUpdate` had no `where` clause: a
// colliding id from a DIFFERENT conversation silently overwrote that row's
// content (chatMessages) and, worse, re-parented it (chatMessages sets
// `conversationId` in its update SET) — moving another user's message into
// the attacker/bug-triggering caller's conversation. These tests pin the fix:
// the upsert's ON CONFLICT DO UPDATE is scoped with a `WHERE conversationId =
// <caller's>` clause, so Postgres skips the update entirely (no insert, no
// update — the row is simply left alone) when the collision is cross-conversation.

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
  chatMessages: { id: 'chat_messages.id', conversationId: 'chat_messages.conversation_id' },
}));

vi.mock('@pagespace/db/schema/conversations', () => ({
  messages: { id: 'messages.id', conversationId: 'messages.conversation_id' },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ kind: 'eq', field, value })),
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

import { saveMessageToDatabase, saveGlobalAssistantMessageToDatabase } from '../message-utils';
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
  // Default: the row exists in the CALLER's own conversation (or is a fresh
  // insert) — the upsert succeeds and returns the affected row.
  mockReturning.mockResolvedValue([{ id: 'msg-1' }]);
});

describe('saveMessageToDatabase — scoped upsert (chatMessages)', () => {
  it('scopes ON CONFLICT DO UPDATE to a row already in the CALLER conversation', async () => {
    await saveMessageToDatabase({ ...baseArgs });

    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    const call = mockOnConflictDoUpdate.mock.calls[0][0] as { where?: unknown };
    expect(call.where).toEqual({ kind: 'eq', field: 'chat_messages.conversation_id', value: 'conv-1' });
  });

  it('does not re-parent: the ON CONFLICT DO UPDATE SET no longer writes conversationId', async () => {
    await saveMessageToDatabase({ ...baseArgs });

    const call = mockOnConflictDoUpdate.mock.calls[0][0] as { set?: Record<string, unknown> };
    expect(call.set).not.toHaveProperty('conversationId');
  });

  it('given the upsert affects zero rows (id collided with a different conversation), warns rather than silently succeeding', async () => {
    mockReturning.mockResolvedValue([]);

    await saveMessageToDatabase({ ...baseArgs });

    expect(loggers.ai.warn).toHaveBeenCalledWith(
      'saveMessageToDatabase: client-supplied id collided with a message in a different conversation — rejected',
      expect.objectContaining({ messageId: 'msg-1', conversationId: 'conv-1' }),
    );
  });

  it('given the upsert affects a row (same-conversation resend, or a fresh insert), does not warn', async () => {
    await saveMessageToDatabase({ ...baseArgs });

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

  it('scopes ON CONFLICT DO UPDATE to a row already in the CALLER conversation', async () => {
    await saveGlobalAssistantMessageToDatabase({ ...globalArgs });

    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    const call = mockOnConflictDoUpdate.mock.calls[0][0] as { where?: unknown };
    expect(call.where).toEqual({ kind: 'eq', field: 'messages.conversation_id', value: 'conv-1' });
  });

  it('given the upsert affects zero rows (id collided with a different conversation), warns rather than silently succeeding', async () => {
    mockReturning.mockResolvedValue([]);

    await saveGlobalAssistantMessageToDatabase({ ...globalArgs });

    expect(loggers.ai.warn).toHaveBeenCalledWith(
      'saveGlobalAssistantMessageToDatabase: client-supplied id collided with a message in a different conversation — rejected',
      expect.objectContaining({ messageId: 'msg-1', conversationId: 'conv-1' }),
    );
  });
});
