/**
 * REOPENING IS A `move` BACK, SO IT MINTS NOTHING AND CONSUMES NO SLOT.
 *
 * The cap is the interesting deletion here. The previous version refused a
 * reopen when the workspace held `MAX_SESSION_CONVERSATIONS` open listings,
 * because reopening restored a listing slot the close had freed. Under a `move`
 * the node never stopped existing: closing frees no slot and reopening consumes
 * none, so `session_full` is not a thing this decision can say — and there is no
 * `countOpenConversations` dep to mock, which is the assertion.
 *
 * `history_deleted` survives, and only to give an answer a name. A deleted
 * thread has no node either (the delete removes it), so the membership write
 * would say `not_a_member` — but "you deleted this" is something a caller can
 * act on and "there is no such thread here" is not.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  reopenConversationInSessionWith,
  type ReopenConversationInSessionDeps,
} from '../reopen-conversation-in-workspace';

interface MockDeps extends ReopenConversationInSessionDeps {
  findConversation: ReturnType<typeof vi.fn>;
  readmitConversation: ReturnType<typeof vi.fn>;
  announceReopened: ReturnType<typeof vi.fn>;
}

const OWNER = 'user-1';
const input = { conversationId: 'conv-1', userId: OWNER, workspaceId: 'ws-1' };

function makeDeps(overrides: Partial<Record<keyof MockDeps, unknown>> = {}): MockDeps {
  return {
    findConversation: vi.fn(async () => ({ userId: OWNER, isActive: true })),
    readmitConversation: vi.fn(async () => 'readmitted' as const),
    announceReopened: vi.fn(),
    ...overrides,
  } as MockDeps;
}

describe('reopenConversationInSessionWith', () => {
  let deps: MockDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('moves the thread back onto the grid', async () => {
    expect(await reopenConversationInSessionWith(deps, input)).toBe('reopened');
    expect(deps.readmitConversation).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      workspaceId: 'ws-1',
    });
  });

  it('reopens into a FULL workspace — a member returning consumes no new slot', async () => {
    // There is nothing to arrange: the cap bounds membership, and this thread
    // never stopped being a member. The previous shape needed a count stub here
    // and answered `session_full`.
    expect(await reopenConversationInSessionWith(deps, input)).toBe('reopened');
  });

  it('refuses a conversation this user does not own, as "not there"', async () => {
    deps.findConversation.mockResolvedValue({ userId: 'user-2', isActive: true });

    expect(await reopenConversationInSessionWith(deps, input)).toBe('not_in_session');
    expect(deps.readmitConversation).not.toHaveBeenCalled();
  });

  it('refuses a conversation that does not exist', async () => {
    deps.findConversation.mockResolvedValue(null);

    expect(await reopenConversationInSessionWith(deps, input)).toBe('not_in_session');
    expect(deps.readmitConversation).not.toHaveBeenCalled();
  });

  it('names a history-deleted thread rather than folding it into "not there"', async () => {
    deps.findConversation.mockResolvedValue({ userId: OWNER, isActive: false });

    expect(await reopenConversationInSessionWith(deps, input)).toBe('history_deleted');
    expect(deps.readmitConversation).not.toHaveBeenCalled();
  });

  it('is idempotent on a thread already on the grid', async () => {
    deps.readmitConversation.mockResolvedValue('already_attached');
    expect(await reopenConversationInSessionWith(deps, input)).toBe('already_open');
  });

  it('reports a thread this workspace does not hold as "not there"', async () => {
    deps.readmitConversation.mockResolvedValue('not_a_member');
    expect(await reopenConversationInSessionWith(deps, input)).toBe('not_in_session');
  });

  it('collapses a tree refusal — a workspace with no root — into the same answer', async () => {
    deps.readmitConversation.mockResolvedValue('refused');
    expect(await reopenConversationInSessionWith(deps, input)).toBe('not_in_session');
  });

  /**
   * The mirror of the close side's announcement, missing for the same reason:
   * both emits lived on the deleted `closedInWorkspaceAt` repository writers.
   * The listener answers this one with a re-read rather than local surgery,
   * which is correct — a reopen names a row the cache does NOT have — but a
   * re-read that is never triggered is still the 120s poll.
   */
  describe('the directory announcement', () => {
    it('announces a reopen that actually re-admitted', async () => {
      const row = { userId: OWNER, isActive: true, id: 'conv-1', rev: 3 };
      deps.findConversation.mockResolvedValue(row);

      expect(await reopenConversationInSessionWith(deps, input)).toBe('reopened');
      expect(deps.announceReopened).toHaveBeenCalledWith(row);
    });

    it('stays silent when the thread was already on the grid — nothing changed', async () => {
      deps.readmitConversation.mockResolvedValue('already_attached');

      expect(await reopenConversationInSessionWith(deps, input)).toBe('already_open');
      expect(deps.announceReopened).not.toHaveBeenCalled();
    });

    it.each([
      ['a refusal', 'refused' as const],
      ['a thread the workspace does not hold', 'not_a_member' as const],
    ])('stays silent for %s', async (_label, outcome) => {
      deps.readmitConversation.mockResolvedValue(outcome);

      await reopenConversationInSessionWith(deps, input);
      expect(deps.announceReopened).not.toHaveBeenCalled();
    });

    it('stays silent for a history-deleted thread, which never reaches the write', async () => {
      deps.findConversation.mockResolvedValue({ userId: OWNER, isActive: false });

      expect(await reopenConversationInSessionWith(deps, input)).toBe('history_deleted');
      expect(deps.announceReopened).not.toHaveBeenCalled();
    });
  });
});

describe('the workspace is waiting for the backfill', () => {
  /**
   * Same guarantee as the claim path, and for the same reason: an unrecoverable
   * refusal must not arrive as `not_in_session`, which is the answer this module
   * gives for "there is no such thread here" and invites no action at all.
   */
  it('keeps its name instead of becoming not_in_session', async () => {
    const deps = makeDeps({ readmitConversation: vi.fn(async () => 'awaiting_backfill' as const) });
    expect(await reopenConversationInSessionWith(deps, input)).toBe('awaiting_backfill');
  });

  it('is NOT confused with the generic refusal beside it', async () => {
    const deps = makeDeps({ readmitConversation: vi.fn(async () => 'refused' as const) });
    expect(await reopenConversationInSessionWith(deps, input)).toBe('not_in_session');
  });
});
