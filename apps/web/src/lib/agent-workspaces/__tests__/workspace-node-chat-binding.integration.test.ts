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
import { inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { conversations } from '@pagespace/db/schema/conversations';
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

const { applyWorkspaceNodeWrite } = await import('../workspace-node-runtime');

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

/** A conversation owned by the acting user and bound to `workspaceId`. */
async function createConversation(workspaceId: string | null): Promise<string> {
  const id = createId();
  await db.insert(conversations).values({
    id,
    userId: ownerIds[0],
    type: 'page',
    contextId: agentPageId,
    workspaceId,
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

describe('a conversation already shown by a node in ANOTHER workspace', () => {
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

  // -------------------------------------------------------------------------
  // 1. The pre-flight — the fact no workspace-scoped read holds
  // -------------------------------------------------------------------------

  it('readChatTargetHolders finds the holder across the whole table, not just one workspace', async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const conversationId = await createConversation(workspaceA);
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
    const conversationId = await createConversation(workspaceA);
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
    const conversationId = await createConversation(workspaceB);
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
    const conversationId = await createConversation(workspaceA);
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

  it('catches the WITHIN-workspace ordering fault too, which the pre-flight by design does not', async () => {
    // A payload that hands a conversation THIS workspace already holds to a
    // second node in the same `put`. The result tree is valid — one node shows
    // it — so `validateTree` passes; the pre-flight skips it because the target
    // is not being INTRODUCED; and the store's single upsert statement sets the
    // taker before it clears the holder, so the non-deferrable index fires
    // mid-statement. Unreachable from the algebra (a binding is for life) and
    // reachable from a hand-assembled payload, which is what this route accepts.
    //
    // The backstop is the only thing standing between that and a 502. It is
    // pinned here because it is the behaviour today, not because it is the end
    // state: this refusal is STABLE rather than transient, so a client that
    // rebases and re-sends the same payload gets the same answer. Closing it
    // properly means releasing a chat target in a statement before the one that
    // takes it — a change to the store's write, reported rather than smuggled in
    // here. Whoever makes it should expect this test to need updating.
    const workspaceId = await createWorkspace();
    const conversationId = await createConversation(workspaceId);
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

    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.code).toBe('target_already_shown');
    // No id is named: nothing was INTRODUCED, so the backstop has nothing to
    // name and says the fact instead of guessing.
    expect(result.detail).toBe(
      'the database refused this write: a conversation cannot be shown by two nodes at once',
    );
    expect(result.snapshot.rev).toBe(before.rev);
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
