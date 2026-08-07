/**
 * The session→conversation listing-reopen decision — the property under test
 * is the cap guard (a session already at `MAX_SESSION_CONVERSATIONS` open
 * listings refuses a reopen) plus idempotency (reopening an already-open
 * listing, or racing another reopen, is success, never an error), mirroring
 * `close-conversation-in-session.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MAX_SESSION_CONVERSATIONS } from '@pagespace/lib/agent-workspaces/plan-spawn-session';
import {
  reopenConversationInSessionWith,
  type ReopenConversationInSessionDeps,
} from '../reopen-conversation-in-session';

let deps: {
  findConversation: ReturnType<typeof vi.fn>;
  countOpenConversations: ReturnType<typeof vi.fn>;
  reopenConversation: ReturnType<typeof vi.fn>;
};

const input = { conversationId: 'conv-1', workspaceId: 'ses-1' };
const run = () => reopenConversationInSessionWith(deps as ReopenConversationInSessionDeps, input);

beforeEach(() => {
  deps = {
    findConversation: vi.fn(async () => ({
      workspaceId: 'ses-1',
      closedInWorkspaceAt: new Date('2026-01-01'),
      isActive: true,
    })),
    countOpenConversations: vi.fn(async () => 1),
    reopenConversation: vi.fn(async () => 'reopened' as const),
  };
});

describe('reopenConversationInSessionWith', () => {
  it('reopens a closed conversation when the session has room', async () => {
    await expect(run()).resolves.toBe('reopened');
    expect(deps.reopenConversation).toHaveBeenCalledWith('conv-1');
  });

  it('given no such row, should answer not_in_session', async () => {
    deps.findConversation.mockResolvedValue(null);
    await expect(run()).resolves.toBe('not_in_session');
    expect(deps.countOpenConversations).not.toHaveBeenCalled();
    expect(deps.reopenConversation).not.toHaveBeenCalled();
  });

  it("given the row belongs to a DIFFERENT session, should answer not_in_session — same shape as no such row", async () => {
    deps.findConversation.mockResolvedValue({
      workspaceId: 'ses-other',
      closedInWorkspaceAt: new Date('2026-01-01'),
      isActive: true,
    });
    await expect(run()).resolves.toBe('not_in_session');
    expect(deps.reopenConversation).not.toHaveBeenCalled();
  });

  it('given a row bound to no session at all (workspaceId null), should answer not_in_session', async () => {
    deps.findConversation.mockResolvedValue({ workspaceId: null, closedInWorkspaceAt: new Date('2026-01-01'), isActive: true });
    await expect(run()).resolves.toBe('not_in_session');
  });

  it('given a history-deleted target (isActive false), should answer history_deleted WITHOUT weighing the cap', async () => {
    deps.findConversation.mockResolvedValue({ workspaceId: 'ses-1', closedInWorkspaceAt: new Date('2026-01-01'), isActive: false });
    await expect(run()).resolves.toBe('history_deleted');
    expect(deps.countOpenConversations).not.toHaveBeenCalled();
    expect(deps.reopenConversation).not.toHaveBeenCalled();
  });

  describe('the cap guard', () => {
    it('refuses to reopen when the session already holds MAX_SESSION_CONVERSATIONS open listings', async () => {
      deps.countOpenConversations.mockResolvedValue(MAX_SESSION_CONVERSATIONS);
      await expect(run()).resolves.toBe('session_full');
      expect(deps.reopenConversation).not.toHaveBeenCalled();
    });

    it('allows reopening with room for exactly one more', async () => {
      deps.countOpenConversations.mockResolvedValue(MAX_SESSION_CONVERSATIONS - 1);
      await expect(run()).resolves.toBe('reopened');
    });
  });

  describe('idempotency', () => {
    it('reopening an already-open conversation is a no-op success, not an error', async () => {
      deps.findConversation.mockResolvedValue({ workspaceId: 'ses-1', closedInWorkspaceAt: null, isActive: true });
      await expect(run()).resolves.toBe('already_open');
      // Already open — no need to weigh the cap or write anything.
      expect(deps.countOpenConversations).not.toHaveBeenCalled();
      expect(deps.reopenConversation).not.toHaveBeenCalled();
    });

    it('a race that reopens the row between the check and the write folds into already_open', async () => {
      deps.reopenConversation.mockResolvedValue('noop');
      await expect(run()).resolves.toBe('already_open');
    });
  });
});
