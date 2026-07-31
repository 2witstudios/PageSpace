/**
 * The session→conversation listing-close decision — the property under test
 * is the never-empty guard (a session's LAST open listing refuses to close)
 * plus idempotency (closing an already-closed listing, or racing another
 * close, is success, never an error).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  closeConversationInSessionWith,
  type CloseConversationInSessionDeps,
} from '../close-conversation-in-session';

let deps: {
  findConversation: ReturnType<typeof vi.fn>;
  countOpenConversations: ReturnType<typeof vi.fn>;
  closeConversation: ReturnType<typeof vi.fn>;
};

const input = { conversationId: 'conv-1', sessionId: 'ses-1' };
const run = () => closeConversationInSessionWith(deps as CloseConversationInSessionDeps, input);

beforeEach(() => {
  deps = {
    findConversation: vi.fn(async () => ({ sessionId: 'ses-1', closedInSessionAt: null, isActive: true })),
    countOpenConversations: vi.fn(async () => 2),
    closeConversation: vi.fn(async () => 'closed' as const),
  };
});

describe('closeConversationInSessionWith', () => {
  it('closes an open conversation when other listings remain', async () => {
    await expect(run()).resolves.toBe('closed');
    expect(deps.closeConversation).toHaveBeenCalledWith('conv-1');
  });

  it('given no such row, should answer not_in_session', async () => {
    deps.findConversation.mockResolvedValue(null);
    await expect(run()).resolves.toBe('not_in_session');
    expect(deps.countOpenConversations).not.toHaveBeenCalled();
    expect(deps.closeConversation).not.toHaveBeenCalled();
  });

  it("given the row belongs to a DIFFERENT session, should answer not_in_session — same shape as no such row", async () => {
    deps.findConversation.mockResolvedValue({ sessionId: 'ses-other', closedInSessionAt: null, isActive: true });
    await expect(run()).resolves.toBe('not_in_session');
    expect(deps.closeConversation).not.toHaveBeenCalled();
  });

  it('given a row bound to no session at all (sessionId null), should answer not_in_session', async () => {
    deps.findConversation.mockResolvedValue({ sessionId: null, closedInSessionAt: null, isActive: true });
    await expect(run()).resolves.toBe('not_in_session');
  });

  it('given a history-deleted target (isActive false), should answer already_closed WITHOUT weighing the never-empty guard', async () => {
    // A history-deleted row was never counted in `countOpenConversations`
    // (excluded there by `isActive`), so it isn't occupying a slot the
    // never-empty guard needs to protect. A stale tab still showing it
    // must not get a spurious `last_conversation` (409) just because ONE
    // unrelated listing happens to remain (caught in review).
    deps.findConversation.mockResolvedValue({ sessionId: 'ses-1', closedInSessionAt: null, isActive: false });
    deps.countOpenConversations.mockResolvedValue(1);
    await expect(run()).resolves.toBe('already_closed');
    expect(deps.countOpenConversations).not.toHaveBeenCalled();
    expect(deps.closeConversation).not.toHaveBeenCalled();
  });

  describe('the never-empty guard', () => {
    it('refuses to close the session\'s LAST open listing', async () => {
      deps.countOpenConversations.mockResolvedValue(1);
      await expect(run()).resolves.toBe('last_conversation');
      expect(deps.closeConversation).not.toHaveBeenCalled();
    });

    it('allows closing with exactly one OTHER open listing remaining', async () => {
      deps.countOpenConversations.mockResolvedValue(2);
      await expect(run()).resolves.toBe('closed');
    });

    it('is fail-closed on a corrupt zero count (never trusts "nothing to guard")', async () => {
      deps.countOpenConversations.mockResolvedValue(0);
      await expect(run()).resolves.toBe('last_conversation');
    });
  });

  describe('idempotency', () => {
    it('closing an already-closed conversation is a no-op success, not an error', async () => {
      deps.findConversation.mockResolvedValue({
        sessionId: 'ses-1',
        closedInSessionAt: new Date('2026-01-01'),
        isActive: true,
      });
      await expect(run()).resolves.toBe('already_closed');
      // Already closed — no need to weigh the never-empty guard or write anything.
      expect(deps.countOpenConversations).not.toHaveBeenCalled();
      expect(deps.closeConversation).not.toHaveBeenCalled();
    });

    it('a race that closes the row between the check and the write folds into already_closed', async () => {
      deps.closeConversation.mockResolvedValue('noop');
      await expect(run()).resolves.toBe('already_closed');
    });
  });
});
