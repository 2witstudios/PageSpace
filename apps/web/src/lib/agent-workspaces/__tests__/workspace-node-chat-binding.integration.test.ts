// @vitest-environment node
/**
 * THE CROSS-WORKSPACE CHAT BIND, against a real Postgres.
 *
 * `agent_workspace_nodes_chat_target_idx` is `UNIQUE (targetId) WHERE
 * targetKind = 'chat'` — keyed on `targetId` ALONE, no `rootId`. One
 * conversation, one node, across the entire table. `validateTree` is handed one
 * workspace's nodes and therefore cannot see a binding another workspace holds,
 * and `authorizePaneScope` deliberately waves the cross-workspace case through
 * when the caller may access the thread on its own footing. So a caller with
 * access to two workspaces could drive a plain unique violation out of Postgres
 * and get a 502 back — a domain refusal reported as a server fault, in a body
 * carrying no `rev` and no `nodes`, so an optimistic client's rebase never fires
 * and its phantom pane stays on screen.
 *
 * Two claims are only true or false against a real database, and both are here:
 *
 *  1. **The pre-flight sees what no workspace-scoped read can.** The mocked
 *     runtime suite next door proves the wiring; this proves the query actually
 *     finds a row in another workspace's rows.
 *  2. **The BACKSTOP matches the constraint Postgres actually names.** The
 *     detector is keyed on the literal string
 *     `agent_workspace_nodes_chat_target_idx`, and no mock can tell you whether
 *     that is what the driver reports for this index — a mock asserting the name
 *     asserts only that the test and the code agree. So the violation is
 *     triggered DIRECTLY here, and the error the database raises is fed to the
 *     real detector.
 *
 * Requires DATABASE_URL → a Postgres with migrations applied. Deliberately does
 * NOT skip when the database is unreachable: a silently-skipping test for a
 * constraint name is indistinguishable from no test at all, which is the hole
 * this file exists to close.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { conversations } from '@pagespace/db/schema/conversations';
import { rootSeedFor } from '@pagespace/lib/agent-workspaces/workspace-node-commands';
import { factories } from '@pagespace/db/test/factories';
import type { WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import {
  CHAT_TARGET_UNIQUE_INDEX,
  isChatTargetUniqueViolation,
} from '@pagespace/lib/agent-workspaces/workspace-node-chat-binding';
import {
  readChatTargetHolders,
  readWorkspaceNodeSnapshot,
  writeWorkspaceNodes,
} from '@pagespace/lib/services/agent-workspaces/workspace-node-store';

// The realtime hop is not what this file is about, and a successful write here
// must not depend on a socket server being up.
vi.mock('@/lib/websocket/agent-workspace-events', () => ({
  broadcastWorkspaceNodesUpdated: vi.fn(),
}));

const { applyWorkspaceNodeWrite, destroyWorkspaceTree } = await import('../workspace-node-runtime');

/** Everything this file minted; the owning users cascade the rest away. */
const ownerIds: string[] = [];
let agentPageId = '';

async function createWorkspace(): Promise<string> {
  const [row] = await db
    .insert(agentWorkspaces)
    .values({ id: createId(), driveId: null, ownerId: ownerIds[0] })
    .returning({ id: agentWorkspaces.id });
  return row.id;
}

/**
 * A conversation owned by the acting user. It carries no workspace of its own:
 * membership is the node this suite writes, and there is no column to seed.
 */
async function createConversation(): Promise<string> {
  const id = createId();
  await db.insert(conversations).values({
    id,
    userId: ownerIds[0],
    type: 'page',
    contextId: agentPageId,
    isActive: true,
    updatedAt: new Date(),
  });
  return id;
}

const root: WorkspaceNode = { nodeType: 'root', id: 'root', parentId: null, position: 0, axis: 'row' };

function chatPane(id: string, position: number, conversationId: string): WorkspaceNode {
  return { nodeType: 'pane', id, parentId: 'root', position, target: { kind: 'chat', id: conversationId } };
}

/** Seed a workspace's tree the way the store would have left it. */
async function seedTree(workspaceId: string, nodes: WorkspaceNode[]): Promise<void> {
  await writeWorkspaceNodes(db, { workspaceId, write: { put: nodes, drop: [] } });
}

// FILE-SCOPED, so every describe below builds on the same owner and agent page.
// It used to live inside the first describe, which meant a second one ran with
// no fixtures at all — and after `afterAll` had already deleted the user.
beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'workspace-node-chat-binding.integration.test.ts requires DATABASE_URL: it asserts a ' +
        'constraint name the database reports, and must fail loudly rather than skip.',
    );
  }
  try {
    await db.select({ id: users.id }).from(users).limit(1);
  } catch (error) {
    throw new Error(
      `workspace-node-chat-binding.integration.test.ts could not reach DATABASE_URL: ${String(error)}`,
    );
  }

  const owner = await factories.createUser();
  ownerIds.push(owner.id);
  const drive = await factories.createDrive(owner.id);
  const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Binding Agent' });
  agentPageId = agentPage.id;
});

afterAll(async () => {
  if (ownerIds.length > 0) {
    await db.delete(users).where(inArray(users.id, ownerIds));
  }
});

describe('a conversation already shown by a node in ANOTHER workspace', () => {
  // -------------------------------------------------------------------------
  // 1. The pre-flight — the fact no workspace-scoped read holds
  // -------------------------------------------------------------------------

  it('readChatTargetHolders finds the holder across the whole table, not just one workspace', async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const conversationId = await createConversation();
    await seedTree(workspaceA, [root, chatPane('pane-a', 0, conversationId)]);
    await seedTree(workspaceB, [root]);

    // B's own snapshot knows nothing about it — which is exactly why
    // `validateTree`, whose input this is, cannot settle the rule.
    const snapshotB = await readWorkspaceNodeSnapshot(db, workspaceB);
    expect(snapshotB.nodes.map((node) => node.id)).toEqual(['root']);

    const holders = await readChatTargetHolders(db, [conversationId]);
    expect(holders).toEqual([{ rootId: workspaceA, nodeId: 'pane-a', targetId: conversationId }]);
  });

  it('refuses the write with a typed code AND the truth to rebase against — never a 502', async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    // Owned by the acting user, so the ACL gate passes and the ONLY thing left
    // standing between this write and a raw index violation is the pre-flight.
    const conversationId = await createConversation();
    await seedTree(workspaceA, [root, chatPane('pane-a', 0, conversationId)]);
    await seedTree(workspaceB, [root]);

    const before = await readWorkspaceNodeSnapshot(db, workspaceB);
    const result = await applyWorkspaceNodeWrite({
      workspaceId: workspaceB,
      baseRev: before.rev,
      put: [chatPane('pane-stolen', 0, conversationId)],
      drop: [],
      viewerId: ownerIds[0],
    });

    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.code).toBe('target_already_shown');
    expect(result.detail).toContain(conversationId);
    // The rebase body. Without these two the client cannot clear its optimistic
    // pane, which is the actual damage this whole fix is about.
    expect(result.snapshot.rev).toBe(before.rev);
    expect(result.snapshot.nodes.map((node) => node.id)).toEqual(['root']);
    expect(Array.isArray(result.snapshot.targets)).toBe(true);

    // Nothing was written, in either workspace.
    const afterB = await readWorkspaceNodeSnapshot(db, workspaceB);
    expect(afterB.rev).toBe(before.rev);
    expect(afterB.nodes.map((node) => node.id)).toEqual(['root']);
    // Sorted: row order out of Postgres is not a promise, and the claim here is
    // membership — the holder's workspace is untouched — not an ordering.
    const afterA = await readWorkspaceNodeSnapshot(db, workspaceA);
    expect(afterA.nodes.map((node) => node.id).sort()).toEqual(['pane-a', 'root']);
  });

  it('lets an UNCLAIMED conversation through, so the refusal is about the binding and not the kind', async () => {
    const workspaceB = await createWorkspace();
    const conversationId = await createConversation();
    await seedTree(workspaceB, [root]);

    const before = await readWorkspaceNodeSnapshot(db, workspaceB);
    const result = await applyWorkspaceNodeWrite({
      workspaceId: workspaceB,
      baseRev: before.rev,
      put: [chatPane('pane-ok', 0, conversationId)],
      drop: [],
      viewerId: ownerIds[0],
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.changed).toBe(true);
    expect(result.snapshot.nodes.map((node) => node.id)).toEqual(['root', 'pane-ok']);
  });

  // -------------------------------------------------------------------------
  // 2. The backstop — the constraint name the DATABASE reports
  // -------------------------------------------------------------------------

  it('the index Postgres raises is the one the detector names', async () => {
    // Triggered DIRECTLY, past the pre-flight, because the TOCTOU window this
    // guards cannot be produced through the funnel by construction: two writers
    // pass the pre-flight concurrently and one loses at the index. What has to
    // be pinned is the identity of that error, and a mock of it proves only that
    // the test and the code agree on a string.
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const conversationId = await createConversation();
    await seedTree(workspaceA, [root, chatPane('pane-a', 0, conversationId)]);
    await seedTree(workspaceB, [root]);

    const raised = await writeWorkspaceNodes(db, {
      workspaceId: workspaceB,
      write: { put: [chatPane('pane-race', 0, conversationId)], drop: [] },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(raised).not.toBeNull();
    expect(isChatTargetUniqueViolation(raised)).toBe(true);
  });

  it('ACCEPTS a hand-off within one workspace — the ordering fault the release closed', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and its own comment asked whoever
    // changed it to say so here. A payload that hands a conversation this
    // workspace already holds to a second node in the same `put` produces a
    // valid tree — one node shows it — so `validateTree` passes and the
    // pre-flight skips it because the target is not being INTRODUCED. But the
    // store's single upsert set the taker before it cleared the holder, and a
    // partial unique index is checked per row rather than at end of statement,
    // so a legal write was refused mid-statement. The old test pinned that
    // refusal as "the behaviour today, not the end state".
    //
    // `writeWorkspaceNodes` now RELEASES the chat bindings of every node it is
    // about to restate before the upsert restates them, so the index never sees
    // the pair. The backstop it used to reach is still there and still tested —
    // by the cross-workspace race above, which is the case no ordering inside
    // one workspace can fix.
    const workspaceId = await createWorkspace();
    const conversationId = await createConversation();
    await seedTree(workspaceId, [
      root,
      chatPane('holder', 0, conversationId),
      { nodeType: 'pane', id: 'taker', parentId: 'root', position: 1, target: null },
    ]);

    const before = await readWorkspaceNodeSnapshot(db, workspaceId);
    const result = await applyWorkspaceNodeWrite({
      workspaceId,
      baseRev: before.rev,
      put: [
        chatPane('taker', 1, conversationId),
        { nodeType: 'pane', id: 'holder', parentId: 'root', position: 0, target: null },
      ],
      drop: [],
      viewerId: ownerIds[0],
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const after = await readWorkspaceNodeSnapshot(db, workspaceId);
    const holder = after.nodes.find((node) => node.nodeType === 'pane' && node.target?.id === conversationId);
    expect(holder?.id).toBe('taker');
    // And exactly one node holds it — the rule the index states, still stated.
    expect(
      after.nodes.filter((node) => node.nodeType === 'pane' && node.target?.id === conversationId),
    ).toHaveLength(1);
  });

  it('does NOT claim the single-root index, which raises the very same sqlstate', async () => {
    // The reason the detector matches on the constraint NAME and not on `23505`:
    // this is a structurally broken workspace, and reporting it as "that
    // conversation is shown elsewhere" would send a client rebasing over a fault
    // that has nothing to do with a conversation.
    const workspaceA = await createWorkspace();
    await seedTree(workspaceA, [root]);

    const raised = await writeWorkspaceNodes(db, {
      workspaceId: workspaceA,
      write: {
        put: [{ nodeType: 'root', id: 'root-2', parentId: null, position: 0, axis: 'row' }],
        drop: [],
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(raised).not.toBeNull();
    // Same sqlstate, different index — and the detector says no.
    expect(String(raised)).not.toContain(CHAT_TARGET_UNIQUE_INDEX);
    expect(isChatTargetUniqueViolation(raised)).toBe(false);
  });
});

describe('moving a conversation between nodes that BOTH survive the write', () => {
  /**
   * The store's write order, end to end, for the one shape a delete cannot
   * help with.
   *
   * `writeWorkspaceNodes` deletes before it upserts, which frees whatever a
   * removed node was holding. But a write that hands a conversation from one
   * node to another while KEEPING BOTH has an empty `drop` — so the upsert is
   * the only statement, and a partial unique index is checked as each row is
   * written rather than at end of statement. Without the release step this is a
   * duplicate-key error on a tree that is perfectly valid, and a swap has no row
   * order that avoids it.
   *
   * `packages/db/src/__tests__/agent-workspace-nodes-chat-index.test.ts` pins the
   * index behaviour itself, on raw SQL. This pins that THIS FUNCTION respects
   * it — remove the release from `writeWorkspaceNodes` and these two go red.
   *
   * Found in review of PR #2378 (CodeRabbit).
   */
  it('SWAPS two conversations in one write', async () => {
    const workspaceId = await createWorkspace();
    const convA = await createConversation();
    const convB = await createConversation();
    await seedTree(workspaceId, [root, chatPane('n1', 0, convA), chatPane('n2', 1, convB)]);

    await writeWorkspaceNodes(db, {
      workspaceId,
      write: { put: [chatPane('n1', 0, convB), chatPane('n2', 1, convA)], drop: [] },
    });

    const { nodes } = await readWorkspaceNodeSnapshot(db, workspaceId);
    const bound = nodes
      .filter((node): node is Extract<WorkspaceNode, { nodeType: 'pane' }> => node.nodeType === 'pane')
      .map((node) => [node.id, node.target?.id] as const)
      .sort(([a], [b]) => a.localeCompare(b));

    expect(bound).toEqual([
      ['n1', convB],
      ['n2', convA],
    ]);
  });

  it('hands a conversation to a node that stays, unbinding the one that had it', async () => {
    const workspaceId = await createWorkspace();
    const conv = await createConversation();
    await seedTree(workspaceId, [
      root,
      chatPane('n1', 0, conv),
      { nodeType: 'pane', id: 'n2', parentId: 'root', position: 1, target: null },
    ]);

    await writeWorkspaceNodes(db, {
      workspaceId,
      write: {
        // ORDER MATTERS IN THIS ARRAY, which is why the taker is first. A
        // per-row unique index is satisfied by luck when the releasing node
        // happens to be written before the taking one, and this test passed
        // with the release disabled until the entries were swapped — so as
        // written before, it guarded nothing. Taker first is the order that can
        // only succeed because the release ran.
        put: [
          chatPane('n2', 1, conv),
          { nodeType: 'pane', id: 'n1', parentId: 'root', position: 0, target: null },
        ],
        drop: [],
      },
    });

    const { nodes } = await readWorkspaceNodeSnapshot(db, workspaceId);
    const holder = nodes.find((node) => node.nodeType === 'pane' && node.target?.id === conv);
    expect(holder?.id).toBe('n2');
  });
});

describe('a workspace the backfill has not reached yet', () => {
  /**
   * THE UN-BACKFILLED REFUSAL, against a real database, because the whole
   * question is what a JOIN across two tables says and no fake can answer it.
   *
   * This release ships the node tables but NOT the drop of the old membership
   * columns — they stage separately, after the backfill. In that window a
   * database can hold membership only `conversations.workspaceId` records.
   *
   * Reading such a workspace shows it empty, and that is recoverable: the
   * backfill fills it in. Writing to it is not. `loadAlreadyMigrated` in
   * `scripts/backfill-agent-workspace-nodes.ts` skips any workspace holding ANY
   * node row, so one seeded root strands that workspace's real membership for
   * good — and it is then counted `alreadyMigrated`, so the census that gates
   * the rollout calls the run clean. The failure hides from its own gate.
   *
   * Three states have to stay distinguishable, and all three are here: a fresh
   * deployment with no legacy rows at all, a workspace the backfill has already
   * done, and one it has not.
   */
  async function legacyMember(workspaceId: string): Promise<string> {
    const conversationId = await createConversation();
    await db
      .update(conversations)
      .set({ workspaceId, closedInWorkspaceAt: null })
      .where(eq(conversations.id, conversationId));
    return conversationId;
  }

  it('REFUSES the seed, rather than stranding the membership it cannot see', async () => {
    const workspaceId = await createWorkspace();
    await legacyMember(workspaceId);

    const before = await readWorkspaceNodeSnapshot(db, workspaceId);
    expect(before.nodes).toEqual([]);

    const result = await applyWorkspaceNodeWrite({
      workspaceId,
      baseRev: before.rev,
      put: [{ nodeType: 'pane', id: 'p1', parentId: rootSeedFor(workspaceId).id, position: 0, target: null }],
      drop: [],
      viewerId: ownerIds[0],
    });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('awaiting_backfill');

    // And it wrote NOTHING — the point of refusing rather than warning.
    const after = await readWorkspaceNodeSnapshot(db, workspaceId);
    expect(after.nodes).toEqual([]);
  });

  it('ALLOWS a workspace with no legacy membership at all — a fresh deployment is not un-backfilled', async () => {
    // The distinction the guard has to get right. A brand-new install has zero
    // conversations naming a workspace through the old column, so the predicate
    // is false and the seed proceeds exactly as it always did.
    const workspaceId = await createWorkspace();
    const conversationId = await createConversation();

    const before = await readWorkspaceNodeSnapshot(db, workspaceId);
    const result = await applyWorkspaceNodeWrite({
      workspaceId,
      baseRev: before.rev,
      put: [
        {
          nodeType: 'pane',
          id: 'p1',
          parentId: rootSeedFor(workspaceId).id,
          position: 0,
          target: { kind: 'chat', id: conversationId },
        },
      ],
      drop: [],
      viewerId: ownerIds[0],
    });

    expect(result.status).toBe('ok');
  });

  it('REFUSES on a stale legacy pointer too — the question is whether the backfill RAN, not whether anything is strandable this instant', async () => {
    // THIS TEST ASSERTED THE OPPOSITE under the old predicate, which asked "is
    // there something to strand right now" and answered no, because the
    // conversation's node already lives in another workspace.
    //
    // The predicate asks a different question now — "has the backfill been
    // through this workspace" — and for this one it has not. That is the point:
    // a workspace is not safe to seed because the first legacy row you look at
    // happens to be accounted for. The backfill will visit it, derive at least a
    // root, and write the rev row that clears this refusal.
    const stale = await createWorkspace();
    const holder = await createWorkspace();
    const conversationId = await legacyMember(stale);
    await seedTree(holder, [root, chatPane('n1', 0, conversationId)]);

    const before = await readWorkspaceNodeSnapshot(db, stale);
    const result = await applyWorkspaceNodeWrite({
      workspaceId: stale,
      baseRev: before.rev,
      put: [{ nodeType: 'pane', id: 'p1', parentId: rootSeedFor(stale).id, position: 0, target: null }],
      drop: [],
      viewerId: ownerIds[0],
    });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('awaiting_backfill');
  });

  it('ALLOWS a workspace whose legacy member ALREADY has a node — the backfill got here', async () => {
    // The other side: the old column still says what it always said, but the
    // membership has a node, so there is nothing left to strand.
    const workspaceId = await createWorkspace();
    const conversationId = await legacyMember(workspaceId);
    await seedTree(workspaceId, [root, chatPane('n1', 0, conversationId)]);

    const before = await readWorkspaceNodeSnapshot(db, workspaceId);
    const result = await applyWorkspaceNodeWrite({
      workspaceId,
      baseRev: before.rev,
      put: [{ nodeType: 'pane', id: 'n2', parentId: 'root', position: 1, target: null }],
      drop: [],
      viewerId: ownerIds[0],
    });

    expect(result.status).toBe('ok');
  });
  it('REFUSES an ENDED workspace, because ending is not terminal and the backfill now covers it', async () => {
    // THE SECOND INVERSION, and the one that matters most. This test used to
    // assert the opposite, on the reasoning that the backfill skipped ended
    // workspaces so there was nothing left to strand.
    //
    // A review refuted it: the very write the exemption permitted is the one
    // that UN-ENDS the workspace. Claiming a thread into an ended workspace runs
    // `planSessionReopen`, which clears `endedAt` — so the exemption minted a
    // rev row, permanently disarmed this guard, and the backfill then reported
    // the workspace `alreadyMigrated` while its real membership was stranded
    // for good, with the census exiting 0 over it.
    //
    // The fix was not a better exemption. `backfill()` no longer filters on
    // `endedAt` at all, so the guard needs none and its scope is the drop's
    // scope.
    const workspaceId = await createWorkspace();
    await legacyMember(workspaceId);
    await db.update(agentWorkspaces).set({ endedAt: new Date() }).where(eq(agentWorkspaces.id, workspaceId));

    const before = await readWorkspaceNodeSnapshot(db, workspaceId);
    const result = await applyWorkspaceNodeWrite({
      workspaceId,
      baseRev: before.rev,
      put: [{ nodeType: 'pane', id: 'p1', parentId: rootSeedFor(workspaceId).id, position: 0, target: null }],
      drop: [],
      viewerId: ownerIds[0],
    });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('awaiting_backfill');
  });

  it('REFUSES a workspace whose only legacy membership is a PANE ROW, not a conversation pointer', async () => {
    // The other half of the same review finding. The backfill derives nodes from
    // panes ∪ conversations ∪ shells; the predicate used to look only at
    // `conversations.workspaceId`, so a workspace whose membership lived in a
    // pane row sailed through, got seeded, and was then counted
    // `alreadyMigrated` by the run that should have rescued it.
    const workspaceId = await createWorkspace();
    const conversationId = await createConversation();
    await db.execute(sql`
      INSERT INTO "agent_workspace_pane_columns" ("id","workspaceId","orderIndex","widthFraction","createdAt","updatedAt")
      VALUES (${'col-' + workspaceId}, ${workspaceId}, 0, 1, now(), now())
    `);
    await db.execute(sql`
      INSERT INTO "agent_workspace_panes" ("id","workspaceId","columnId","orderIndex","kind","targetId","heightFraction","createdAt","updatedAt")
      VALUES (${'pane-' + workspaceId}, ${workspaceId}, ${'col-' + workspaceId}, 0, 'chat', ${conversationId}, 1, now(), now())
    `);

    const before = await readWorkspaceNodeSnapshot(db, workspaceId);
    const result = await applyWorkspaceNodeWrite({
      workspaceId,
      baseRev: before.rev,
      put: [{ nodeType: 'pane', id: 'p1', parentId: rootSeedFor(workspaceId).id, position: 0, target: null }],
      drop: [],
      viewerId: ownerIds[0],
    });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('awaiting_backfill');
  });

  it('ALLOWS a backfilled workspace whose tree was later DESTROYED by endSession (F2)', async () => {
    // The regression that made this predicate wrong. `endSession` destroys the
    // whole tree, so a correctly-migrated workspace drops to zero nodes and the
    // old predicate — "is there a legacy row with no node" — flipped back to
    // true and refused every subsequent write. On a perfectly migrated
    // database, with no legacy data involved in the failure at all.
    //
    // The rev row is what makes the answer monotonic: the backfill writes it in
    // the same transaction as the nodes, and `destroy` never deletes it.
    const workspaceId = await createWorkspace();
    const conversationId = await legacyMember(workspaceId);
    await seedTree(workspaceId, [root, chatPane('n1', 0, conversationId)]);

    await destroyWorkspaceTree({ workspaceId, actingUserId: ownerIds[0] });
    const emptied = await readWorkspaceNodeSnapshot(db, workspaceId);
    expect(emptied.nodes).toEqual([]);

    const result = await applyWorkspaceNodeWrite({
      workspaceId,
      baseRev: emptied.rev,
      put: [{ nodeType: 'pane', id: 'p1', parentId: rootSeedFor(workspaceId).id, position: 0, target: null }],
      drop: [],
      viewerId: ownerIds[0],
    });

    expect(result.status).toBe('ok');
  });

  it('ALLOWS when the only legacy member is DISMISSED — the backfill mints it no node either (F4)', async () => {
    // `closedInWorkspaceAt IS NULL` is not decoration. The backfill does not
    // give dismissed threads a node, so counting one would make the predicate
    // permanently true and no backfill run could ever clear it — every
    // workspace in which a user once closed a thread, refused forever.
    const workspaceId = await createWorkspace();
    const conversationId = await legacyMember(workspaceId);
    await db
      .update(conversations)
      .set({ closedInWorkspaceAt: new Date() })
      .where(eq(conversations.id, conversationId));

    const before = await readWorkspaceNodeSnapshot(db, workspaceId);
    const result = await applyWorkspaceNodeWrite({
      workspaceId,
      baseRev: before.rev,
      put: [{ nodeType: 'pane', id: 'p1', parentId: rootSeedFor(workspaceId).id, position: 0, target: null }],
      drop: [],
      viewerId: ownerIds[0],
    });

    expect(result.status).toBe('ok');
  });

  it('ALLOWS when the only legacy member is HISTORY-DELETED — same reason (F4)', async () => {
    const workspaceId = await createWorkspace();
    const conversationId = await legacyMember(workspaceId);
    await db.update(conversations).set({ isActive: false }).where(eq(conversations.id, conversationId));

    const before = await readWorkspaceNodeSnapshot(db, workspaceId);
    const result = await applyWorkspaceNodeWrite({
      workspaceId,
      baseRev: before.rev,
      put: [{ nodeType: 'pane', id: 'p1', parentId: rootSeedFor(workspaceId).id, position: 0, target: null }],
      drop: [],
      viewerId: ownerIds[0],
    });

    expect(result.status).toBe('ok');
  });
});
