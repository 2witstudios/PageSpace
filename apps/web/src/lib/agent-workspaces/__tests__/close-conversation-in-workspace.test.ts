/**
 * CLOSING A THREAD OUT OF ITS WORKSPACE — the route's decision, and now ONLY the
 * route's decision.
 *
 * Three things this suite holds down:
 *
 *  - **There is no never-empty guard, and there is no `countOpenConversations`
 *    dep to mock.** `last_conversation` refused the close of a workspace's last
 *    open listing because that emptied the workspace. Emptying it is an
 *    ordinary resting state, so the guard has nothing to guard — its ABSENCE
 *    from these deps is the assertion.
 *  - **There is no `announceClosed` dep either, and that absence is the second
 *    assertion.** The directory `conversation:closed` moved into the write
 *    funnel (`commitUnderLock`), because THIS function is only one of four
 *    producers that remove a chat node — the pane drop, the sidebar's row drop
 *    and an agent tool's close never came through here, so an announcement
 *    owned by this branch fired for a quarter of the closes. Its coverage lives
 *    in `workspace-node-runtime.test.ts` now, on the funnel that every producer
 *    passes through; the other side of the seam is still
 *    `session-directory-listener.test.ts`.
 *  - **The ownership gate is unchanged and still first.** Workspace access is
 *    drive-membership-wide; it is not ownership of a thread, and only this line
 *    stands between a member's private thread and anyone who can reach the
 *    workspace.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  closeConversationInSessionWith,
  dismissOutcomeOf,
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

  /**
   * INVERTED, and the inversion is the fix.
   *
   * `already_closed` used to be answered from `isActive` alone, BEFORE the
   * membership write — and the route answers 200 `{ok: true}` for it. That is
   * only sound if a dead thread never has a node, and a FAILED expel leaves
   * exactly that: `expelConversationFromSession` logs and returns `refused`, the
   * soft-delete proceeds regardless, and the node survives bound to a dead
   * thread. Every later close then reported success having written nothing, so
   * the pane was unclosable and said so silently.
   */
  it('still ATTEMPTS the removal for a history-deleted thread, so a stranded node is repaired', async () => {
    deps.findConversation.mockResolvedValue({ userId: OWNER, isActive: false });

    expect(await closeConversationInSessionWith(deps, input)).toBe('closed');
    expect(deps.dismissConversation).toHaveBeenCalledWith({ conversationId: 'conv-1', workspaceId: 'ws-1' });
  });

  it('answers already_closed for a history-deleted thread once the write confirms there is no node', async () => {
    // The ordinary dead-thread case, reached THROUGH the write rather than
    // ahead of it: no listing, no node, nothing to do. It discloses nothing a
    // guesser could use — the ownership gate above has already passed.
    deps.findConversation.mockResolvedValue({ userId: OWNER, isActive: false });
    deps.dismissConversation.mockResolvedValue('not_a_member');

    expect(await closeConversationInSessionWith(deps, input)).toBe('already_closed');
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
   * THE DIRECTORY ANNOUNCEMENT IS NOT THIS FUNCTION'S ANY MORE.
   *
   * When closing stopped being a `conversations` column write, its
   * `conversation:closed` emit was deleted on a comment's claim that the
   * membership write's `workspace:nodes-updated` covered it. It does not — that
   * event carries the TREE, and the sidebar's conversation rows are keyed by
   * the LISTING, in an SWR cache no tree event touches — so an `announceClosed`
   * dep was added HERE to put it back.
   *
   * That put it in the wrong place. Membership is the node, so a chat node
   * leaving the tree is the thread leaving the workspace however it left; this
   * route is one producer of that out of four, and in practice the least likely
   * to win — the pane's own drop normally committed first, leaving this branch
   * un-taken. The emit lives in the write funnel now, and these two assertions
   * are what is left of the dep here: that there ISN'T one.
   */
  describe('the directory announcement', () => {
    it('is not a dep of this decision — nothing here can emit', () => {
      expect(deps).not.toHaveProperty('announceClosed');
    });

    it('is not owed on a repeat close either — this function answers, and announces nothing', async () => {
      // Every outcome, and none of them reaches an emitter, because there is
      // none to reach. `workspace-node-runtime.test.ts` owns the positive case.
      for (const outcome of ['dismissed', 'not_a_member', 'refused'] as const) {
        deps = makeDeps({ dismissConversation: vi.fn(async () => outcome) });
        await closeConversationInSessionWith(deps, input);
        expect(Object.keys(deps)).toEqual(['findConversation', 'dismissConversation']);
      }
    });
  });
});

/**
 * READING THE MEMBERSHIP WRITE'S ANSWER.
 *
 * Extracted from the production wiring, where it was an inline narrowing that
 * removed `refused` and `stale` and let everything else mean "dismissed" — so
 * `conflict`, which is a ROLLED-BACK write, reported a successful close.
 */
describe('dismissOutcomeOf', () => {
  it('reads `ok` as the dismissal', () => {
    expect(dismissOutcomeOf({ status: 'ok' })).toBe('dismissed');
  });

  it('reads `conflict` as a REFUSAL, not a dismissal', () => {
    // THE FIX. A conflict is raised from inside the write's transaction and
    // unwinds it, so nothing was removed — answering `dismissed` made the route
    // reply 200 "closed" and write a `data.write` audit event for a close that
    // never happened.
    expect(dismissOutcomeOf({ status: 'conflict', code: 'target_already_shown' })).toBe('refused');
  });

  it('reads `stale` as a refusal', () => {
    expect(dismissOutcomeOf({ status: 'stale' })).toBe('refused');
  });

  it('keeps `not_a_member` distinct — it is the only refusal a caller can act on', () => {
    expect(dismissOutcomeOf({ status: 'refused', code: 'not_a_member' })).toBe('not_a_member');
  });

  it('collapses every other refusal code', () => {
    for (const code of ['forbidden_target', 'target_deleted', 'session_full']) {
      expect(dismissOutcomeOf({ status: 'refused', code })).toBe('refused');
    }
  });
});
