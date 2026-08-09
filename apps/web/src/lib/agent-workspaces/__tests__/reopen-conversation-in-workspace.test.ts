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
}

const OWNER = 'user-1';
const input = { conversationId: 'conv-1', userId: OWNER, workspaceId: 'ws-1' };

function makeDeps(overrides: Partial<Record<keyof MockDeps, unknown>> = {}): MockDeps {
  return {
    findConversation: vi.fn(async () => ({ userId: OWNER, isActive: true })),
    readmitConversation: vi.fn(async () => 'readmitted' as const),
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
});
