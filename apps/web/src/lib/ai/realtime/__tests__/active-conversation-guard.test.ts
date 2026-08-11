/**
 * The transcript write's in-transaction guard.
 *
 * `persistVoiceTranscript` checks `isActive` before it writes, but a call is
 * held open for minutes and the gap between that check and the insert spans the
 * whole bridge hop — so a user deleting the thread mid-call lands squarely in
 * it. This is the re-decision that runs inside the write transaction, holding
 * the row.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({
  eq: (field: unknown, value: unknown) => ({ kind: 'eq', field, value }),
}));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'pages.id' } }));
vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: { id: 'conversations.id', isActive: 'conversations.isActive' },
}));
vi.mock('@pagespace/lib/permissions/conversation-access', () => ({
  canAccessConversation: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } },
}));
vi.mock('@/lib/repositories/conversation-repository', () => ({ conversationRepository: {} }));
vi.mock('@/lib/repositories/message-repository', () => ({ messageRepository: {} }));
vi.mock('@/lib/repositories/resolve-or-create-conversation', () => ({
  resolveOrCreateConversation: vi.fn(),
  ConversationHistoryDeletedError: class extends Error {},
  ConversationOwnershipError: class extends Error {},
}));
vi.mock('@/lib/ai/core/ai-tools', () => ({ buildPageSpaceTools: () => ({}) }));
vi.mock('../tools', () => ({ buildRealtimeToolSet: () => ({}) }));

import { activeConversationGuard } from '../voice-runtime-deps';

/** A `tx` that answers one `SELECT … FOR UPDATE` with whatever rows it is given. */
const fakeTx = (rows: { isActive: boolean }[]) => {
  const forUpdate = vi.fn();
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          for: (mode: string) => {
            forUpdate(mode);
            return { limit: vi.fn(async () => rows) };
          },
        })),
      })),
    })),
  };
  return { tx, forUpdate };
};

describe('activeConversationGuard', () => {
  it('given a live conversation, should allow the write', async () => {
    const { tx } = fakeTx([{ isActive: true }]);

    await expect(activeConversationGuard('conv1')(tx as never)).resolves.toBe(true);
  });

  it('given a conversation deleted mid-call, should refuse the write', async () => {
    // The turn would otherwise be persisted under a thread no listing reaches.
    const { tx } = fakeTx([{ isActive: false }]);

    await expect(activeConversationGuard('conv1')(tx as never)).resolves.toBe(false);
  });

  it('given NO row at all, should refuse rather than assume the best', async () => {
    // Every path reaching the voice save wrappers has already loaded or created
    // the row, so a row that is gone by now was deleted. (This is the one place
    // the voice guard deliberately differs from the chat-pipeline hooks, which
    // tolerate a missing row because they can race their own eager create.)
    const { tx } = fakeTx([]);

    await expect(activeConversationGuard('conv1')(tx as never)).resolves.toBe(false);
  });

  it('should take the row lock, not merely read it', async () => {
    // Without FOR UPDATE this is a second guess rather than a decision: it would
    // not serialise against the delete, and both could believe they won.
    const { tx, forUpdate } = fakeTx([{ isActive: true }]);

    await activeConversationGuard('conv1')(tx as never);

    expect(forUpdate).toHaveBeenCalledWith('update');
  });
});
