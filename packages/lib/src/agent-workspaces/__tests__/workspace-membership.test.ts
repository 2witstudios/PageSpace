/**
 * MEMBERSHIP IS THE NODE ROW — the property this whole leaf exists to
 * establish, held down here against the tree rather than against a database.
 *
 * Four things this suite refuses to let drift:
 *
 *  - **Admitting is one write.** A workspace with no tree at all gets its root
 *    and its first thread in the SAME write, because two writes is exactly the
 *    "created but not placed" state the epic is deleting.
 *  - **Every member is PLACED.** There is no `attach` flag and no parked
 *    admission: a thread that is in a workspace is in its tree, so "member" and
 *    "on screen" are one fact rather than two that have to agree.
 *  - **The cap is a property of the tree.** It counts nodes, so it cannot
 *    disagree with what the workspace holds, and it never refuses a thread the
 *    workspace already holds.
 *  - **Nothing is repaired.** Every refusal carries no write at all.
 *
 * `dismiss` and `readmit` are gone from this file with the state they described.
 * They were a `move` out of the grid and a `move` back, and both needed a place
 * for a member to be that was not the tree. Removing a thread from a workspace
 * is {@link expel}, which is the one removal addressed by target.
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
  expel,
  memberNode,
  type MembershipResult,
} from '../workspace-membership';
import { seedRoot } from '../workspace-node-commands';
import { paneRects } from '../workspace-node-packing';
import { applyNodeWrite } from '../workspace-node-algebra';
import { validateTree } from '../workspace-node-validate';
import {
  childrenOf,
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

function chatPane(id: string, parentId: string, position: number, conversationId: string): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: { kind: 'chat', id: conversationId } };
}

function unbound(id: string, parentId: string, position: number): PaneNode {
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

/**
 * A workspace already holding the cap, every thread on the grid.
 *
 * It used to build them PARKED, which is how the old suite showed that the cap
 * counted membership rather than visibility. There is one place to be now, so
 * the distinction has nothing left to demonstrate — and a parked fixture would
 * not validate.
 */
function atCapacity(count = MAX_SESSION_CONVERSATIONS): WorkspaceNode[] {
  const nodes: WorkspaceNode[] = [root()];
  for (let index = 0; index < count; index += 1) {
    nodes.push(chatPane(`p${index}`, 'root-1', index, `conv-${index}`));
  }
  return nodes;
}

const ids = { newNodeId: 'node-new', newSplitId: 'split-new' };

/** How many containers stand between the root and the furthest pane. */
function deepestPane(nodes: readonly WorkspaceNode[]): number {
  const depthOf = (id: string): number => {
    const node = nodes.find((candidate) => candidate.id === id);
    if (node === undefined || node.parentId === null) return 0;
    return 1 + depthOf(node.parentId);
  };
  return Math.max(...nodes.filter((node) => node.nodeType === 'pane').map((node) => depthOf(node.id)));
}

// ---------------------------------------------------------------------------
// admit
// ---------------------------------------------------------------------------

describe('admit — the membership chokepoint', () => {
  it('brings a workspace with NO TREE AT ALL into being in one write — seeded, then admitted', () => {
    // A freshly spawned workspace has zero rows. If the root were a separate
    // write, the window between the two would be a workspace that exists
    // holding nothing — the epic's headline production symptom. That is still
    // exactly one write; what moved is WHO CHOOSES THE ROOT'S ID.
    //
    // `admit` used to take a caller-supplied `newRootId` and mint the root
    // itself. Both production callers passed `createId()`, so two first
    // admissions racing each other proposed two different roots and the
    // single-root index arbitrated. `seedRoot` derives the id from the
    // workspace instead, so racing seeds propose the SAME root and converge on
    // the upsert — and `commitUnderLock` runs it before the producer, putting
    // the seed at the head of the same `put`. One write, one root, no race.
    const workspaceId = 'ws-fresh';
    const { nodes: seated, seed } = seedRoot([], workspaceId);
    expect(seed).not.toBeNull();

    const result = admit(seated, { ...ids, target: { kind: 'chat', id: 'conv-1' } });
    const next = applied(seated, result);

    expect(rootOf(next)?.id).toBe(seed?.id);
    expect(chatMembers(next)).toEqual(['conv-1']);
    expect(memberNode(next, { kind: 'chat', id: 'conv-1' })?.parentId).toBe(seed?.id);
  });

  it('two clients seeding the same fresh workspace propose the IDENTICAL root', () => {
    // The property the derivation buys, stated directly: this is what a caller
    // -chosen `createId()` could not give, and the reason `admit` no longer
    // takes one. Converges on the upsert instead of colliding on the index.
    expect(seedRoot([], 'ws-fresh').seed?.id).toBe(seedRoot([], 'ws-fresh').seed?.id);
    expect(seedRoot([], 'ws-a').seed?.id).not.toBe(seedRoot([], 'ws-b').seed?.id);
  });

  it('fills the pane the caller POINTED AT, not merely the first one that qualifies', () => {
    // Two empty panes. Without a preference the policy takes `panes.find(...)`
    // — the first in grid order — so a human who picked the SECOND pane would
    // watch their agent appear in the first and their own pane stay empty.
    const before = [root(), unbound('p1', 'root-1', 0), unbound('p2', 'root-1', 1)];

    const next = applied(
      before,
      admit(before, { ...ids, target: { kind: 'chat', id: 'conv-a' }, activeNodeId: 'p2' }),
    );

    expect(memberNode(next, { kind: 'chat', id: 'conv-a' })?.id).toBe('p2');
    // And the pane nobody pointed at is left alone.
    expect(next.find((node) => node.id === 'p1')).toMatchObject({ target: null });
  });

  it('ignores a preference naming a pane it may not take, rather than refusing the admission', () => {
    // `preferSplit` means only an UNBOUND pane may be filled. A preference
    // pointing at a bound one is not an error — it just does not qualify, and
    // the policy carries on to a pane that does.
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-existing'), unbound('p2', 'root-1', 1)];

    const next = applied(
      before,
      admit(before, { ...ids, target: { kind: 'chat', id: 'conv-a' }, activeNodeId: 'p1' }),
    );

    expect(memberNode(next, { kind: 'chat', id: 'conv-a' })?.id).toBe('p2');
    expect(memberNode(next, { kind: 'chat', id: 'conv-existing' })?.id).toBe('p1');
  });

  it('PLACES every admission — there is no parked half-membership to choose', () => {
    // The `attach` flag is gone. It chose between a placed node and a parked
    // one, which was a choice between membership and a membership nothing could
    // render; the parked answer was the state that made a closed pane and a
    // broken one indistinguishable.
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a')];
    const next = applied(before, admit(before, { ...ids, target: { kind: 'chat', id: 'conv-b' } }));

    expect(chatMembers(next).sort()).toEqual(['conv-a', 'conv-b']);
    for (const node of next) {
      if (node.nodeType !== 'root') expect(node.parentId).not.toBeNull();
    }
  });

  it('fills an UNBOUND pane rather than minting a second one beside it', () => {
    // This is also what makes the picker path land where the user is looking:
    // the client's waiting pane is the unbound one, so the admission fills it
    // rather than putting the thread somewhere else on the grid.
    const before = [root(), unbound('p1', 'root-1', 0)];
    const next = applied(before, admit(before, { ...ids, target: { kind: 'chat', id: 'conv-b' } }));

    expect(memberNode(next, { kind: 'chat', id: 'conv-b' })?.id).toBe('p1');
    expect(next).toHaveLength(2);
  });

  it('SPLITS rather than evicting a bound pane', () => {
    // `preferSplit` — an admitting caller adds a surface beside what the user is
    // doing, it never navigates their panes.
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a')];
    const next = applied(before, admit(before, { ...ids, target: { kind: 'chat', id: 'conv-b' } }));

    expect(chatMembers(next).sort()).toEqual(['conv-a', 'conv-b']);
    expect(memberNode(next, { kind: 'chat', id: 'conv-a' })).toBeDefined();
    expect(memberNode(next, { kind: 'chat', id: 'conv-b' })).toBeDefined();
  });

  it('places a TERMINAL by the same policy, rather than refusing to place it', () => {
    // `admit` used to answer `invalid_target` for any kind but chat, because
    // every other kind arrived parked and was placed by whoever opened it.
    // Nothing arrives parked, so every kind needs a place — and the placement
    // policy already served all three.
    const before = [root(), unbound('p1', 'root-1', 0)];
    const next = applied(before, admit(before, { ...ids, target: { kind: 'terminal', id: 'shell-1' } }));

    expect(memberNode(next, { kind: 'terminal', id: 'shell-1' })?.id).toBe('p1');
  });

  it('PACKS a session\u2019s shells into a grid instead of a row of ever-thinner columns', () => {
    // Issue #2469, end to end on the path production takes: `spawnShell` calls
    // `admit` with a target and a pair of ids and nothing else \u2014 no axis, no
    // active pane \u2014 five times, which is what one working session did.
    //
    // What that used to build: five nested `row` containers, each halving the
    // pane the invoking conversation sat in, four levels deep and unusable by
    // the third. What it builds now is asserted below.
    let nodes: WorkspaceNode[] = [root(), chatPane('p1', 'root-1', 0, 'conv-invoker')];
    for (let index = 0; index < 5; index += 1) {
      nodes = applied(
        nodes,
        admit(nodes, {
          newNodeId: `pane-${index}`,
          newSplitId: `split-${index}`,
          target: { kind: 'terminal', id: `shell-${index}` },
          excludeTargetId: 'conv-invoker',
        }),
      );
    }

    // Every shell is on screen, and so is the conversation that spawned them.
    for (let index = 0; index < 5; index += 1) {
      expect(memberNode(nodes, { kind: 'terminal', id: `shell-${index}` })).toBeDefined();
    }
    expect(memberNode(nodes, { kind: 'chat', id: 'conv-invoker' })).toBeDefined();

    // No pane is a sliver: six panes in a balanced grid, so the smallest is a
    // sixth of the workspace rather than the 1/32 five halvings of one pane
    // would leave.
    const rects = paneRects(nodes);
    const smallest = Math.min(...[...rects.values()].map((rect) => rect.width * rect.height));
    expect(smallest).toBeGreaterThan(1 / 12);

    // And the tree stayed shallow: depth grows with the LOGARITHM of the pane
    // count under this rule, nowhere near `MAX_DEPTH`.
    expect(deepestPane(nodes)).toBeLessThanOrEqual(3);
  });

  it('places a PAGE by the same policy too', () => {
    const before = [root(), unbound('p1', 'root-1', 0)];
    const next = applied(before, admit(before, { ...ids, target: { kind: 'page', id: 'page-1' } }));

    expect(memberNode(next, { kind: 'page', id: 'page-1' })?.id).toBe('p1');
  });

  it('never evicts the conversation that asked for the spawn', () => {
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-spawner')];
    const next = applied(
      before,
      admit(before, {
        ...ids,
        target: { kind: 'chat', id: 'conv-worker' },
        excludeTargetId: 'conv-spawner',
      }),
    );

    expect(memberNode(next, { kind: 'chat', id: 'conv-spawner' })).toBeDefined();
  });

  it('is IDEMPOTENT ON THE TARGET — a thread the workspace already holds writes nothing', () => {
    // This is what replaces the `(workspaceId, opId)` memory the verb path
    // needed: a retried spawn re-asks for a member the workspace already has,
    // and the answer is an empty write because the POLICY says so.
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a')];
    const result = admit(before, { ...ids, target: { kind: 'chat', id: 'conv-a' } });

    expect(result).toEqual({ ok: true, write: { put: [], drop: [] } });
  });

  it('writes nothing for a member held DEEP in the tree, rather than minting a second node', () => {
    // Two nodes for one conversation is precisely what the table's global
    // `UNIQUE (targetId) WHERE targetKind='chat'` refuses; answering "already a
    // member" here is what keeps a retry from meeting that index. Membership is
    // presence in the tree, not presence in the root's own children.
    const before = [
      root(),
      container('s1', 'root-1', 0),
      chatPane('p1', 's1', 0, 'conv-a'),
      chatPane('p2', 's1', 1, 'conv-b'),
    ];
    const result = admit(before, { ...ids, target: { kind: 'chat', id: 'conv-a' } });

    expect(result).toEqual({ ok: true, write: { put: [], drop: [] } });
  });

  it('refuses a NEWCOMER once the workspace holds the cap, and writes nothing', () => {
    const result = admit(atCapacity(), { ...ids, target: { kind: 'chat', id: 'conv-new' } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('session_full');
  });

  it('does NOT refuse an existing member at the cap — a retry consumed no slot', () => {
    const result = admit(atCapacity(), { ...ids, target: { kind: 'chat', id: 'conv-0' } });

    expect(result).toEqual({ ok: true, write: { put: [], drop: [] } });
  });

  it('keeps the CAP, which bounds a workspace from above and has nothing to do with emptiness', () => {
    // `last_member` went with the never-empty invariant; `session_full` did not,
    // and the difference is the direction. A ceiling on what a workspace holds
    // is untouched by emptiness ceasing to mean anything.
    const before = atCapacity(MAX_SESSION_CONVERSATIONS - 1);
    expect(chatMembers(before)).toHaveLength(MAX_SESSION_CONVERSATIONS - 1);

    // One slot left: this lands.
    const next = applied(before, admit(before, { ...ids, target: { kind: 'chat', id: 'conv-x' } }));
    // None left: the next one does not.
    const refused = admit(next, {
      ...ids,
      newNodeId: 'node-newer',
      newSplitId: 'split-newer',
      target: { kind: 'chat', id: 'conv-y' },
    });
    expect(refused.ok).toBe(false);
  });

  it('does not bound TERMINALS or PAGES by the conversation cap', () => {
    const before = atCapacity();
    const next = applied(before, admit(before, { ...ids, target: { kind: 'terminal', id: 'shell-1' } }));
    expect(memberNode(next, { kind: 'terminal', id: 'shell-1' })).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// expel
// ---------------------------------------------------------------------------

describe('expel — the one removal, addressed by target', () => {
  it('removes the node, so the thread stops being a member', () => {
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a'), chatPane('p2', 'root-1', 1, 'conv-b')];
    const next = applied(before, expel(before, { target: { kind: 'chat', id: 'conv-a' } }));

    expect(chatMembers(next)).toEqual(['conv-b']);
    expect(memberNode(next, { kind: 'chat', id: 'conv-a' })).toBeUndefined();
  });

  it('frees the cap slot the thread was holding', () => {
    const before = atCapacity();
    expect(admit(before, { ...ids, target: { kind: 'chat', id: 'conv-new' } }).ok).toBe(false);

    const next = applied(before, expel(before, { target: { kind: 'chat', id: 'conv-0' } }));
    expect(admit(next, { ...ids, target: { kind: 'chat', id: 'conv-new' } }).ok).toBe(true);
  });

  it("takes the workspace's LAST conversation, because emptiness no longer means anything", () => {
    // `requireSurvivor` / `last_member` are gone. They enforced "a workspace is
    // never empty", an invariant that only had teeth while a two-level grid
    // could not represent zero panes and while "the last one closed" was the
    // inference that ended a session. Neither holds: an empty tree is an
    // ordinary state, and a session ends when someone destroys its root.
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a')];
    const next = applied(before, expel(before, { target: { kind: 'chat', id: 'conv-a' } }));

    expect(chatMembers(next)).toEqual([]);
    expect(rootOf(next)).toBeDefined();
    expect(childrenOf(next, 'root-1')).toHaveLength(0);
  });

  it('collapses a split its departure left holding one child', () => {
    const before = [
      root(),
      container('s1', 'root-1', 0),
      chatPane('p1', 's1', 0, 'conv-a'),
      chatPane('p2', 's1', 1, 'conv-b'),
    ];
    const next = applied(before, expel(before, { target: { kind: 'chat', id: 'conv-a' } }));

    expect(next.find((node) => node.id === 's1')).toBeUndefined();
    expect(memberNode(next, { kind: 'chat', id: 'conv-b' })?.parentId).toBe('root-1');
  });

  it('refuses a thread this workspace does not hold, and writes nothing', () => {
    // The caller acting for a user is owed the truth. The caller running behind
    // an already-authorized history-delete treats this code as the state it
    // wanted, and says so at its own call site — which is why there is one
    // function here rather than two that differ only in this answer.
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a')];
    const result = expel(before, { target: { kind: 'chat', id: 'conv-elsewhere' } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_a_member');
  });

  it('refuses a target of the right id but the wrong kind', () => {
    // A page id and a conversation id may coincide without either being the
    // other, so membership is asked by kind AND id.
    const before = [root(), chatPane('p1', 'root-1', 0, 'conv-a')];
    const result = expel(before, { target: { kind: 'page', id: 'conv-a' } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_a_member');
  });
});
