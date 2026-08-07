/**
 * The session→conversation listing-reopen decision — the property under test
 * is the cap guard (a session already at `MAX_SESSION_CONVERSATIONS` open
 * listings refuses a reopen) plus idempotency (reopening an already-open
 * listing, or racing another reopen, is success, never an error), mirroring
 * `close-conversation-in-session.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MAX_SESSION_CONVERSATIONS } from '@pagespace/lib/agent-workspaces/plan-spawn-worker';
import {
  reopenConversationInSessionWith,
  type ReopenConversationInSessionDeps,
} from '../reopen-conversation-in-session';

let deps: {
  findConversation: ReturnType<typeof vi.fn>;
  countOpenConversations: ReturnType<typeof vi.fn>;
  reopenConversation: ReturnType<typeof vi.fn>;
};

const OWNER = 'user-1';
const input = { conversationId: 'conv-1', userId: OWNER, workspaceId: 'ses-1' };
const run = () => reopenConversationInSessionWith(deps as ReopenConversationInSessionDeps, input);

beforeEach(() => {
  deps = {
    findConversation: vi.fn(async () => ({
      userId: OWNER,
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
      userId: OWNER,
      workspaceId: 'ses-other',
      closedInWorkspaceAt: new Date('2026-01-01'),
      isActive: true,
    });
    await expect(run()).resolves.toBe('not_in_session');
    expect(deps.reopenConversation).not.toHaveBeenCalled();
  });

  it('given a row bound to no session at all (workspaceId null), should answer not_in_session', async () => {
    deps.findConversation.mockResolvedValue({ userId: OWNER, workspaceId: null, closedInWorkspaceAt: new Date('2026-01-01'), isActive: true });
    await expect(run()).resolves.toBe('not_in_session');
  });

  // The mirror of the close side's gate: the session check on the route admits
  // every drive member, so only this keeps a listing its owner deliberately
  // dismissed from being pushed back into their sidebar by someone else.
  describe('the ownership gate', () => {
    it("refuses a conversation the caller does not own — same shape as no such row", async () => {
      deps.findConversation.mockResolvedValue({
        userId: 'mallory',
        workspaceId: 'ses-1',
        closedInWorkspaceAt: new Date('2026-01-01'),
        isActive: true,
      });
      await expect(run()).resolves.toBe('not_in_session');
      expect(deps.reopenConversation).not.toHaveBeenCalled();
    });

    it('is checked BEFORE the history-deleted and idempotency branches, so a foreign row leaks no state', async () => {
      // `history_deleted` or `already_open` on a foreign id would each reveal
      // that the row exists and what state it is in.
      deps.findConversation.mockResolvedValue({
        userId: 'mallory',
        workspaceId: 'ses-1',
        closedInWorkspaceAt: null,
        isActive: false,
      });
      await expect(run()).resolves.toBe('not_in_session');
      expect(deps.countOpenConversations).not.toHaveBeenCalled();
    });
  });

  it('given a history-deleted target (isActive false), should answer history_deleted WITHOUT weighing the cap', async () => {
    deps.findConversation.mockResolvedValue({ userId: OWNER, workspaceId: 'ses-1', closedInWorkspaceAt: new Date('2026-01-01'), isActive: false });
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
      deps.findConversation.mockResolvedValue({ userId: OWNER, workspaceId: 'ses-1', closedInWorkspaceAt: null, isActive: true });
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
