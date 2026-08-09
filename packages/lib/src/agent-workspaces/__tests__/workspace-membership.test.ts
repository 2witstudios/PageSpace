/**
 * MEMBERSHIP IS THE NODE ROW — the property this whole leaf exists to
 * establish, held down here against the tree rather than against a database.
 *
 * Four things this suite refuses to let drift:
 *
 *  - **Admitting is one write.** A workspace with no tree at all gets its root
 *    and its first thread in the SAME write, because two writes is exactly the
 *    "created but not placed" state the epic is deleting.
 *  - **Dismissing keeps membership.** A closed thread is a node that moved, so
 *    it is still in `chatMembers` and still under the global chat-target
 *    uniqueness that makes its binding write-once.
 *  - **The cap is a property of the tree.** It counts nodes, so it cannot
 *    disagree with what the workspace holds, and it never refuses a thread the
 *    workspace already holds.
 *  - **Nothing is repaired.** Every refusal carries no write at all.
 *
 * Assertions apply the write and re-validate rather than inspecting its shape:
 * the claim is about the tree that results, not about the delta that produced
 * it.
 */
import { describe, it, expect } from 'vitest';
import { MAX_SESSION_CONVERSATIONS } from '../plan-spawn-worker';
import {
  admit,
  chatMembers,
  dismiss,
  expel,
  memberNode,
  readmit,
  type MembershipResult,
} from '../workspace-membership';
import { applyNodeWrite } from '../workspace-node-algebra';
import { validateTree } from '../workspace-node-validate';
import {
  childrenOf,
  detachedOf,
  rootOf,
  type PaneNode,
  type RootNode,
  type SplitNode,
  type WorkspaceNode,
} from '../workspace-node';

function root(): RootNode {
  return { nodeType: 'root', id: 'root-1', parentId: null, position: 0, axis: 'row' };
}

function container(id: string, parentId: string, position: number): SplitNode {
  return { nodeType: 'split', id, parentId, position, axis: 'column' };
}

function chatPane(id: string, parentId: string | null, position: number, conversationId: string): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: { kind: 'chat', id: conversationId } };
}

function unbound(id: string, parentId: string | null, position: number): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: null };
}

/** Apply an accepted write and assert the tree it produced actually stands up. */
function applied(nodes: readonly WorkspaceNode[], result: MembershipResult): WorkspaceNode[] {
  if (!result.ok) throw new Error(`expected an accepted write, got ${result.code}: ${result.detail}`);
  const next = applyNodeWrite(nodes, result.write);
  const validation = validateTree(next);
  expect(validation.ok, validation.ok ? '' : `${validation.code}: ${validation.detail}`).toBe(true);
  return next;
}

const ids = { newNodeId: 'node-new', newSplitId: 'split-new', newRootId: 'root-new' };

// ---------------------------------------------------------------------------
// admit
// ---------------------------------------------------------------------------

describe('admit — the membership chokepoint', () => {
  it('brings a workspace with NO TREE AT ALL into being in one write', () => {
    // A freshly spawned workspace has zero rows. If the root were a separate
    // write, the window between the two would be a workspace that exists
    // holding nothing — the epic's headline production symptom.
    const result = admit([], { ...ids, target: { kind: 'chat', id: 'conv-1' }, attach: true });

    const next = applied([], result);
    expect(rootOf(next)?.id).toBe('root-new');
    expect(chatMembers(next)).toEqual(['conv-1']);
    expect(memberNode(next, { kind: 'chat', id: 'conv-1' })?.parentId).toBe('root-new');
  });

  it('mints the root even when the thread arrives PARKED', () => {
    // `validateTree` calls an empty list `no_root`, so "detached member of a
    // workspace with no tree" has to bring the tree with it or it is not a
    // writable state at all.
    const result = admit([], { ...ids, target: { kind: 'chat', id: 'conv-1' }, attach: false });

    const next = applied([], result);
    expect(rootOf(next)?.id).toBe('root-new');
    expect(detachedOf(next).map((node) => node.target?.id)).toEqual(['conv-1']);
    expect(chatMembers(next)).toEqual(['conv-1']);
  });

  it('attach:false leaves the thread a MEMBER, off the grid', () => {
    // The narrowing `placeInGrid` becomes. The old flag decided whether the
    // thread was in the grid at all, and a thread it said no to was reachable
    // only through a second structure.
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a')];
    const next = applied(before, admit(before, { ...ids, target: { kind: 'chat', id: 'conv-b' }, attach: false }));

    expect(chatMembers(next).sort()).toEqual(['conv-a', 'conv-b']);
    expect(detachedOf(next).map((node) => node.target?.id)).toEqual(['conv-b']);
    expect(childrenOf(next, 'root-1')).toHaveLength(1);
  });

  it('attach:true fills an UNBOUND pane rather than splitting beside it', () => {
    const before = [root(), unbound('p1', 'root-1', 0)];
    const next = applied(before, admit(before, { ...ids, target: { kind: 'chat', id: 'conv-b' }, attach: true }));

    expect(memberNode(next, { kind: 'chat', id: 'conv-b' })?.id).toBe('p1');
    expect(next).toHaveLength(2);
  });

  it('attach:true SPLITS rather than evicting a bound pane', () => {
    // `preferSplit` — an agent adds a surface beside what the user is doing, it
    // never navigates their panes.
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a')];
    const next = applied(before, admit(before, { ...ids, target: { kind: 'chat', id: 'conv-b' }, attach: true }));

    expect(chatMembers(next).sort()).toEqual(['conv-a', 'conv-b']);
    expect(memberNode(next, { kind: 'chat', id: 'conv-a' })?.parentId).not.toBeNull();
    expect(memberNode(next, { kind: 'chat', id: 'conv-b' })?.parentId).not.toBeNull();
  });

  it('never evicts the conversation that asked for the spawn', () => {
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-spawner')];
    const next = applied(
      before,
      admit(before, {
        ...ids,
        target: { kind: 'chat', id: 'conv-worker' },
        attach: true,
        excludeTargetId: 'conv-spawner',
      }),
    );

    expect(memberNode(next, { kind: 'chat', id: 'conv-spawner' })?.parentId).not.toBeNull();
  });

  it('is IDEMPOTENT ON THE TARGET — a thread the workspace already holds writes nothing', () => {
    // This is what replaces the `(workspaceId, opId)` memory the verb path
    // needed: a retried spawn re-asks for a member the workspace already has,
    // and the answer is an empty write because the POLICY says so.
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a')];
    const result = admit(before, { ...ids, target: { kind: 'chat', id: 'conv-a' }, attach: true });

    expect(result).toEqual({ ok: true, write: { put: [], drop: [] } });
  });

  it('writes nothing for a member that is PARKED, rather than minting a second node', () => {
    // Two nodes for one conversation is precisely what the table's global
    // `UNIQUE (targetId) WHERE targetKind='chat'` refuses; answering "already a
    // member" here is what keeps a retry from meeting that index.
    const before = [root(), chatPane('p1', null, 0, 'conv-a')];
    const result = admit(before, { ...ids, target: { kind: 'chat', id: 'conv-a' }, attach: true });

    expect(result).toEqual({ ok: true, write: { put: [], drop: [] } });
  });

  it('refuses a NEWCOMER once the workspace holds the cap, and writes nothing', () => {
    const before: WorkspaceNode[] = [root()];
    for (let index = 0; index < MAX_SESSION_CONVERSATIONS; index += 1) {
      before.push(chatPane(`p${index}`, null, index, `conv-${index}`));
    }

    const result = admit(before, { ...ids, target: { kind: 'chat', id: 'conv-new' }, attach: false });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('session_full');
  });

  it('does NOT refuse an existing member at the cap — a retry consumed no slot', () => {
    const before: WorkspaceNode[] = [root()];
    for (let index = 0; index < MAX_SESSION_CONVERSATIONS; index += 1) {
      before.push(chatPane(`p${index}`, null, index, `conv-${index}`));
    }

    const result = admit(before, { ...ids, target: { kind: 'chat', id: 'conv-0' }, attach: true });

    expect(result).toEqual({ ok: true, write: { put: [], drop: [] } });
  });

  it('counts PARKED threads toward the cap — membership, not visibility, is what is bounded', () => {
    const before: WorkspaceNode[] = [root()];
    for (let index = 0; index < MAX_SESSION_CONVERSATIONS - 1; index += 1) {
      before.push(chatPane(`p${index}`, null, index, `conv-${index}`));
    }
    expect(chatMembers(before)).toHaveLength(MAX_SESSION_CONVERSATIONS - 1);

    // One slot left: this lands.
    const next = applied(before, admit(before, { ...ids, target: { kind: 'chat', id: 'conv-x' }, attach: false }));
    // None left: the next one does not.
    const refused = admit(next, {
      ...ids,
      newNodeId: 'node-newer',
      target: { kind: 'chat', id: 'conv-y' },
      attach: false,
    });
    expect(refused.ok).toBe(false);
  });

  it('does not bound TERMINALS or PAGES by the conversation cap', () => {
    const before: WorkspaceNode[] = [root()];
    for (let index = 0; index < MAX_SESSION_CONVERSATIONS; index += 1) {
      before.push(chatPane(`p${index}`, null, index, `conv-${index}`));
    }

    const next = applied(
      before,
      admit(before, { ...ids, target: { kind: 'terminal', id: 'shell-1' }, attach: false }),
    );
    expect(memberNode(next, { kind: 'terminal', id: 'shell-1' })).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// dismiss
// ---------------------------------------------------------------------------

describe('dismiss — closing changes a location, not a membership', () => {
  it('parks the node and KEEPS the thread a member', () => {
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a'), chatPane('p2', 'root-1', 1, 'conv-b')];
    const next = applied(before, dismiss(before, { target: { kind: 'chat', id: 'conv-a' } }));

    expect(chatMembers(next).sort()).toEqual(['conv-a', 'conv-b']);
    expect(memberNode(next, { kind: 'chat', id: 'conv-a' })?.parentId).toBeNull();
  });

  it('keeps the node ID, so the binding stays the one the workspace already had', () => {
    // The write-once binding is the table's global chat-target index. It only
    // holds if the row survives a close — a destroy frees it, and a freed index
    // is a rebind reachable by clicking "close".
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a'), chatPane('p2', 'root-1', 1, 'conv-b')];
    const next = applied(before, dismiss(before, { target: { kind: 'chat', id: 'conv-a' } }));

    expect(memberNode(next, { kind: 'chat', id: 'conv-a' })?.id).toBe('p1');
  });

  it('closing the LAST thread on screen is allowed and empties only the GRID', () => {
    // No never-empty guard: dismissing moves a node, so it cannot empty a
    // workspace. `last_conversation` was a guard against a structure that is
    // gone.
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a')];
    const next = applied(before, dismiss(before, { target: { kind: 'chat', id: 'conv-a' } }));

    expect(childrenOf(next, 'root-1')).toHaveLength(0);
    expect(chatMembers(next)).toEqual(['conv-a']);
  });

  it('collapses a split left holding one child', () => {
    const before = [
      root(),
      container('s1', 'root-1', 0),
      chatPane('p1', 's1', 0, 'conv-a'),
      chatPane('p2', 's1', 1, 'conv-b'),
    ];
    const next = applied(before, dismiss(before, { target: { kind: 'chat', id: 'conv-a' } }));

    expect(next.find((node) => node.id === 's1')).toBeUndefined();
    expect(memberNode(next, { kind: 'chat', id: 'conv-b' })?.parentId).toBe('root-1');
  });

  it('a re-sent close writes nothing', () => {
    const before = [root(), chatPane('p1', null, 0, 'conv-a')];
    expect(dismiss(before, { target: { kind: 'chat', id: 'conv-a' } })).toEqual({
      ok: true,
      write: { put: [], drop: [] },
    });
  });

  it('refuses a thread this workspace does not hold, and writes nothing', () => {
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a')];
    const result = dismiss(before, { target: { kind: 'chat', id: 'conv-elsewhere' } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_a_member');
  });
});

// ---------------------------------------------------------------------------
// readmit
// ---------------------------------------------------------------------------

describe('readmit — putting a member back on screen', () => {
  it('moves the SAME node back into the grid, minting nothing', () => {
    const before = [root(), chatPane('p1', null, 0, 'conv-a'), chatPane('p2', 'root-1', 0, 'conv-b')];
    const next = applied(before, readmit(before, { target: { kind: 'chat', id: 'conv-a' } }));

    const restored = memberNode(next, { kind: 'chat', id: 'conv-a' });
    expect(restored?.id).toBe('p1');
    expect(restored?.parentId).toBe('root-1');
    expect(next).toHaveLength(3);
  });

  it('is not bounded by the cap — a member returning consumed no new slot', () => {
    const before: WorkspaceNode[] = [root()];
    for (let index = 0; index < MAX_SESSION_CONVERSATIONS; index += 1) {
      before.push(chatPane(`p${index}`, null, index, `conv-${index}`));
    }

    const next = applied(before, readmit(before, { target: { kind: 'chat', id: 'conv-0' } }));
    expect(memberNode(next, { kind: 'chat', id: 'conv-0' })?.parentId).toBe('root-1');
  });

  it('a thread already on screen writes nothing', () => {
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a')];
    expect(readmit(before, { target: { kind: 'chat', id: 'conv-a' } })).toEqual({
      ok: true,
      write: { put: [], drop: [] },
    });
  });

  it('refuses a thread this workspace does not hold', () => {
    const result = readmit([root()], { target: { kind: 'chat', id: 'conv-gone' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_a_member');
  });

  it('refuses rather than MINTING a root for a rootless tree', () => {
    // Repairing here would decide a structure the caller never asked for, which
    // is the one thing every layer of this epic refuses to do.
    const result = readmit([chatPane('p1', null, 0, 'conv-a')], { target: { kind: 'chat', id: 'conv-a' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_root');
  });
});

// ---------------------------------------------------------------------------
// expel
// ---------------------------------------------------------------------------

describe('expel — the one act that is a destroy', () => {
  it('removes the node, so the thread stops being a member', () => {
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a'), chatPane('p2', 'root-1', 1, 'conv-b')];
    const next = applied(before, expel(before, { target: { kind: 'chat', id: 'conv-a' } }));

    expect(chatMembers(next)).toEqual(['conv-b']);
    expect(memberNode(next, { kind: 'chat', id: 'conv-a' })).toBeUndefined();
  });

  it('frees the cap slot a dismissed thread keeps holding', () => {
    const before: WorkspaceNode[] = [root()];
    for (let index = 0; index < MAX_SESSION_CONVERSATIONS; index += 1) {
      before.push(chatPane(`p${index}`, null, index, `conv-${index}`));
    }
    expect(admit(before, { ...ids, target: { kind: 'chat', id: 'conv-new' }, attach: false }).ok).toBe(false);

    const next = applied(before, expel(before, { target: { kind: 'chat', id: 'conv-0' } }));
    expect(admit(next, { ...ids, target: { kind: 'chat', id: 'conv-new' }, attach: false }).ok).toBe(true);
  });

  it("refuses to take the workspace's LAST conversation when a survivor is required", () => {
    // The never-empty guard, and the ONE place it still lives. `dismiss` needs
    // none — a `move` cannot empty a workspace — but a `destroy` can, so the
    // guard belongs to the act that can produce the state it forbids.
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a')];
    const result = expel(before, { target: { kind: 'chat', id: 'conv-a' }, requireSurvivor: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('last_member');
  });

  it('takes the last conversation when no survivor is required', () => {
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a')];
    const next = applied(before, expel(before, { target: { kind: 'chat', id: 'conv-a' } }));
    expect(chatMembers(next)).toEqual([]);
  });

  it('counts PARKED members as survivors — a closed thread still keeps the workspace alive', () => {
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a'), chatPane('p2', null, 0, 'conv-b')];
    const next = applied(
      before,
      expel(before, { target: { kind: 'chat', id: 'conv-a' }, requireSurvivor: true }),
    );
    expect(chatMembers(next)).toEqual(['conv-b']);
  });

  it('does not count a TERMINAL as a surviving conversation', () => {
    const terminal: WorkspaceNode = {
      nodeType: 'pane',
      id: 'p2',
      parentId: null,
      position: 0,
      target: { kind: 'terminal', id: 'shell-1' },
    };
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a'), terminal];
    const result = expel(before, { target: { kind: 'chat', id: 'conv-a' }, requireSurvivor: true });
    expect(result.ok).toBe(false);
  });

  it('writes nothing for a thread that is already gone', () => {
    expect(expel([root()], { target: { kind: 'chat', id: 'conv-gone' } })).toEqual({
      ok: true,
      write: { put: [], drop: [] },
    });
  });
});
