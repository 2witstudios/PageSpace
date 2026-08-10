/**
 * The backfill derivation — the one migration in this epic that runs ONCE, over
 * every real workspace that exists, with no gradual rollout and no second pass.
 *
 * So this suite is not "coverage of a function". It is the enumeration of what
 * the real data can contain, written down before the derivation was, and each
 * entry driven to its decided outcome. A pathological shape that is not in here
 * is a shape nobody decided about, which at this blast radius is the same thing
 * as a shape decided wrongly.
 *
 * Two properties are asserted over EVERY fixture in this file rather than in
 * one test each, because they are the two failures that cannot be walked back:
 *
 *   * `membersIn === paneNodesOut` — every member of a workspace becomes
 *     exactly one pane node. A difference means a thread the user can see today
 *     is invisible tomorrow, or two panes fight over one conversation.
 *   * every emitted row carries the `rootId` of the workspace it came FROM.
 *     A mis-stamp relocates real panes into somebody else's session.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveWorkspaceNodes,
  resolveChatClaims,
  type LegacyMember,
  type LegacyPane,
  type LegacyPaneColumn,
  type WorkspaceBackfillSource,
  type WorkspaceDerivation,
} from '../workspace-node-backfill';
import { rootSeedFor } from '../workspace-node-commands';
import { nodesFromRows } from '../workspace-node-rows';
import { validateTree, MAX_NODES } from '../workspace-node-validate';
import { buildRenderTree } from '../workspace-node-rows';
import type { WorkspaceNode } from '../workspace-node';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EPOCH = new Date('2026-01-01T00:00:00.000Z');

function member(id: string, minute = 0): LegacyMember {
  return { id, createdAt: new Date(EPOCH.getTime() + minute * 60_000) };
}

function column(id: string, orderIndex: number, widthFraction: number | null = null): LegacyPaneColumn {
  return { id, orderIndex, widthFraction };
}

function pane(
  id: string,
  columnId: string,
  orderIndex: number,
  binding: { kind: string | null; targetId: string | null } = { kind: null, targetId: null },
  heightFraction: number | null = null,
): LegacyPane {
  return { id, columnId, orderIndex, kind: binding.kind, targetId: binding.targetId, heightFraction };
}

function chat(targetId: string): { kind: string; targetId: string } {
  return { kind: 'chat', targetId };
}

function terminal(targetId: string): { kind: string; targetId: string } {
  return { kind: 'terminal', targetId };
}

function source(overrides: Partial<WorkspaceBackfillSource> & { workspaceId: string }): WorkspaceBackfillSource {
  return { columns: [], panes: [], conversations: [], shells: [], ...overrides };
}

/** The nodes a derivation produced, read back the way production reads them. */
function nodesOf(derived: WorkspaceDerivation): WorkspaceNode[] {
  return nodesFromRows(derived.rows, derived.workspaceId);
}

function nodeById(derived: WorkspaceDerivation, id: string): WorkspaceNode | undefined {
  return nodesOf(derived).find((node) => node.id === id);
}

/**
 * Everything a derivation must satisfy no matter what produced it, run on every
 * written workspace in this file. Written as one helper rather than repeated
 * assertions so a new fixture cannot forget them.
 */
function assertWritable(derived: WorkspaceDerivation): void {
  expect(derived.skipped).toBeNull();
  expect(derived.census.membersIn).toBe(derived.census.paneNodesOut);
  for (const row of derived.rows) {
    expect(row.rootId).toBe(derived.workspaceId);
  }
  const nodes = nodesFromRows(derived.rows, derived.workspaceId);
  expect(validateTree(nodes)).toEqual({ ok: true });
  // Nothing may be stranded: a node the projection can place NOWHERE is a pane
  // that exists in the table and renders in no surface at all.
  expect(buildRenderTree(nodes).orphaned).toEqual([]);
}

// ---------------------------------------------------------------------------
// The ordinary shapes
// ---------------------------------------------------------------------------

describe('deriveWorkspaceNodes — the structure it produces', () => {
  it('gives a workspace one root, of type root, with axis row', () => {
    const derived = deriveWorkspaceNodes(source({ workspaceId: 'w1' }));
    assertWritable(derived);
    expect(derived.rows).toHaveLength(1);
    expect(derived.rows[0]).toMatchObject({ nodeType: 'root', parentId: null, position: 0, axis: 'row' });
  });

  it('gives it the root the SEED would mint, so the two derivations cannot drift apart', () => {
    // The migration and the runtime seed must agree on what this workspace's
    // root is called. If they disagree, a client seeding against an empty local
    // tree sends a root the backfilled server does not have, and the write is
    // refused `multiple_roots` instead of converging on the upsert — the exact
    // property the deterministic id exists to provide.
    const derived = deriveWorkspaceNodes(source({ workspaceId: 'w1' }));
    assertWritable(derived);
    expect(derived.rows[0]?.id).toBe(rootSeedFor('w1').id);
  });

  it('turns a multi-pane column into a split of axis column, panes in order', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [pane('p2', 'c1', 1, chat('conv-b')), pane('p1', 'c1', 0, chat('conv-a'))],
      }),
    );
    assertWritable(derived);
    const split = nodeById(derived, 'c1');
    expect(split).toMatchObject({ nodeType: 'split', axis: 'column', position: 0 });
    expect(nodeById(derived, 'p1')).toMatchObject({ parentId: 'c1', position: 0 });
    expect(nodeById(derived, 'p2')).toMatchObject({ parentId: 'c1', position: 1 });
  });

  it('preserves column order across the grid', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c2', 1), column('c1', 0)],
        panes: [
          pane('p1', 'c1', 0, chat('a')),
          pane('p2', 'c1', 1, chat('b')),
          pane('p3', 'c2', 0, chat('c')),
          pane('p4', 'c2', 1, chat('d')),
        ],
      }),
    );
    assertWritable(derived);
    expect(nodeById(derived, 'c1')).toMatchObject({ position: 0 });
    expect(nodeById(derived, 'c2')).toMatchObject({ position: 1 });
  });

  it('renumbers a column whose orderIndex has a gap, rather than carrying it', () => {
    // A verb that renumbered half a group and stopped leaves a gap; the node
    // model asserts contiguity, so position comes from the sort, never the row.
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [pane('p1', 'c1', 0, chat('a')), pane('p2', 'c1', 7, chat('b')), pane('p3', 'c1', 9, chat('c'))],
      }),
    );
    assertWritable(derived);
    expect(['p1', 'p2', 'p3'].map((id) => nodeById(derived, id)?.position)).toEqual([0, 1, 2]);
  });

  it('carries a pane binding through as targetKind/targetId', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [pane('p1', 'c1', 0, chat('conv-a')), pane('p2', 'c1', 1, terminal('shell-a'))],
      }),
    );
    assertWritable(derived);
    expect(derived.rows.find((row) => row.id === 'p1')).toMatchObject({ targetKind: 'chat', targetId: 'conv-a' });
    expect(derived.rows.find((row) => row.id === 'p2')).toMatchObject({ targetKind: 'terminal', targetId: 'shell-a' });
  });
});

// ---------------------------------------------------------------------------
// The collapse — expected to be the COMMON shape, not an edge
// ---------------------------------------------------------------------------

describe('deriveWorkspaceNodes — the single-pane column collapses', () => {
  it('puts the lone pane directly under the root, in the column’s slot', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0), column('c2', 1)],
        panes: [pane('p1', 'c1', 0, chat('a')), pane('p2', 'c2', 0, chat('b'))],
      }),
    );
    assertWritable(derived);
    const rootId = derived.rows.find((row) => row.nodeType === 'root')?.id;
    expect(nodeById(derived, 'p1')).toMatchObject({ nodeType: 'pane', parentId: rootId, position: 0 });
    expect(nodeById(derived, 'p2')).toMatchObject({ nodeType: 'pane', parentId: rootId, position: 1 });
    expect(derived.census.splitNodesOut).toBe(0);
  });

  it('is REQUIRED: keeping the split would be a degenerate_split', () => {
    // The mutation guard for the collapse. A one-child split is exactly what
    // validateTree refuses, so this pins WHY the collapse exists rather than
    // trusting that removing it would be noticed elsewhere.
    const withSplit: WorkspaceNode[] = [
      { nodeType: 'root', id: 'r', parentId: null, position: 0, axis: 'row' },
      { nodeType: 'split', id: 'c1', parentId: 'r', position: 0, axis: 'column' },
      { nodeType: 'pane', id: 'p1', parentId: 'c1', position: 0, target: { kind: 'chat', id: 'a' } },
    ];
    expect(validateTree(withSplit)).toMatchObject({ ok: false, code: 'degenerate_split' });
  });

  it('gives the survivor the COLUMN’s share, not its own', () => {
    // The pane's heightFraction was a share of the column, and the column is no
    // longer there for it to be a share of — the algebra's own collapse rule.
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0, 0.25), column('c2', 1, 0.75)],
        panes: [pane('p1', 'c1', 0, chat('a'), 0.9), pane('p2', 'c2', 0, chat('b'), 0.1)],
      }),
    );
    assertWritable(derived);
    expect(nodeById(derived, 'p1')).toMatchObject({ fraction: 0.25 });
    expect(nodeById(derived, 'p2')).toMatchObject({ fraction: 0.75 });
  });
});

// ---------------------------------------------------------------------------
// Membership with no pane row — SEATED, never detached
// ---------------------------------------------------------------------------

describe('deriveWorkspaceNodes — members with no pane are SEATED under the root', () => {
  it('seats an open conversation that no pane shows', () => {
    // These members used to be emitted with `parentId: null` and called
    // detached. That reproduced, inside the migration, the split the migration
    // exists to remove: a workspace would arrive in the new model already
    // holding nodes no renderer would draw.
    const derived = deriveWorkspaceNodes(
      source({ workspaceId: 'w1', conversations: [member('conv-a')] }),
    );
    assertWritable(derived);
    const seated = derived.rows.filter((row) => row.nodeType === 'pane');
    expect(seated).toHaveLength(1);
    expect(seated[0]).toMatchObject({ targetKind: 'chat', targetId: 'conv-a', position: 0 });
    expect(seated[0].parentId).toBe(derived.rows.find((row) => row.nodeType === 'root')?.id);
  });

  it('NEVER emits a non-root row with a null parent, whatever the sources hold', () => {
    // The property, stated over the shape rather than over one fixture. A row
    // like this is what `nodeFromRow` now refuses and what `validateTree` calls
    // `null_parent`, so a derivation that produced one would be writing rows the
    // read path cannot read back.
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [pane('p1', 'c1', 0, chat('conv-x')), pane('p2', 'c1', 1, chat('conv-y'))],
        conversations: [member('conv-a'), member('conv-b')],
        shells: [member('shell-a')],
      }),
    );
    assertWritable(derived);
    for (const row of derived.rows) {
      if (row.nodeType !== 'root') expect(row.parentId, `row ${row.id}`).not.toBeNull();
    }
  });

  it('seats a shell that no pane shows, and skips one a pane already holds', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [pane('p1', 'c1', 0, terminal('shell-a'))],
        shells: [member('shell-a'), member('shell-b')],
      }),
    );
    assertWritable(derived);
    expect(derived.census.seatedOut).toBe(1);
    const rootId = derived.rows.find((row) => row.nodeType === 'root')?.id;
    expect(derived.rows.find((row) => row.targetId === 'shell-b')).toMatchObject({ parentId: rootId });
  });

  it('emits ONE node for a conversation that already has a pane — never two', () => {
    // The single-derivation rule itself. Split this into "migrate the layout,
    // then backfill unplaced membership" and this conversation gets two nodes,
    // which the chat unique index would refuse at the second INSERT.
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [pane('p1', 'c1', 0, chat('conv-a'))],
        conversations: [member('conv-a')],
      }),
    );
    assertWritable(derived);
    const chatNodes = derived.rows.filter((row) => row.targetKind === 'chat' && row.targetId === 'conv-a');
    expect(chatNodes).toHaveLength(1);
    expect(chatNodes[0].id).toBe('p1');
    expect(derived.census.seatedOut).toBe(0);
  });

  it('numbers the seated members contiguously, conversations then shells, oldest first', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        conversations: [member('conv-b', 5), member('conv-a', 1)],
        shells: [member('shell-b', 9), member('shell-a', 2)],
      }),
    );
    assertWritable(derived);
    const seated = derived.rows
      .filter((row) => row.nodeType === 'pane')
      .sort((left, right) => left.position - right.position);
    expect(seated.map((row) => row.targetId)).toEqual(['conv-a', 'conv-b', 'shell-a', 'shell-b']);
    expect(seated.map((row) => row.position)).toEqual([0, 1, 2, 3]);
  });

  it('CONTINUES the root’s own numbering past the columns, rather than starting a second run', () => {
    // The seated members are children of the root like the columns are, so
    // their positions carry on from the last column's. A second 0-based run
    // beside the columns would be `position_contiguity` — and it is what the
    // parked group used to be, numbered independently because it was a
    // different bucket.
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0), column('c2', 1)],
        panes: [pane('p1', 'c1', 0, chat('conv-x')), pane('p2', 'c2', 0, chat('conv-y'))],
        conversations: [member('conv-a')],
      }),
    );
    assertWritable(derived);
    const rootId = derived.rows.find((row) => row.nodeType === 'root')?.id;
    const children = derived.rows
      .filter((row) => row.parentId === rootId)
      .sort((left, right) => left.position - right.position);
    expect(children.map((row) => row.position)).toEqual([0, 1, 2]);
    expect(children[2].targetId).toBe('conv-a');
  });

  it('reads the grid’s column shares as UNSIZED when a member has to be seated beside them', () => {
    // A seated member carries no stored share — there was no pane row to carry
    // one — and a container is sized or unsized, never both. So the root's
    // group settles as unsized wholesale, which is the rule
    // `settleGroupShares` already applied to a half-sized column, and the note
    // says the stored widths were what got given up.
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0, 0.7), column('c2', 1, 0.3)],
        panes: [pane('p1', 'c1', 0, chat('conv-x')), pane('p2', 'c2', 0, chat('conv-y'))],
        conversations: [member('conv-a')],
      }),
    );
    assertWritable(derived);
    for (const row of derived.rows) {
      if (row.nodeType !== 'root') expect(row.fraction, `row ${row.id}`).toBeNull();
    }
    expect(derived.notes.map((entry) => entry.code)).toContain('fractions_read_as_unsized');
  });
});

// ---------------------------------------------------------------------------
// The pathological inputs, enumerated
// ---------------------------------------------------------------------------

describe('deriveWorkspaceNodes — what the real data can contain', () => {
  it('a workspace with panes but no conversations', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [pane('p1', 'c1', 0, chat('a')), pane('p2', 'c1', 1, chat('b'))],
      }),
    );
    assertWritable(derived);
    expect(derived.census.seatedOut).toBe(0);
    expect(derived.census.paneNodesOut).toBe(2);
  });

  it('a workspace with conversations but no panes — every one seated, none lost', () => {
    const derived = deriveWorkspaceNodes(
      source({ workspaceId: 'w1', conversations: [member('a'), member('b'), member('c')] }),
    );
    assertWritable(derived);
    expect(derived.census.seatedOut).toBe(3);
    expect(derived.census.membersIn).toBe(3);
  });

  it('a pane whose targetId names a conversation that no longer exists — carried, and reported', () => {
    // No FK, by design: "a node pointing at a deleted conversation repairs at
    // read time". Dropping the binding here would change what the user sees.
    const derived = deriveWorkspaceNodes(
      source({ workspaceId: 'w1', columns: [column('c1', 0)], panes: [pane('p1', 'c1', 0, chat('gone'))] }),
      { knownConversationIds: new Set<string>() },
    );
    assertWritable(derived);
    expect(nodeById(derived, 'p1')).toMatchObject({ target: { kind: 'chat', id: 'gone' } });
    expect(derived.notes.map((entry) => entry.code)).toContain('chat_target_missing_row');
  });

  it('two panes of ONE workspace on the same conversation — first wins, the loser shows the picker', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0), column('c2', 1)],
        panes: [
          pane('p1', 'c1', 0, chat('conv-a')),
          pane('pX', 'c1', 1, chat('other')),
          pane('p2', 'c2', 0, chat('conv-a')),
          pane('pY', 'c2', 1, chat('other-2')),
        ],
      }),
    );
    assertWritable(derived);
    expect(nodeById(derived, 'p1')).toMatchObject({ target: { kind: 'chat', id: 'conv-a' } });
    expect(nodeById(derived, 'p2')).toMatchObject({ target: null });
    // The rectangle survives — the geometry the user arranged is not edited.
    expect(derived.census.paneNodesOut).toBe(4);
    expect(derived.notes.map((entry) => entry.code)).toContain('chat_target_duplicated');
  });

  it('two panes in DIFFERENT workspaces on one conversation — the owner keeps it', () => {
    const references = [
      { workspaceId: 'w2', conversationId: 'conv-a' },
      { workspaceId: 'w1', conversationId: 'conv-a' },
    ];
    const claims = resolveChatClaims({
      references,
      membershipOwner: new Map([['conv-a', 'w1']]),
    });
    expect(claims.get('conv-a')).toBe('w1');

    const inOwner = deriveWorkspaceNodes(
      source({ workspaceId: 'w1', columns: [column('c1', 0)], panes: [pane('p1', 'c1', 0, chat('conv-a'))] }),
      { chatClaims: claims },
    );
    const inStranger = deriveWorkspaceNodes(
      source({ workspaceId: 'w2', columns: [column('c9', 0)], panes: [pane('p9', 'c9', 0, chat('conv-a'))] }),
      { chatClaims: claims },
    );
    assertWritable(inOwner);
    assertWritable(inStranger);
    expect(nodeById(inOwner, 'p1')).toMatchObject({ target: { kind: 'chat', id: 'conv-a' } });
    expect(nodeById(inStranger, 'p9')).toMatchObject({ target: null });
    expect(inStranger.notes.map((entry) => entry.code)).toContain('chat_target_foreign');
  });

  it('a conversation bound to an ENDED workspace never reaches the derivation', () => {
    // Live workspaces are the caller's filter (`endedAt IS NULL`), so the shape
    // that matters here is the consequence: a pane elsewhere naming such a
    // thread has no owner to lose to and keeps it.
    const claims = resolveChatClaims({
      references: [{ workspaceId: 'w1', conversationId: 'conv-in-dead-session' }],
      membershipOwner: new Map(), // the owner is ended, so it emits nothing
    });
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [pane('p1', 'c1', 0, chat('conv-in-dead-session'))],
      }),
      { chatClaims: claims },
    );
    assertWritable(derived);
    expect(nodeById(derived, 'p1')).toMatchObject({ target: { kind: 'chat', id: 'conv-in-dead-session' } });
  });

  it('a column with zero panes is dropped, not turned into an empty split', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0), column('empty', 1), column('c2', 2)],
        panes: [
          pane('p1', 'c1', 0, chat('a')),
          pane('p2', 'c1', 1, chat('b')),
          pane('p3', 'c2', 0, chat('c')),
          pane('p4', 'c2', 1, chat('d')),
        ],
      }),
    );
    assertWritable(derived);
    expect(nodeById(derived, 'empty')).toBeUndefined();
    expect(nodeById(derived, 'c1')).toMatchObject({ position: 0 });
    expect(nodeById(derived, 'c2')).toMatchObject({ position: 1 });
    expect(derived.notes.map((entry) => entry.code)).toContain('empty_column_dropped');
  });

  it('a grid of nothing but empty columns leaves a bare root, which is legal', () => {
    const derived = deriveWorkspaceNodes(
      source({ workspaceId: 'w1', columns: [column('c1', 0), column('c2', 1)] }),
    );
    assertWritable(derived);
    expect(derived.rows).toHaveLength(1);
  });

  it('a pane with a null kind is an unbound picker pane, carried as one', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [pane('p1', 'c1', 0), pane('p2', 'c1', 1, chat('a'))],
      }),
    );
    assertWritable(derived);
    expect(derived.rows.find((row) => row.id === 'p1')).toMatchObject({ targetKind: null, targetId: null });
    expect(derived.notes).toEqual([]);
  });

  it.each([
    ['a kind with no id', { kind: 'chat', targetId: null }, 'pane_target_half_bound'],
    ['an id with no kind', { kind: null, targetId: 'conv-a' }, 'pane_target_half_bound'],
    ['an empty id', { kind: 'chat', targetId: '   ' }, 'pane_target_half_bound'],
    ['a kind outside the domain', { kind: 'Chat', targetId: 'conv-a' }, 'pane_target_unknown_kind'],
  ])('reads %s as unbound and reports it', (_name, binding, code) => {
    const derived = deriveWorkspaceNodes(
      source({ workspaceId: 'w1', columns: [column('c1', 0)], panes: [pane('p1', 'c1', 0, binding)] }),
    );
    assertWritable(derived);
    expect(derived.rows.find((row) => row.id === 'p1')).toMatchObject({ targetKind: null, targetId: null });
    expect(derived.notes.map((entry) => entry.code)).toContain(code);
  });

  it('a workspace over MAX_NODES is SKIPPED, not truncated', () => {
    const conversations = Array.from({ length: MAX_NODES + 10 }, (_unused, index) =>
      member(`conv-${String(index).padStart(5, '0')}`, index),
    );
    const derived = deriveWorkspaceNodes(source({ workspaceId: 'w1', conversations }));
    expect(derived.rows).toEqual([]);
    expect(derived.skipped).toMatchObject({ code: 'max_nodes_exceeded' });
    // A skipped workspace still reports what it saw, so the operator can act.
    expect(derived.census.conversationsIn).toBe(MAX_NODES + 10);
  });

  it('a column id colliding with a pane id renames the COLUMN, never the pane', () => {
    // Legal today (two tables, two primary keys), a duplicate_id tomorrow. The
    // pane keeps its id because that is the one clients hold and bindings address.
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('x', 0)],
        panes: [pane('x', 'x', 0, chat('a')), pane('p2', 'x', 1, chat('b'))],
      }),
    );
    assertWritable(derived);
    expect(nodeById(derived, 'x')).toMatchObject({ nodeType: 'pane' });
    expect(nodeById(derived, 'x#split')).toMatchObject({ nodeType: 'split' });
    expect(derived.notes.map((entry) => entry.code)).toContain('column_id_renamed');
  });

  it('a seated member id colliding with a pane id renames the seated node', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [pane('conv-a::pane', 'c1', 0, chat('other'))],
        conversations: [member('conv-a')],
      }),
    );
    assertWritable(derived);
    expect(nodeById(derived, 'conv-a::pane')).toMatchObject({ target: { kind: 'chat', id: 'other' } });
    expect(nodeById(derived, 'conv-a::pane#chat')).toMatchObject({ target: { kind: 'chat', id: 'conv-a' } });
    expect(nodeById(derived, 'conv-a::pane#chat')?.parentId).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The threads that are NOT members any more
//
// The single most dangerous shape in the whole corpus, and the only finding on
// this migration's list that cannot be corrected after the fact: on the old
// model, closing a thread out of a workspace stamped `closedInWorkspaceAt` and
// NOTHING removed its pane row, so "a live pane bound to a dismissed thread" is
// ordinary production data. Post-cutover membership IS the node, so a pane
// materialised for such a thread does not merely put it back in the sidebar —
// it puts it back ON THE GRID, which is strictly worse than the reappearance
// the membership path already refuses.
//
// `openConversationIds` is that refusal, applied to the pane path: the same
// predicate the membership load uses (`isActive`, `closedInWorkspaceAt IS
// NULL`), resolved over every conversation any pane row names.
// ---------------------------------------------------------------------------

describe('deriveWorkspaceNodes — a pane bound to a thread that is not a member', () => {
  /** A workspace whose one column shows three threads, of which `open` are still members. */
  function grid(open: readonly string[], known: readonly string[]) {
    return deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [
          pane('p1', 'c1', 0, chat('t1')),
          pane('p2', 'c1', 1, chat('t2')),
          pane('p3', 'c1', 2, chat('t3')),
        ],
        conversations: open.map((id, index) => member(id, index)),
      }),
      { openConversationIds: new Set(open), knownConversationIds: new Set(known) },
    );
  }

  it('does not materialise a pane whose conversation was DISMISSED out of the workspace', () => {
    // `closedInWorkspaceAt` stamped, row alive. The bug, stated exactly.
    const derived = grid(['t1', 't3'], ['t1', 't2', 't3']);
    assertWritable(derived);
    expect(nodeById(derived, 'p2')).toBeUndefined();
    const targets = derived.rows.filter((row) => row.targetKind === 'chat').map((row) => row.targetId);
    expect(targets).not.toContain('t2');
    expect(derived.notes.map((entry) => entry.code)).toContain('chat_pane_not_a_member');
  });

  it('does not materialise a pane whose conversation was HISTORY-DELETED', () => {
    // A history delete is `isActive: false` — the row survives, the membership
    // does not. Worse than a dismissal, because `expelConversationFromSession`
    // is what removes such a thread's node and it runs at DELETION time: it
    // will never run for anything deleted before the cutover, so the node would
    // be a permanent member holding a cap slot nothing can ever release.
    const derived = grid(['t1', 't2'], ['t1', 't2', 't3']);
    assertWritable(derived);
    expect(nodeById(derived, 'p3')).toBeUndefined();
    expect(derived.notes.map((entry) => entry.code)).toContain('chat_pane_not_a_member');
  });

  it('does not materialise a pane whose conversation has NO ROW at all', () => {
    // Hard-deleted with its page or drive (`conversation-cleanup.ts`). "Repairs
    // at read time" was written for a node whose thread is deleted LATER, where
    // the delete path expels it; nothing will ever expel this one.
    const derived = grid(['t1', 't2'], ['t1', 't2']);
    assertWritable(derived);
    expect(nodeById(derived, 'p3')).toBeUndefined();
    expect(derived.notes.map((entry) => entry.code)).toContain('chat_pane_no_conversation');
  });

  it('RENUMBERS the survivors rather than leaving a hole where the pane was', () => {
    // `position` must stay contiguous per sibling group or `validateTree`
    // refuses the whole workspace — so a hole is not an option the model has.
    const derived = grid(['t1', 't3'], ['t1', 't2', 't3']);
    assertWritable(derived);
    expect(nodeById(derived, 'p1')).toMatchObject({ position: 0 });
    expect(nodeById(derived, 'p3')).toMatchObject({ position: 1 });
  });

  it('drops a column the removal EMPTIED, rather than leaving a degenerate split', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0), column('c2', 1)],
        panes: [
          pane('p1', 'c1', 0, chat('gone-a')),
          pane('p2', 'c2', 0, chat('t2')),
          pane('p3', 'c2', 1, chat('t3')),
        ],
        conversations: [member('t2'), member('t3', 1)],
      }),
      {
        openConversationIds: new Set(['t2', 't3']),
        knownConversationIds: new Set(['gone-a', 't2', 't3']),
      },
    );
    assertWritable(derived);
    expect(nodeById(derived, 'c1')).toBeUndefined();
    expect(nodeById(derived, 'c2')).toMatchObject({ nodeType: 'split', position: 0 });
    // BOTH notes fire, and the operator wants both. The column row itself is
    // still in `source.columns` — only its panes left — so it reaches
    // `orderColumns` holding nothing and is dropped by the rule that already
    // existed for columns that were empty to begin with. Observed on the
    // rehearsal database: `ws-a` reported
    // `chat_pane_not_a_member,…,empty_column_dropped,fractions_read_as_unsized`.
    const codes = derived.notes.map((entry) => entry.code);
    expect(codes).toContain('chat_pane_not_a_member');
    expect(codes).toContain('empty_column_dropped');
  });

  it('COLLAPSES a two-pane column the removal reduced to one', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [pane('p1', 'c1', 0, chat('t1')), pane('p2', 'c1', 1, chat('dead'))],
        conversations: [member('t1')],
      }),
      { openConversationIds: new Set(['t1']), knownConversationIds: new Set(['t1', 'dead']) },
    );
    assertWritable(derived);
    // The survivor takes the column's place directly under the root — keeping
    // the split would be a `degenerate_split` and skip the whole workspace.
    expect(nodeById(derived, 'c1')).toBeUndefined();
    expect(nodeById(derived, 'p1')).toMatchObject({ nodeType: 'pane', position: 0 });
    expect(nodeById(derived, 'p1')?.parentId).toBe(rootSeedFor('w1').id);
  });

  it('reads a shrunken column’s shares as UNSIZED — they no longer sum to 1', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [
          pane('p1', 'c1', 0, chat('t1'), 0.5),
          pane('p2', 'c1', 1, chat('t2'), 0.3),
          pane('p3', 'c1', 2, chat('dead'), 0.2),
        ],
        conversations: [member('t1'), member('t2', 1)],
      }),
      { openConversationIds: new Set(['t1', 't2']), knownConversationIds: new Set(['t1', 't2', 'dead']) },
    );
    assertWritable(derived);
    expect(nodeById(derived, 'p1')).not.toHaveProperty('fraction');
    expect(derived.notes.map((entry) => entry.code)).toContain('fractions_read_as_unsized');
  });

  it('leaves TERMINAL and PAGE panes alone — the predicate is about chat membership', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [
          pane('p1', 'c1', 0, terminal('sh1')),
          pane('p2', 'c1', 1, { kind: 'page', targetId: 'page-1' }),
          pane('p3', 'c1', 2),
        ],
      }),
      { openConversationIds: new Set<string>(), knownConversationIds: new Set<string>() },
    );
    assertWritable(derived);
    expect(derived.census.panesDroppedNotMember).toBe(0);
    expect(derived.census.paneNodesOut).toBe(3);
  });

  it('counts the drop in the census and keeps membersIn === paneNodesOut', () => {
    const derived = grid(['t1'], ['t1', 't2']);
    assertWritable(derived);
    // `panesIn` still reports every ROW READ — the operator has to see the
    // difference between what production holds and what was materialised.
    expect(derived.census.panesIn).toBe(3);
    expect(derived.census.panesDroppedNotMember).toBe(2);
    expect(derived.census.membersIn).toBe(1);
    expect(derived.census.paneNodesOut).toBe(1);
  });

  it('CARRIES the pane when the caller supplies no membership set at all', () => {
    // The predicate is the caller's to resolve — it needs rows this module
    // never sees. Absent, the derivation behaves exactly as it did before, and
    // `scripts/backfill-agent-workspace-nodes.ts` is the one caller that must
    // always supply it.
    const derived = deriveWorkspaceNodes(
      source({ workspaceId: 'w1', columns: [column('c1', 0)], panes: [pane('p1', 'c1', 0, chat('t1'))] }),
    );
    assertWritable(derived);
    expect(nodeById(derived, 'p1')).toMatchObject({ target: { kind: 'chat', id: 't1' } });
    expect(derived.census.panesDroppedNotMember).toBe(0);
  });

  it('answers DISMISSED before it answers foreign — a dead thread is not another workspace’s', () => {
    const derived = deriveWorkspaceNodes(
      source({ workspaceId: 'w1', columns: [column('c1', 0)], panes: [pane('p1', 'c1', 0, chat('t1'))] }),
      {
        chatClaims: new Map([['t1', 'w2']]),
        openConversationIds: new Set<string>(),
        knownConversationIds: new Set(['t1']),
      },
    );
    assertWritable(derived);
    const codes = derived.notes.map((entry) => entry.code);
    expect(codes).toContain('chat_pane_not_a_member');
    expect(codes).not.toContain('chat_target_foreign');
  });

  it('does not let a dropped pane’s id block a column that shares it', () => {
    // The row is not in the derivation at all, so it reserves nothing.
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('x', 0)],
        panes: [pane('x', 'x', 0, chat('dead')), pane('p2', 'x', 1, chat('t1')), pane('p3', 'x', 2, chat('t2'))],
        conversations: [member('t1'), member('t2', 1)],
      }),
      { openConversationIds: new Set(['t1', 't2']), knownConversationIds: new Set(['dead', 't1', 't2']) },
    );
    assertWritable(derived);
    expect(nodeById(derived, 'x')).toMatchObject({ nodeType: 'split' });
    expect(derived.notes.map((entry) => entry.code)).not.toContain('column_id_renamed');
  });

  it('still SEATS the threads that ARE members when a pane beside them is dropped', () => {
    // The half that must not regress: dropping a dead thread's pane must not
    // cost a live thread its node. Production shape #1, with one dismissal.
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w-prod-a',
        columns: [column('ca1', 0)],
        panes: [pane('pa1', 'ca1', 0, chat('ta1')), pane('pa2', 'ca1', 1, chat('ta2'))],
        conversations: [member('ta1'), member('ta3', 2)],
      }),
      {
        openConversationIds: new Set(['ta1', 'ta3']),
        knownConversationIds: new Set(['ta1', 'ta2', 'ta3']),
      },
    );
    assertWritable(derived);
    const targets = derived.rows.filter((row) => row.targetKind === 'chat').map((row) => row.targetId);
    expect(targets.sort()).toEqual(['ta1', 'ta3']);
    expect(derived.census.seatedOut).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fractions
// ---------------------------------------------------------------------------

describe('deriveWorkspaceNodes — shares', () => {
  it('carries settled shares through verbatim', () => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [pane('p1', 'c1', 0, chat('a'), 0.3), pane('p2', 'c1', 1, chat('b'), 0.7)],
      }),
    );
    assertWritable(derived);
    expect(nodeById(derived, 'p1')).toMatchObject({ fraction: 0.3 });
    expect(nodeById(derived, 'p2')).toMatchObject({ fraction: 0.7 });
  });

  it('leaves an unsized container with NO fraction key at all, never an explicit null', () => {
    // The absence IS the state. A rehydrated node must be byte-identical to one
    // the algebra built, or every write looks like a change.
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [pane('p1', 'c1', 0, chat('a')), pane('p2', 'c1', 1, chat('b'))],
      }),
    );
    assertWritable(derived);
    expect(nodeById(derived, 'p1')).not.toHaveProperty('fraction');
  });

  it.each([
    ['mixed', [0.5, null]],
    ['not summing to 1', [0.5, 0.2]],
    ['non-positive', [0, 1]],
    ['non-finite', [Number.NaN, 0.5]],
  ])('reads a %s container as unsized wholesale, as every live reader already does', (_name, shares) => {
    const derived = deriveWorkspaceNodes(
      source({
        workspaceId: 'w1',
        columns: [column('c1', 0)],
        panes: [
          pane('p1', 'c1', 0, chat('a'), shares[0]),
          pane('p2', 'c1', 1, chat('b'), shares[1]),
        ],
      }),
    );
    assertWritable(derived);
    expect(nodeById(derived, 'p1')).not.toHaveProperty('fraction');
    expect(nodeById(derived, 'p2')).not.toHaveProperty('fraction');
    expect(derived.notes.map((entry) => entry.code)).toContain('fractions_read_as_unsized');
  });

  it('leaves seated members unsized — they had no pane row to carry a share', () => {
    // And because a container is sized or unsized and never both, their arrival
    // is also what makes the whole root group unsized. See the seating suite for
    // the case where that discards stored column widths.
    const derived = deriveWorkspaceNodes(
      source({ workspaceId: 'w1', conversations: [member('a'), member('b', 1)] }),
    );
    assertWritable(derived);
    for (const row of derived.rows.filter((entry) => entry.nodeType === 'pane')) {
      expect(row.fraction).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The rootId stamp — the failure the whole model exists to prevent
// ---------------------------------------------------------------------------

describe('deriveWorkspaceNodes — every node carries the rootId it was derived FROM', () => {
  it('keeps two workspaces derived side by side entirely apart', () => {
    const first = deriveWorkspaceNodes(
      source({ workspaceId: 'w1', columns: [column('c1', 0)], panes: [pane('p1', 'c1', 0, chat('a'))] }),
    );
    const second = deriveWorkspaceNodes(
      source({ workspaceId: 'w2', columns: [column('c1', 0)], panes: [pane('p1', 'c1', 0, chat('b'))] }),
    );
    assertWritable(first);
    assertWritable(second);
    // Client-minted ids collide across workspaces LEGITIMATELY — that is why
    // the primary key is compound — so the only thing keeping these apart is
    // the stamp.
    expect(new Set(first.rows.map((row) => row.rootId))).toEqual(new Set(['w1']));
    expect(new Set(second.rows.map((row) => row.rootId))).toEqual(new Set(['w2']));
  });

  it('refuses rows scoped to another workspace at the read boundary', () => {
    const derived = deriveWorkspaceNodes(
      source({ workspaceId: 'w1', columns: [column('c1', 0)], panes: [pane('p1', 'c1', 0, chat('a'))] }),
    );
    expect(() => nodesFromRows(derived.rows, 'w2')).toThrow(/belongs to w1/);
  });
});

// ---------------------------------------------------------------------------
// Idempotence and resumability
// ---------------------------------------------------------------------------

describe('deriveWorkspaceNodes — running it twice', () => {
  const twiceSource = source({
    workspaceId: 'w1',
    columns: [column('c1', 0), column('c2', 1)],
    panes: [
      pane('p1', 'c1', 0, chat('conv-a')),
      pane('p2', 'c1', 1, terminal('shell-a')),
      pane('p3', 'c2', 0, chat('conv-b')),
    ],
    conversations: [member('conv-a'), member('conv-c', 3)],
    shells: [member('shell-a'), member('shell-b', 4)],
  });

  it('is deterministic: the same input gives byte-identical rows', () => {
    const first = deriveWorkspaceNodes(twiceSource);
    const second = deriveWorkspaceNodes(twiceSource);
    assertWritable(first);
    expect(second.rows).toEqual(first.rows);
  });

  it('emits nothing for a target an earlier run already bound', () => {
    // The resume case. An earlier run wrote conv-a's node into another
    // workspace; this one must neither bind it nor park it.
    const derived = deriveWorkspaceNodes(twiceSource, { claimedChatTargets: new Set(['conv-a', 'conv-c']) });
    assertWritable(derived);
    expect(derived.rows.filter((row) => row.targetId === 'conv-a')).toHaveLength(0);
    expect(derived.rows.filter((row) => row.targetId === 'conv-c')).toHaveLength(0);
    // Both threads lose their node here: conv-a's pane unbinds and conv-a's
    // membership drops with it, conv-c's membership drops on its own.
    expect(derived.census.membershipDropped).toBe(2);
    expect(derived.notes.map((entry) => entry.code)).toContain('chat_target_already_bound');
  });
});

describe('resolveChatClaims', () => {
  it('gives a conversation to its owning workspace even when a stranger’s pane names it', () => {
    const claims = resolveChatClaims({
      references: [{ workspaceId: 'w9', conversationId: 'conv-a' }],
      membershipOwner: new Map([['conv-a', 'w1']]),
    });
    expect(claims.get('conv-a')).toBe('w1');
  });

  it('falls back to the lowest workspace id when no live owner exists', () => {
    const claims = resolveChatClaims({
      references: [
        { workspaceId: 'w9', conversationId: 'conv-a' },
        { workspaceId: 'w2', conversationId: 'conv-a' },
      ],
      membershipOwner: new Map(),
    });
    expect(claims.get('conv-a')).toBe('w2');
  });

  it('is stable regardless of the order rows arrive in', () => {
    const forwards = resolveChatClaims({
      references: [
        { workspaceId: 'w2', conversationId: 'c' },
        { workspaceId: 'w9', conversationId: 'c' },
      ],
      membershipOwner: new Map(),
    });
    const backwards = resolveChatClaims({
      references: [
        { workspaceId: 'w9', conversationId: 'c' },
        { workspaceId: 'w2', conversationId: 'c' },
      ],
      membershipOwner: new Map(),
    });
    expect(forwards.get('c')).toBe(backwards.get('c'));
  });

  it('yields to an earlier run entirely — nobody claims what is already bound', () => {
    const claims = resolveChatClaims({
      references: [{ workspaceId: 'w1', conversationId: 'conv-a' }],
      membershipOwner: new Map([['conv-a', 'w1']]),
      claimed: new Set(['conv-a']),
    });
    expect(claims.has('conv-a')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE REHEARSAL
// ---------------------------------------------------------------------------

/**
 * The before/after census.
 *
 * No database is reachable from this worktree, so this stands in for the dry
 * run against production: the same derivation, the same counters, over fixtures
 * built to the shapes the real data is known to hold — including the two
 * measured in production and recorded in `annotate-conversation-panes.ts`'s
 * docblock ("one workspace had 3 threads and 2 panes, another had 10 threads
 * and 4 panes. Six of that second workspace's threads could not be seen or
 * reached from the sidebar at all"). Those two are the whole reason detached
 * membership exists, so they are the two the census has to get right.
 */
describe('the rehearsal census', () => {
  interface Fixture {
    name: string;
    source: WorkspaceBackfillSource;
    /**
     * Conversation ids that still have a ROW, when that is not simply the
     * workspace's members. The two sets differ exactly where the dangerous data
     * lives: a thread whose row is alive but whose membership is not.
     */
    known?: readonly string[];
  }

  const FIXTURES: Fixture[] = [
    {
      // Production shape #1 — 3 threads, 2 panes. One thread invisible today.
      name: 'production: 3 threads, 2 panes',
      source: source({
        workspaceId: 'w-prod-a',
        columns: [column('ca1', 0)],
        panes: [pane('pa1', 'ca1', 0, chat('ta1')), pane('pa2', 'ca1', 1, chat('ta2'))],
        conversations: [member('ta1'), member('ta2', 1), member('ta3', 2)],
      }),
    },
    {
      // Production shape #2 — 10 threads, 4 panes. SIX invisible today.
      name: 'production: 10 threads, 4 panes',
      source: source({
        workspaceId: 'w-prod-b',
        columns: [column('cb1', 0), column('cb2', 1)],
        panes: [
          pane('pb1', 'cb1', 0, chat('tb1')),
          pane('pb2', 'cb1', 1, chat('tb2')),
          pane('pb3', 'cb2', 0, chat('tb3')),
          pane('pb4', 'cb2', 1, chat('tb4')),
        ],
        conversations: Array.from({ length: 10 }, (_unused, index) => member(`tb${index + 1}`, index)),
      }),
    },
    {
      name: 'a single one-pane column — the collapse case',
      source: source({
        workspaceId: 'w-single',
        columns: [column('cs1', 0)],
        panes: [pane('ps1', 'cs1', 0, chat('ts1'))],
        conversations: [member('ts1')],
      }),
    },
    {
      name: 'a session with shells and pages beside its chats',
      source: source({
        workspaceId: 'w-mixed',
        columns: [column('cm1', 0), column('cm2', 1)],
        panes: [
          pane('pm1', 'cm1', 0, chat('tm1'), 0.6),
          pane('pm2', 'cm1', 1, terminal('sm1'), 0.4),
          pane('pm3', 'cm2', 0, { kind: 'page', targetId: 'page-1' }),
          pane('pm4', 'cm2', 1, { kind: 'page', targetId: 'page-1' }),
        ],
        conversations: [member('tm1'), member('tm2', 1)],
        shells: [member('sm1'), member('sm2', 2)],
      }),
    },
    {
      name: 'a grid carrying every defect at once',
      source: source({
        workspaceId: 'w-ugly',
        columns: [column('cu1', 0, 0.5), column('cu-empty', 1, 0.5), column('pu1', 2)],
        panes: [
          pane('pu1', 'cu1', 0, chat('tu1')),
          pane('pu2', 'cu1', 5, chat('tu1')),
          pane('pu3', 'cu1', 9, { kind: 'chat', targetId: null }),
          pane('pu4', 'pu1', 0, { kind: 'nope', targetId: 'x' }),
          pane('pu5', 'pu1', 1, terminal('su1')),
        ],
        conversations: [member('tu1'), member('tu2', 1)],
        shells: [member('su1'), member('su2', 3)],
      }),
    },
    {
      // Production shape #1 again, carrying what the OLD model actually leaves
      // behind: the user dismissed `td2` months ago and its pane row is STILL
      // THERE, because closing a listing stamped `closedInWorkspaceAt` and
      // nothing on the server ever removed a pane. `td3`'s page was deleted, so
      // its row is gone entirely. Two panes read, ONE materialised.
      name: 'production: live panes bound to a dismissed thread and a deleted one',
      source: source({
        workspaceId: 'w-prod-dismissed',
        columns: [column('cd1', 0)],
        panes: [
          pane('pd1', 'cd1', 0, chat('td1')),
          pane('pd2', 'cd1', 1, chat('td2')),
          pane('pd3', 'cd1', 2, chat('td3')),
        ],
        conversations: [member('td1')],
      }),
      known: ['td1', 'td2'],
    },
    {
      name: 'an empty session — no grid, no threads, no shells',
      source: source({ workspaceId: 'w-empty' }),
    },
  ];

  const derived = FIXTURES.map((fixture) => ({
    name: fixture.name,
    result: deriveWorkspaceNodes(fixture.source, {
      // The membership predicate, resolved: a workspace's OPEN conversations
      // are exactly the members the caller handed over.
      openConversationIds: new Set(fixture.source.conversations.map((entry) => entry.id)),
      knownConversationIds: new Set(
        fixture.known ?? fixture.source.conversations.map((entry) => entry.id),
      ),
    }),
  }));

  it.each(derived)('$name — members in equals pane nodes out', ({ result }) => {
    assertWritable(result);
  });

  it('every conversation that is a member ends up reachable in the workspace', () => {
    // The bug the epic exists to close, restated as an assertion: a thread that
    // is a member of a session must have a node, and there is one place a node
    // can be — so #2373 cannot recur here for the same reason it cannot recur
    // anywhere else in this model.
    for (const { result } of derived) {
      const targets = new Set(
        result.rows.filter((row) => row.targetKind === 'chat').map((row) => row.targetId),
      );
      const fixture = FIXTURES.find((entry) => entry.source.workspaceId === result.workspaceId);
      for (const conversation of fixture?.source.conversations ?? []) {
        expect(targets.has(conversation.id)).toBe(true);
      }
    }
  });

  it('binds each conversation to exactly one node, across the whole run', () => {
    const seen = new Map<string, string>();
    for (const { result } of derived) {
      for (const row of result.rows.filter((entry) => entry.targetKind === 'chat')) {
        const targetId = row.targetId as string;
        expect(seen.has(targetId)).toBe(false);
        seen.set(targetId, `${result.workspaceId}/${row.id}`);
      }
    }
  });

  it('materialises no node for the dismissed thread, and none for the deleted one', () => {
    // The finding, asserted on the production shape rather than on a minimal
    // one: three pane rows read, one node written, and the two threads the user
    // cannot see today are still invisible tomorrow.
    const result = derived.find((entry) => entry.result.workspaceId === 'w-prod-dismissed')?.result;
    expect(result).toBeDefined();
    const census = result!.census;
    expect(census.panesIn).toBe(3);
    expect(census.panesDroppedNotMember).toBe(2);
    expect(census.paneNodesOut).toBe(1);
    const codes = result!.notes.map((entry) => entry.code);
    expect(codes).toContain('chat_pane_not_a_member');
    expect(codes).toContain('chat_pane_no_conversation');
  });

  it('never materialises a node for a thread that is not a member, across the whole run', () => {
    // The invariant behind the finding, stated once over every fixture: the
    // chat targets written are a SUBSET of the members handed over. Anything
    // else is a thread reappearing on somebody's grid.
    for (const { result } of derived) {
      const fixture = FIXTURES.find((entry) => entry.source.workspaceId === result.workspaceId);
      const members = new Set((fixture?.source.conversations ?? []).map((entry) => entry.id));
      for (const row of result.rows.filter((entry) => entry.targetKind === 'chat')) {
        expect(members.has(row.targetId as string)).toBe(true);
      }
    }
  });

  it('prints the census', () => {
    const totals = {
      workspaces: 0,
      panesIn: 0,
      panesDroppedNotMember: 0,
      conversationsIn: 0,
      shellsIn: 0,
      membersIn: 0,
      nodesOut: 0,
      paneNodesOut: 0,
      seatedOut: 0,
      skipped: 0,
      notes: 0,
    };
    const lines: string[] = [];
    for (const { name, result } of derived) {
      const c = result.census;
      totals.workspaces += 1;
      totals.panesIn += c.panesIn;
      totals.panesDroppedNotMember += c.panesDroppedNotMember;
      totals.conversationsIn += c.conversationsIn;
      totals.shellsIn += c.shellsIn;
      totals.membersIn += c.membersIn;
      totals.nodesOut += c.nodesOut;
      totals.paneNodesOut += c.paneNodesOut;
      totals.seatedOut += c.seatedOut;
      totals.skipped += result.skipped === null ? 0 : 1;
      totals.notes += result.notes.length;
      lines.push(
        `${name}: panes ${c.panesIn}→${c.paneNodesOut - c.seatedOut} (${c.panesDroppedNotMember} not a member), ` +
          `threads ${c.conversationsIn}, shells ${c.shellsIn}, ` +
          `members ${c.membersIn}→${c.paneNodesOut}, seated ${c.seatedOut}, ` +
          `nodes ${c.nodesOut}, notes ${result.notes.length}` +
          (result.skipped === null ? '' : ` SKIPPED(${result.skipped.code})`),
      );
    }
    // eslint-disable-next-line no-console -- the census IS this test's output
    console.log(['', ...lines, JSON.stringify(totals)].join('\n'));
    expect(totals.membersIn).toBe(totals.paneNodesOut);
    expect(totals.skipped).toBe(0);
  });
});
