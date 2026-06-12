import { describe, it, expect, vi, beforeEach } from 'vitest';

// -------------------------------------------------------------------------
// Mocks — hoisted before imports
// -------------------------------------------------------------------------

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: { id: 'id' },
}));

vi.mock('@pagespace/db/schema/conversations', () => ({
  messages: { id: 'id' },
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

const mockNotifyMentionedUsers = vi.fn();
vi.mock('@/lib/channels/notify-mentioned-users', () => ({
  notifyMentionedUsers: (...args: unknown[]) => mockNotifyMentionedUsers(...args),
}));

// -------------------------------------------------------------------------
// Import after mocks
// -------------------------------------------------------------------------

import { saveMessageToDatabase } from '../message-utils';

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

const baseArgs = {
  messageId: 'msg-1',
  pageId: 'page-1',
  conversationId: 'conv-1',
  userId: null as string | null,
  role: 'assistant' as const,
  content: 'Hello @[Alice](alice-id:user)',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockNotifyMentionedUsers.mockResolvedValue(undefined);
});

describe('saveMessageToDatabase — mentionNotify', () => {
  it('fires notifyMentionedUsers for assistant role when mentionNotify is provided', async () => {
    await saveMessageToDatabase({
      ...baseArgs,
      mentionNotify: {
        driveId: 'drive-1',
        triggeredByUserId: 'user-x',
        mentionerName: 'MyAgent',
      },
    });

    // Fire-and-forget — flush promise queue
    await Promise.resolve();

    expect(mockNotifyMentionedUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Hello @[Alice](alice-id:user)',
        pageId: 'page-1',
        driveId: 'drive-1',
        triggeredByUserId: 'user-x',
        mentionerNameOverride: 'MyAgent',
      })
    );
  });

  it('does NOT fire notifyMentionedUsers for user role saves', async () => {
    await saveMessageToDatabase({
      ...baseArgs,
      userId: 'human-user',
      role: 'user',
      mentionNotify: {
        driveId: 'drive-1',
        triggeredByUserId: 'human-user',
      },
    });

    await Promise.resolve();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });

  it('does NOT fire notifyMentionedUsers when mentionNotify is absent', async () => {
    await saveMessageToDatabase({ ...baseArgs });

    await Promise.resolve();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });

  it('save succeeds even when notifyMentionedUsers rejects', async () => {
    mockNotifyMentionedUsers.mockRejectedValue(new Error('notify boom'));

    await expect(
      saveMessageToDatabase({
        ...baseArgs,
        mentionNotify: { driveId: 'drive-1', triggeredByUserId: 'user-x' },
      })
    ).resolves.toBeUndefined();
  });

  it('does not fire when content is empty', async () => {
    await saveMessageToDatabase({
      ...baseArgs,
      content: '',
      mentionNotify: { driveId: 'drive-1', triggeredByUserId: 'user-x' },
    });

    await Promise.resolve();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });
});
