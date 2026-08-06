import { describe, it, expect, vi, beforeEach } from 'vitest';

// -------------------------------------------------------------------------
// message-repository write guards — the scoped upsert + mentionNotify
// contracts, moved here with the raw savers (formerly exported from
// message-utils.ts, pinned by message-utils-scoped-upsert.test.ts and
// message-utils-mention-notify.test.ts; the savers are now PRIVATE to the
// repository, so their contracts are pinned through the public methods).
//
// Scoped-upsert contract: a client-supplied message id is accepted by both
// chat routes and reaches the upsert unscoped. The ON CONFLICT DO UPDATE is
// gated `WHERE conversationId = <caller's> AND role = <caller's>`, so a
// colliding id from a DIFFERENT conversation — or a same-conversation
// role-spoof — makes Postgres skip the conflict action entirely, and the
// save THROWS (never a silent no-op the caller mistakes for success).
// -------------------------------------------------------------------------

const { mockOnConflictDoUpdate, mockReturning, mockBumpConversationRev } = vi.hoisted(() => ({
  mockOnConflictDoUpdate: vi.fn(),
  mockReturning: vi.fn(),
  mockBumpConversationRev: vi.fn(),
}));

const txMock = {
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    }),
  }),
  insert: vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: mockOnConflictDoUpdate,
    }),
  }),
};

vi.mock('@pagespace/db/db', () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
  },
}));

vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: { id: 'chat_messages.id', conversationId: 'chat_messages.conversation_id', role: 'chat_messages.role', status: 'chat_messages.status' },
}));

vi.mock('@pagespace/db/schema/conversations', () => ({
  messages: { id: 'messages.id', conversationId: 'messages.conversation_id', role: 'messages.role', status: 'messages.status' },
  conversations: { id: 'conversations.id', isActive: 'conversations.is_active' },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ kind: 'eq', field, value })),
  and: vi.fn((...conds: unknown[]) => ({ kind: 'and', conds })),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: { debug: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn() },
    api: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/ai/global-channel-id', () => ({
  globalChannelId: vi.fn((userId: string) => `user:${userId}:global`),
}));

const mockNotifyMentionedUsers = vi.fn();
vi.mock('@/lib/channels/notify-mentioned-users', () => ({
  notifyMentionedUsers: (...args: unknown[]) => mockNotifyMentionedUsers(...args),
}));

vi.mock('@/lib/websocket/conversation-events', () => ({
  SERVER_TRIGGERED_BROWSER_SESSION: 'server',
  conversationEvents: {
    messageCreated: vi.fn().mockResolvedValue(undefined),
    messageUpdated: vi.fn().mockResolvedValue(undefined),
    messageDeleted: vi.fn().mockResolvedValue(undefined),
    undoApplied: vi.fn().mockResolvedValue(undefined),
    created: vi.fn().mockResolvedValue(undefined),
    updated: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastAiMessageEdited: vi.fn().mockResolvedValue(undefined),
  broadcastAiMessageDeleted: vi.fn().mockResolvedValue(undefined),
  broadcastAiUndoApplied: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/repositories/chat-message-repository', () => ({
  chatMessageRepository: { getMessageById: vi.fn().mockResolvedValue(null) },
}));

vi.mock('@/lib/repositories/global-conversation-repository', () => ({
  globalConversationRepository: {
    getMessageById: vi.fn().mockResolvedValue(null),
    recomputeLastMessageAt: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/repositories/conversation-rev', () => ({
  bumpConversationRev: mockBumpConversationRev,
  emitContextFromRow: vi.fn((row: { id: string }) => ({
    conversationId: row.id,
    rev: 1,
    scope: { kind: 'global', ownerId: 'owner' },
    workspaceId: null,
    ownerId: 'owner',
    isShared: false,
    triggeredBy: { userId: 'owner', browserSessionId: 'server' },
  })),
}));

// -------------------------------------------------------------------------
// Import after mocks
// -------------------------------------------------------------------------

import { messageRepository } from '../message-repository';
import { MessageConversationConflictError } from '@/lib/ai/core/message-utils';
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
  // No conversations row (legacy conversation): rev 0, content event only.
  mockBumpConversationRev.mockResolvedValue(null);
});

describe('savePageMessage — scoped upsert (chatMessages)', () => {
  it('scopes ON CONFLICT DO UPDATE to a row already in the CALLER conversation AND role', async () => {
    await messageRepository.savePageMessage({ ...baseArgs });

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
    await messageRepository.savePageMessage({ ...baseArgs });

    const call = mockOnConflictDoUpdate.mock.calls[0][0] as { set?: Record<string, unknown> };
    expect(call.set).not.toHaveProperty('conversationId');
  });

  it('does not mutate role: the ON CONFLICT DO UPDATE SET never writes role (immutable)', async () => {
    await messageRepository.savePageMessage({ ...baseArgs });

    const call = mockOnConflictDoUpdate.mock.calls[0][0] as { set?: Record<string, unknown> };
    expect(call.set).not.toHaveProperty('role');
  });

  it('given the upsert affects zero rows (id collided with a different conversation), throws MessageConversationConflictError after warning', async () => {
    mockReturning.mockResolvedValue([]);

    await expect(messageRepository.savePageMessage({ ...baseArgs })).rejects.toBeInstanceOf(
      MessageConversationConflictError,
    );

    expect(loggers.ai.warn).toHaveBeenCalledWith(
      'messageRepository: client-supplied id collided with a message in a different conversation — rejected',
      expect.objectContaining({ messageId: 'msg-1', conversationId: 'conv-1' }),
    );
  });

  it('given the upsert affects a row, resolves with { saved: true } and no warning', async () => {
    await expect(messageRepository.savePageMessage({ ...baseArgs })).resolves.toEqual({
      saved: true,
      rev: 0,
    });

    expect(loggers.ai.warn).not.toHaveBeenCalled();
  });

  it('given a beforeSave hook that declines, skips the write entirely', async () => {
    await expect(
      messageRepository.savePageMessage({ ...baseArgs, beforeSave: async () => false }),
    ).resolves.toEqual({ saved: false, rev: 0 });

    expect(txMock.insert).not.toHaveBeenCalled();
  });
});

describe('saveGlobalMessage — scoped upsert (messages)', () => {
  const globalArgs = {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    role: 'user' as const,
    content: 'hello',
  };

  it('scopes ON CONFLICT DO UPDATE to a row already in the CALLER conversation AND role', async () => {
    await messageRepository.saveGlobalMessage({ ...globalArgs });

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

  it('given the upsert affects zero rows (cross-conversation OR role collision), throws MessageConversationConflictError', async () => {
    mockReturning.mockResolvedValue([]);

    await expect(messageRepository.saveGlobalMessage({ ...globalArgs })).rejects.toBeInstanceOf(
      MessageConversationConflictError,
    );
  });

  it('given a "user"-role save whose id collides with an existing "assistant" row in the SAME conversation, throws (does not spoof the assistant reply)', async () => {
    mockReturning.mockResolvedValue([]);

    await expect(
      messageRepository.saveGlobalMessage({ ...globalArgs, role: 'user' }),
    ).rejects.toBeInstanceOf(MessageConversationConflictError);
  });
});

describe('savePageMessage — mentionNotify', () => {
  const mentionArgs = {
    ...baseArgs,
    role: 'assistant' as const,
    content: 'Hello @[Alice](alice-id:user)',
  };

  beforeEach(() => {
    mockNotifyMentionedUsers.mockResolvedValue(undefined);
  });

  it('fires notifyMentionedUsers for assistant role when mentionNotify is provided', async () => {
    await messageRepository.savePageMessage({
      ...mentionArgs,
      mentionNotify: { driveId: 'drive-1', triggeredByUserId: 'user-x', mentionerName: 'MyAgent' },
    });

    await Promise.resolve();

    expect(mockNotifyMentionedUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Hello @[Alice](alice-id:user)',
        pageId: 'page-1',
        driveId: 'drive-1',
        triggeredByUserId: 'user-x',
        mentionerNameOverride: 'MyAgent',
      }),
    );
  });

  it('does NOT fire notifyMentionedUsers for user role saves', async () => {
    await messageRepository.savePageMessage({
      ...mentionArgs,
      userId: 'human-user',
      role: 'user',
      mentionNotify: { driveId: 'drive-1', triggeredByUserId: 'human-user' },
    });
    await Promise.resolve();
    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });

  it('does NOT fire notifyMentionedUsers when mentionNotify is absent', async () => {
    await messageRepository.savePageMessage({ ...mentionArgs });
    await Promise.resolve();
    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });

  it('save succeeds even when notifyMentionedUsers rejects', async () => {
    mockNotifyMentionedUsers.mockRejectedValue(new Error('notify boom'));

    await expect(
      messageRepository.savePageMessage({
        ...mentionArgs,
        mentionNotify: { driveId: 'drive-1', triggeredByUserId: 'user-x' },
      }),
    ).resolves.toEqual({ saved: true, rev: 0 });
  });

  it('does not fire when content is empty', async () => {
    await messageRepository.savePageMessage({
      ...mentionArgs,
      content: '',
      mentionNotify: { driveId: 'drive-1', triggeredByUserId: 'user-x' },
    });
    await Promise.resolve();
    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });
});
