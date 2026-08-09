/**
 * CLOSING IS A `move`, SO CLOSING KEEPS MEMBERSHIP.
 *
 * Two things this suite holds down that the previous shape could not even
 * state:
 *
 *  - **There is no never-empty guard, and there is no `countOpenConversations`
 *    dep to mock.** `last_conversation` refused the close of a workspace's last
 *    open listing because that emptied the workspace. A `move` cannot empty
 *    anything, so the guard has nothing to guard — its ABSENCE from these deps
 *    is the assertion.
 *  - **The ownership gate is unchanged and still first.** Workspace access is
 *    drive-membership-wide; it is not ownership of a thread, and only this line
 *    stands between a member's private thread and anyone who can reach the
 *    workspace.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  closeConversationInSessionWith,
  type CloseConversationInSessionDeps,
} from '../close-conversation-in-workspace';

interface MockDeps extends CloseConversationInSessionDeps {
  findConversation: ReturnType<typeof vi.fn>;
  dismissConversation: ReturnType<typeof vi.fn>;
}

const OWNER = 'user-1';
const input = { conversationId: 'conv-1', userId: OWNER, workspaceId: 'ws-1' };

function makeDeps(overrides: Partial<Record<keyof MockDeps, unknown>> = {}): MockDeps {
  return {
    findConversation: vi.fn(async () => ({ userId: OWNER, isActive: true })),
    dismissConversation: vi.fn(async () => 'dismissed' as const),
    ...overrides,
  } as MockDeps;
}

describe('closeConversationInSessionWith', () => {
  let deps: MockDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('moves the thread off the grid', async () => {
    expect(await closeConversationInSessionWith(deps, input)).toBe('closed');
    expect(deps.dismissConversation).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      workspaceId: 'ws-1',
    });
  });

  it('closes the workspace\'s LAST thread without refusing', async () => {
    // The behaviour change this leaf makes, pinned deliberately. There is no
    // count to stub because there is no guard: the thread stays a member, so
    // the workspace it leaves is still not empty. A test that had to arrange
    // "only one open listing" to reach a 409 has nothing left to arrange.
    expect(await closeConversationInSessionWith(deps, input)).toBe('closed');
  });

  it('refuses a conversation this user does not own, as "not there"', async () => {
    deps.findConversation.mockResolvedValue({ userId: 'user-2', isActive: true });

    expect(await closeConversationInSessionWith(deps, input)).toBe('not_in_session');
    expect(deps.dismissConversation).not.toHaveBeenCalled();
  });

  it('refuses a conversation that does not exist, with the same shape', async () => {
    deps.findConversation.mockResolvedValue(null);

    expect(await closeConversationInSessionWith(deps, input)).toBe('not_in_session');
    expect(deps.dismissConversation).not.toHaveBeenCalled();
  });

  it('treats a history-deleted thread as already closed, and writes nothing', async () => {
    deps.findConversation.mockResolvedValue({ userId: OWNER, isActive: false });

    expect(await closeConversationInSessionWith(deps, input)).toBe('already_closed');
    expect(deps.dismissConversation).not.toHaveBeenCalled();
  });

  it('reports a thread this workspace does not hold as "not there" — which a RE-SENT close also is', async () => {
    // There was an `already_parked` answer here, mapped to `already_closed`:
    // the first close parked the node, so a second one found it exactly where
    // it had asked for. Closing DESTROYS the node, so the second close finds no
    // member at all — the same answer a thread that was never here gets, which
    // is deliberate: a caller cannot act on the difference and an id-guessing
    // one must not learn it.
    deps.dismissConversation.mockResolvedValue('not_a_member');
    expect(await closeConversationInSessionWith(deps, input)).toBe('not_in_session');
  });

  it('collapses a tree refusal into the same answer, so nothing is an oracle', async () => {
    deps.dismissConversation.mockResolvedValue('refused');
    expect(await closeConversationInSessionWith(deps, input)).toBe('not_in_session');
  });
});
