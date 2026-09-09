/**
 * The global half of the one-node-per-conversation rule.
 *
 * `validateTree` settles this rule WITHIN a workspace and cannot settle it
 * across workspaces — its input is one workspace's node list, and the index
 * `UNIQUE (targetId) WHERE targetKind = 'chat'` is keyed on `targetId` alone.
 * What is pinned here is the part that closes the gap: which of the targets a
 * write wants are held somewhere else, and whether an error coming back out of
 * the driver is THIS index refusing or some other one.
 */
import { describe, it, expect } from 'vitest';
import {
  CHAT_TARGET_UNIQUE_INDEX,
  chatHeldElsewhereDetail,
  chatIndexRefusalDetail,
  conflictingChatTargets,
  isChatTargetUniqueViolation,
  type ChatTargetHolder,
} from '../workspace-node-chat-binding';

const WORKSPACE = 'ws-b';

function holder(rootId: string, nodeId: string, targetId: string): ChatTargetHolder {
  return { rootId, nodeId, targetId };
}

describe('conflictingChatTargets', () => {
  it('reports a conversation held by a node in ANOTHER workspace', () => {
    expect(
      conflictingChatTargets({
        workspaceId: WORKSPACE,
        wanted: ['conv-1'],
        holders: [holder('ws-a', 'n1', 'conv-1')],
      }),
    ).toEqual(['conv-1']);
  });

  it('reports nothing when the table holds no row for the target at all', () => {
    expect(
      conflictingChatTargets({ workspaceId: WORKSPACE, wanted: ['conv-1'], holders: [] }),
    ).toEqual([]);
  });

  it('does NOT report a holder in the SAME workspace — that fault is the validator\'s, with its own code', () => {
    // `duplicate_chat_target` already covers it, and the store's
    // delete-before-upsert is what lets a conversation MOVE between two nodes
    // of one workspace. One fault, one code.
    expect(
      conflictingChatTargets({
        workspaceId: WORKSPACE,
        wanted: ['conv-1'],
        holders: [holder(WORKSPACE, 'n1', 'conv-1')],
      }),
    ).toEqual([]);
  });

  it('reports every conflicting target, in the order the write wanted them, without repeats', () => {
    expect(
      conflictingChatTargets({
        workspaceId: WORKSPACE,
        wanted: ['conv-1', 'conv-2', 'conv-3'],
        holders: [
          holder('ws-c', 'n9', 'conv-3'),
          holder('ws-a', 'n1', 'conv-1'),
          // The same conversation on two foreign nodes cannot happen while the
          // index holds, but the answer must not double up if it ever does.
          holder('ws-d', 'n4', 'conv-1'),
        ],
      }),
    ).toEqual(['conv-1', 'conv-3']);
  });
});

describe('isChatTargetUniqueViolation', () => {
  const violation = (constraint: string) =>
    Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint,
    });

  it('recognises the chat-target index by NAME', () => {
    expect(isChatTargetUniqueViolation(violation(CHAT_TARGET_UNIQUE_INDEX))).toBe(true);
  });

  it('finds it through drizzle\'s cause chain', () => {
    const wrapped = Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('wrapper'), { cause: violation(CHAT_TARGET_UNIQUE_INDEX) }),
    });
    expect(isChatTargetUniqueViolation(wrapped)).toBe(true);
  });

  it('REFUSES to claim the single-root index — a different fault with a different fix', () => {
    // Widening to any 23505 would answer "that conversation is shown elsewhere"
    // to a caller whose workspace grew a second root. That sends a client
    // rebasing against a conversation that has nothing to do with its bug.
    expect(isChatTargetUniqueViolation(violation('agent_workspace_nodes_one_root_idx'))).toBe(false);
  });

  it('refuses a unique violation carrying no constraint name at all', () => {
    expect(isChatTargetUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(false);
  });

  it('refuses the right constraint name under the WRONG sqlstate', () => {
    expect(
      isChatTargetUniqueViolation(
        Object.assign(new Error('nope'), { code: '23503', constraint: CHAT_TARGET_UNIQUE_INDEX }),
      ),
    ).toBe(false);
  });

  it('is total over the things a catch block actually receives', () => {
    expect(isChatTargetUniqueViolation(null)).toBe(false);
    expect(isChatTargetUniqueViolation(undefined)).toBe(false);
    expect(isChatTargetUniqueViolation('boom')).toBe(false);
    expect(isChatTargetUniqueViolation(new Error('boom'))).toBe(false);
  });

  it('does not match on the driver message text', () => {
    // The message is prose Postgres may reword between releases; the constraint
    // name is the identifier the migration created. Only the second is checked.
    expect(
      isChatTargetUniqueViolation(
        Object.assign(new Error(`duplicate key value violates unique constraint "${CHAT_TARGET_UNIQUE_INDEX}"`), {
          code: '23505',
        }),
      ),
    ).toBe(false);
  });
});

describe('the wording a caller shows and an operator reads', () => {
  it('names the conversation and never the workspace holding it', () => {
    const detail = chatHeldElsewhereDetail(['conv-1']);
    expect(detail).toContain('conv-1');
    expect(detail).toContain('already shown in another workspace');
    // The caller supplied the conversation id; the OTHER session's id is a fact
    // about a workspace they may have no business knowing exists.
    expect(detail).not.toContain('ws-a');
  });

  it('agrees with itself in number', () => {
    expect(chatHeldElsewhereDetail(['a', 'b'])).toContain('conversations "a" and "b" are already shown');
    expect(chatHeldElsewhereDetail(['a'])).toContain('conversation "a" is already shown');
  });

  it('the backstop claims only what it knows — the fact, never a cause it did not observe', () => {
    const detail = chatIndexRefusalDetail(['conv-1']);
    expect(detail).toContain('conv-1');
    expect(detail).toContain('cannot be shown by two nodes at once');
    expect(detail).not.toContain('another workspace');
  });

  it('the backstop still says something true when it has no id to name', () => {
    // A payload that hands a conversation the workspace ALREADY holds to a
    // second node introduces no new binding, so nothing was collected.
    expect(chatIndexRefusalDetail([])).toBe(
      'the database refused this write: a conversation cannot be shown by two nodes at once',
    );
  });
});
