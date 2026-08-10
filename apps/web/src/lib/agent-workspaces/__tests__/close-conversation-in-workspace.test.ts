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
  announceClosed: ReturnType<typeof vi.fn>;
}

const OWNER = 'user-1';
const input = { conversationId: 'conv-1', userId: OWNER, workspaceId: 'ws-1' };

function makeDeps(overrides: Partial<Record<keyof MockDeps, unknown>> = {}): MockDeps {
  return {
    findConversation: vi.fn(async () => ({ userId: OWNER, isActive: true })),
    dismissConversation: vi.fn(async () => 'dismissed' as const),
    announceClosed: vi.fn(),
    ...overrides,
  } as MockDeps;
}

describe('closeConversationInSessionWith', () => {
  let deps: MockDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('removes the thread from the workspace', async () => {
    expect(await closeConversationInSessionWith(deps, input)).toBe('closed');
    expect(deps.dismissConversation).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      workspaceId: 'ws-1',
    });
  });

  it('closes the workspace\'s LAST thread without refusing', async () => {
    // The behaviour change this leaf makes, pinned deliberately. There is no
    // count to stub because there is no guard: the thread DOES leave, and a
    // workspace holding nothing is an ordinary resting state — a root with no
    // children, which `validateTree` accepts. A test that had to arrange "only
    // one open listing" to reach a 409 has nothing left to arrange.
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

  /**
   * THE DIRECTORY ANNOUNCEMENT — the half that broke, and the half no unit test
   * spanned.
   *
   * When closing stopped being a `conversations` column write, the repository
   * writers that stamped it were deleted and their `conversation:closed` emit
   * went with them, on a comment's claim that the membership write's
   * `workspace:nodes-updated` broadcast now covered it. It does not: that event
   * carries the TREE, and the sidebar's conversation rows are keyed by the
   * LISTING, in an SWR cache no tree event touches. Nothing emitted
   * `conversation:closed` at all, so a server-side close left the row on screen
   * until the 120s backstop poll.
   *
   * Only `apps/e2e/tests/18-sidebar-directory-live.spec.ts` caught it, because
   * the seam ran between a server module and a browser listener and no unit
   * test crossed it. These do — from this side, "a close says so"; from the
   * other, `session-directory-listener.test.ts`'s "and the listener answers it
   * without a request".
   */
  describe('the directory announcement', () => {
    it('announces a close that actually happened, with the row it gated on', async () => {
      const row = { userId: OWNER, isActive: true, id: 'conv-1', rev: 7 };
      deps.findConversation.mockResolvedValue(row);

      expect(await closeConversationInSessionWith(deps, input)).toBe('closed');

      expect(deps.announceClosed).toHaveBeenCalledTimes(1);
      // The SAME row the ownership gate read — the close writes no
      // `conversations` column, so this read is the only place the emit context
      // comes from and re-reading it would be a second query.
      expect(deps.announceClosed).toHaveBeenCalledWith(row);
    });

    it('announces AFTER the membership write, never before it', async () => {
      const order: string[] = [];
      deps.dismissConversation.mockImplementation(async () => {
        order.push('write');
        return 'dismissed' as const;
      });
      deps.announceClosed.mockImplementation(() => order.push('announce'));

      await closeConversationInSessionWith(deps, input);

      // Announcing a close the write then refuses is the failure mode that
      // reads as "the row vanished and came back".
      expect(order).toEqual(['write', 'announce']);
    });

    it.each([
      ['a thread the workspace does not hold', 'not_a_member' as const],
      ['a tree that refused the removal', 'refused' as const],
    ])('stays silent for %s', async (_label, outcome) => {
      deps.dismissConversation.mockResolvedValue(outcome);

      expect(await closeConversationInSessionWith(deps, input)).toBe('not_in_session');
      expect(deps.announceClosed).not.toHaveBeenCalled();
    });

    it.each([
      ['a conversation this user does not own', { userId: 'user-2', isActive: true }],
      ['a history-deleted thread', { userId: OWNER, isActive: false }],
      ['a conversation that does not exist', null],
    ])('stays silent for %s — nothing was written to announce', async (_label, row) => {
      deps.findConversation.mockResolvedValue(row);

      await closeConversationInSessionWith(deps, input);

      expect(deps.announceClosed).not.toHaveBeenCalled();
    });
  });
});
