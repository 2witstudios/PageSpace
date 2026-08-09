/**
 * MEMBERSHIP UNDER REAL CONCURRENCY — the properties a mocked DB cannot prove.
 *
 * Three of them, and each has moved to a different enforcement mechanism than
 * the version this suite replaces:
 *
 *  1. **The cap.** It used to be a `SELECT count(*)` over
 *     `conversations.workspaceId` serialized by a dedicated advisory lock that
 *     create, close and reopen each had to remember to take. It is now a count
 *     over the workspace's TREE inside the same transaction that writes the
 *     tree, under the lock that write already takes — so "did the lock actually
 *     serialize two concurrent transactions" is still the question, but there is
 *     only one lock left to get wrong.
 *  2. **The write-once binding.** It used to be `workspaceId IS NULL` in a
 *     guarded UPDATE. It is now `agent_workspace_nodes_chat_target_idx`, a
 *     GLOBAL unique index — which is what lets two claims into two DIFFERENT
 *     workspaces be serialized at all, since two workspaces take two different
 *     locks and the lock therefore provides no mutual exclusion between them.
 *  3. **The ghost.** A conversation row that landed while its membership did
 *     not. It is now unrepresentable, because both are one transaction — and
 *     the test for it is the one that fails the create and looks for the row.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable — a
 * silent skip would be a green, zero-assertion pass. Local runs without Docker
 * opt out explicitly with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, and, isNull, count } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { agentWorkspaceNodes } from '@pagespace/db/schema/agent-workspace-nodes';
import { conversations } from '@pagespace/db/schema/conversations';
import { factories } from '@pagespace/db/test/factories';
import { MAX_SESSION_CONVERSATIONS } from '@pagespace/lib/agent-workspaces/plan-spawn-worker';
import {
  claimConversationInSession,
  closeConversationInSession,
  createConversationInSession,
  findWorkspaceOfConversation,
  reopenConversationInSession,
  ensureGlobalSandboxSession,
  MAX_ACTIVE_SESSIONS_PER_OWNER,
} from '../agent-workspaces-runtime';
import { SessionFullError } from '../create-conversation-in-workspace';
import { requireDb } from '@pagespace/db/test/require-db';

let dbAvailable = false;

async function connect(): Promise<void> {
  try {
    await db.select().from(pages).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('agent-workspaces-runtime.integration.test.ts', error);
    dbAvailable = false;
  }
}

/** How many conversations this workspace HOLDS — the membership count, from the tree. */
async function memberCountFor(workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(agentWorkspaceNodes)
    .where(
      and(eq(agentWorkspaceNodes.rootId, workspaceId), eq(agentWorkspaceNodes.targetKind, 'chat')),
    );
  return row?.n ?? 0;
}

/** The node bound to a conversation, wherever it is. At most one, by the unique index. */
async function nodeFor(conversationId: string) {
  const [row] = await db
    .select()
    .from(agentWorkspaceNodes)
    .where(
      and(eq(agentWorkspaceNodes.targetKind, 'chat'), eq(agentWorkspaceNodes.targetId, conversationId)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Fill a workspace to `n` members without going through the create path — this
 * suite is about the cap's serialization, not about creation.
 *
 * The ROOT comes with them, deliberately: `validateTree` calls a workspace with
 * members and no root `no_root`, so a filler that skipped it would make every
 * later write fail for a reason that has nothing to do with the test.
 */
async function fillWorkspace(
  workspaceId: string,
  ownerId: string,
  agentPageId: string,
  n: number,
): Promise<void> {
  const rootId = createId();
  await db.insert(agentWorkspaceNodes).values({
    id: rootId,
    rootId: workspaceId,
    parentId: null,
    position: 0,
    nodeType: 'root',
    axis: 'row',
    updatedAt: new Date(),
  });
  if (n === 0) return;

  const rows = Array.from({ length: n }, () => ({ id: createId(), conversationId: createId() }));
  await db.insert(conversations).values(
    rows.map((row) => ({
      id: row.conversationId,
      userId: ownerId,
      type: 'page' as const,
      contextId: agentPageId,
      isActive: true,
    })),
  );
  await db.insert(agentWorkspaceNodes).values(
    rows.map((row, index) => ({
      id: row.id,
      rootId: workspaceId,
      // UNDER THE ROOT. These were seeded PARKED — `parentId: null` — because a
      // member off the grid still counted toward the cap. There is one place a
      // node can be, so a parked filler would seed rows the read path now
      // refuses (`null_parent`), and every write against this workspace would
      // fail for a reason that has nothing to do with the test.
      parentId: rootId,
      position: index,
      nodeType: 'pane' as const,
      targetKind: 'chat' as const,
      targetId: row.conversationId,
      updatedAt: new Date(),
    })),
  );
}

async function seedWorkspace(title: string) {
  const owner = await factories.createUser();
  const drive = await factories.createDrive(owner.id);
  const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title });
  const [workspace] = await db
    .insert(agentWorkspaces)
    .values({ id: createId(), driveId: drive.id, ownerId: owner.id })
    .returning();
  return { owner, drive, agentPage, workspace };
}

describe('the cap is a property of the tree, enforced by the write that changes it', () => {
  beforeAll(connect);

  it("two creates racing for the workspace's LAST slot: exactly one wins, the count never exceeds the cap", async () => {
    if (!dbAvailable) return;
    const { owner, agentPage, workspace } = await seedWorkspace('Race Agent');
    await fillWorkspace(workspace.id, owner.id, agentPage.id, MAX_SESSION_CONVERSATIONS - 1);
    expect(await memberCountFor(workspace.id)).toBe(MAX_SESSION_CONVERSATIONS - 1);

    const [first, second] = await Promise.allSettled([
      createConversationInSession({
        conversationId: createId(),
        userId: owner.id,
        agentPageId: agentPage.id,
        workspaceId: workspace.id,
      }),
      createConversationInSession({
        conversationId: createId(),
        userId: owner.id,
        agentPageId: agentPage.id,
        workspaceId: workspace.id,
      }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(rejected).toHaveLength(1);
    // Refused for the RIGHT reason — a lock timeout or a driver fault masking
    // the cap would otherwise pass this test while proving nothing.
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SessionFullError);

    expect(await memberCountFor(workspace.id)).toBe(MAX_SESSION_CONVERSATIONS);
  }, 20_000);

  it("a claim racing a create for the LAST slot: exactly one wins", async () => {
    if (!dbAvailable) return;
    const { owner, agentPage, workspace } = await seedWorkspace('Claim-vs-Create Race');
    await fillWorkspace(workspace.id, owner.id, agentPage.id, MAX_SESSION_CONVERSATIONS - 1);

    const claimable = createId();
    await db.insert(conversations).values({
      id: claimable,
      userId: owner.id,
      type: 'page',
      contextId: agentPage.id,
      isActive: true,
    });

    const [createResult, claimResult] = await Promise.allSettled([
      createConversationInSession({
        conversationId: createId(),
        userId: owner.id,
        agentPageId: agentPage.id,
        workspaceId: workspace.id,
      }),
      claimConversationInSession({ conversationId: claimable, userId: owner.id, workspaceId: workspace.id }),
    ]);

    const isRefused = (o: PromiseSettledResult<unknown>) =>
      o.status === 'rejected' || (o.status === 'fulfilled' && o.value === 'session_full');
    expect([createResult, claimResult].filter(isRefused)).toHaveLength(1);
    // Unlike create, a claim never REJECTS for the cap — it RETURNS
    // 'session_full', so a claim rejecting for an unrelated reason would
    // silently pass `isRefused` without this.
    expect(claimResult.status).toBe('fulfilled');

    expect(await memberCountFor(workspace.id)).toBe(MAX_SESSION_CONVERSATIONS);
  }, 20_000);

  it('CLOSING frees a cap slot, and reopening consumes one again', async () => {
    if (!dbAvailable) return;
    // The behaviour changed TWICE, and this is the second change. Under the
    // column model a reopen restored a listing slot the close had freed, so a
    // reopen into a full workspace was refused. Under the parked model neither
    // act touched the count, because a closed thread never stopped being a
    // member — so the refusal went away. Closing DESTROYS the node now, so the
    // count moves again: a close frees a slot and a reopen takes one, which is
    // the same rule every other admission follows.
    const { owner, agentPage, workspace } = await seedWorkspace('Reopen At Cap');
    await fillWorkspace(workspace.id, owner.id, agentPage.id, MAX_SESSION_CONVERSATIONS);

    const [member] = await db
      .select({ targetId: agentWorkspaceNodes.targetId })
      .from(agentWorkspaceNodes)
      .where(
        and(eq(agentWorkspaceNodes.rootId, workspace.id), eq(agentWorkspaceNodes.targetKind, 'chat')),
      )
      .limit(1);
    const conversationId = member.targetId as string;

    expect(await closeConversationInSession({ conversationId, userId: owner.id, workspaceId: workspace.id })).toBe(
      'closed',
    );
    expect(await memberCountFor(workspace.id)).toBe(MAX_SESSION_CONVERSATIONS - 1);

    expect(
      await reopenConversationInSession({ conversationId, userId: owner.id, workspaceId: workspace.id }),
    ).toBe('reopened');
    expect(await memberCountFor(workspace.id)).toBe(MAX_SESSION_CONVERSATIONS);
  }, 20_000);

  it('refuses a reopen into a workspace that refilled the slot while the thread was closed', async () => {
    if (!dbAvailable) return;
    const { owner, agentPage, workspace } = await seedWorkspace('Reopen Refilled');
    await fillWorkspace(workspace.id, owner.id, agentPage.id, MAX_SESSION_CONVERSATIONS);

    const [member] = await db
      .select({ targetId: agentWorkspaceNodes.targetId })
      .from(agentWorkspaceNodes)
      .where(
        and(eq(agentWorkspaceNodes.rootId, workspace.id), eq(agentWorkspaceNodes.targetKind, 'chat')),
      )
      .limit(1);
    const conversationId = member.targetId as string;

    await closeConversationInSession({ conversationId, userId: owner.id, workspaceId: workspace.id });
    // Somebody else takes the freed slot.
    await createConversationInSession({
      conversationId: createId(),
      userId: owner.id,
      agentPageId: agentPage.id,
      workspaceId: workspace.id,
    });

    // Refused, and the refusal is the CAP's — collapsed to the one answer this
    // route gives for "you cannot have this back", the same shape a nonexistent
    // id gets.
    expect(
      await reopenConversationInSession({ conversationId, userId: owner.id, workspaceId: workspace.id }),
    ).toBe('not_in_session');
    expect(await memberCountFor(workspace.id)).toBe(MAX_SESSION_CONVERSATIONS);
  }, 20_000);
});

describe('the write-once binding is the unique index, not a WHERE clause', () => {
  beforeAll(connect);

  it('two concurrent claims of ONE conversation into TWO workspaces: exactly one wins, though the two take different locks', async () => {
    if (!dbAvailable) return;
    const { owner, drive, agentPage, workspace: workspaceA } = await seedWorkspace('Claim Race Agent');
    const [workspaceB] = await db
      .insert(agentWorkspaces)
      .values({ id: createId(), driveId: drive.id, ownerId: owner.id })
      .returning();
    await fillWorkspace(workspaceA.id, owner.id, agentPage.id, 0);
    await fillWorkspace(workspaceB.id, owner.id, agentPage.id, 0);

    const conversationId = createId();
    await db.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      type: 'page',
      contextId: agentPage.id,
      isActive: true,
    });

    const [resultA, resultB] = await Promise.all([
      claimConversationInSession({ conversationId, userId: owner.id, workspaceId: workspaceA.id }),
      claimConversationInSession({ conversationId, userId: owner.id, workspaceId: workspaceB.id }),
    ]);

    // The workspace lock is keyed PER WORKSPACE, so A and B take different keys
    // and it provides no mutual exclusion between these two calls at all. The
    // global `UNIQUE (targetId) WHERE targetKind = 'chat'` is the only thing
    // serializing this — which is exactly the job `workspaceId IS NULL` used to
    // do, moved into a constraint no future writer can forget.
    const outcomes = [resultA, resultB];
    expect(outcomes.filter((o) => o === 'claimed')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'not_found')).toHaveLength(1);

    const node = await nodeFor(conversationId);
    expect(node?.rootId).toBe(resultA === 'claimed' ? workspaceA.id : workspaceB.id);
  }, 20_000);

  it('two concurrent claims into the SAME workspace: one claimed, one already_in_session, exactly one node', async () => {
    if (!dbAvailable) return;
    const { owner, agentPage, workspace } = await seedWorkspace('Same-Workspace Claim Race');
    await fillWorkspace(workspace.id, owner.id, agentPage.id, 0);

    const conversationId = createId();
    await db.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      type: 'page',
      contextId: agentPage.id,
      isActive: true,
    });

    const outcomes = await Promise.all([
      claimConversationInSession({ conversationId, userId: owner.id, workspaceId: workspace.id }),
      claimConversationInSession({ conversationId, userId: owner.id, workspaceId: workspace.id }),
    ]);

    expect(outcomes.filter((o) => o === 'claimed')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'already_in_session')).toHaveLength(1);
    expect(await memberCountFor(workspace.id)).toBe(1);
  }, 20_000);

  it('a workspace deleted out from under a thread frees it to be claimed again', async () => {
    if (!dbAvailable) return;
    // The successor to the "FK-set-null residue" case. There is no column to
    // leave residue in: `agent_workspace_nodes.rootId` cascades, so deleting a
    // workspace takes its membership with it and the thread is genuinely
    // homeless rather than half-bound.
    const { owner, drive, agentPage, workspace: oldWorkspace } = await seedWorkspace('Residue Agent');
    const [newWorkspace] = await db
      .insert(agentWorkspaces)
      .values({ id: createId(), driveId: drive.id, ownerId: owner.id })
      .returning();
    await fillWorkspace(oldWorkspace.id, owner.id, agentPage.id, 0);
    await fillWorkspace(newWorkspace.id, owner.id, agentPage.id, 0);

    const conversationId = createId();
    await db.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      type: 'page',
      contextId: agentPage.id,
      isActive: true,
    });
    expect(await claimConversationInSession({ conversationId, userId: owner.id, workspaceId: oldWorkspace.id })).toBe(
      'claimed',
    );

    await db.delete(agentWorkspaces).where(eq(agentWorkspaces.id, oldWorkspace.id));
    expect(await nodeFor(conversationId)).toBeNull();
    expect(await findWorkspaceOfConversation(conversationId)).toBeNull();

    expect(await claimConversationInSession({ conversationId, userId: owner.id, workspaceId: newWorkspace.id })).toBe(
      'claimed',
    );
    expect(await memberCountFor(newWorkspace.id)).toBe(1);
  }, 20_000);
});

describe('a conversation and its membership are one transaction', () => {
  beforeAll(connect);

  it('a create refused by the cap leaves NO conversation row behind', async () => {
    if (!dbAvailable) return;
    // THE GHOST, from the other side. Under the old shape the row was inserted
    // first and bound second, so a refusal after the insert left a real thread
    // that belonged to nothing and appeared nowhere; the pre-checks existed to
    // make that rare. Here the insert is inside the membership write's
    // transaction, so a refusal takes it with it — rare stops mattering.
    const { owner, agentPage, workspace } = await seedWorkspace('Ghost Agent');
    await fillWorkspace(workspace.id, owner.id, agentPage.id, MAX_SESSION_CONVERSATIONS);

    const conversationId = createId();
    await expect(
      createConversationInSession({
        conversationId,
        userId: owner.id,
        agentPageId: agentPage.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toBeInstanceOf(SessionFullError);

    const rows = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(rows).toHaveLength(0);
    expect(await nodeFor(conversationId)).toBeNull();
  }, 20_000);

  it('a create refused because the thread is bound ELSEWHERE leaves no row behind either', async () => {
    if (!dbAvailable) return;
    const { owner, drive, agentPage, workspace: workspaceA } = await seedWorkspace('Elsewhere Agent');
    const [workspaceB] = await db
      .insert(agentWorkspaces)
      .values({ id: createId(), driveId: drive.id, ownerId: owner.id })
      .returning();
    await fillWorkspace(workspaceA.id, owner.id, agentPage.id, 0);
    await fillWorkspace(workspaceB.id, owner.id, agentPage.id, 0);

    // A conversation that exists and already has a home.
    const conversationId = createId();
    await db.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      type: 'page',
      contextId: agentPage.id,
      isActive: true,
    });
    await claimConversationInSession({ conversationId, userId: owner.id, workspaceId: workspaceA.id });

    // Creating it AGAIN into another workspace: the row already exists, so the
    // squat guard says `exists` and the anchor check passes — the only thing
    // refusing this is the global chat-target index, inside the transaction.
    await expect(
      createConversationInSession({
        conversationId,
        userId: owner.id,
        agentPageId: agentPage.id,
        workspaceId: workspaceB.id,
      }),
    ).rejects.toThrow('conversation_unavailable');

    expect((await nodeFor(conversationId))?.rootId).toBe(workspaceA.id);
    expect(await memberCountFor(workspaceB.id)).toBe(0);
  }, 20_000);

  it('a successful create writes the conversation AND its node', async () => {
    if (!dbAvailable) return;
    const { owner, agentPage, workspace } = await seedWorkspace('Pair Agent');
    const conversationId = createId();

    await createConversationInSession({
      conversationId,
      userId: owner.id,
      agentPageId: agentPage.id,
      workspaceId: workspace.id,
    });

    const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(row.isActive).toBe(true);
    // Membership lives HERE now, and nowhere else — the column is untouched.
    expect(row.workspaceId).toBeNull();
    expect((await nodeFor(conversationId))?.rootId).toBe(workspace.id);
  }, 20_000);
});

describe('every admission is PLACED — there is no unplaced membership', () => {
  beforeAll(connect);

  it('a create lands in the tree, on the grid, with a real parent', async () => {
    if (!dbAvailable) return;
    // There used to be an opt-out here (`attach: false`), which minted the node
    // PARKED — a member with no parent — so that the pane picker, which mints
    // its own pane and binds it after the POST returns, did not get a SECOND
    // pane for one thread. The placement policy fills an unbound pane before it
    // splits, so the picker's waiting pane IS what an admission lands in, and
    // the parked state that made a closed pane and a broken one identical is
    // gone with the flag.
    const { owner, agentPage, workspace } = await seedWorkspace('Gate Agent');
    const conversationId = createId();

    await createConversationInSession({
      conversationId,
      userId: owner.id,
      agentPageId: agentPage.id,
      workspaceId: workspace.id,
    });

    const node = await nodeFor(conversationId);
    expect(node?.rootId).toBe(workspace.id);
    expect(node?.parentId).not.toBeNull();
    expect(await memberCountFor(workspace.id)).toBe(1);
  }, 20_000);

  it('a create lands ON the grid — every admission is placed', async () => {
    if (!dbAvailable) return;
    const { owner, agentPage, workspace } = await seedWorkspace('Attach Agent');
    const conversationId = createId();

    await createConversationInSession({
      conversationId,
      userId: owner.id,
      agentPageId: agentPage.id,
      workspaceId: workspace.id,
      title: 'Researcher',
    });

    expect((await nodeFor(conversationId))?.parentId).not.toBeNull();
  }, 20_000);

  it('never evicts the conversation that asked for the spawn', async () => {
    if (!dbAvailable) return;
    const { owner, agentPage, workspace } = await seedWorkspace('Spawn Agent');

    const spawnerId = createId();
    await createConversationInSession({
      conversationId: spawnerId,
      userId: owner.id,
      agentPageId: agentPage.id,
      workspaceId: workspace.id,
      title: 'Caller',
    });

    const workerId = createId();
    await createConversationInSession({
      conversationId: workerId,
      userId: owner.id,
      agentPageId: agentPage.id,
      workspaceId: workspace.id,
      title: 'Researcher',
      excludeTargetId: spawnerId,
    });

    // Both on screen: the worker ADDED a surface beside the caller rather than
    // taking the caller's.
    expect((await nodeFor(spawnerId))?.parentId).not.toBeNull();
    expect((await nodeFor(workerId))?.parentId).not.toBeNull();
  }, 20_000);

  it('places at most ONE node per thread however often creation is retried', async () => {
    if (!dbAvailable) return;
    const { owner, agentPage, workspace } = await seedWorkspace('Retry Agent');
    const conversationId = createId();
    const input = {
      conversationId,
      userId: owner.id,
      agentPageId: agentPage.id,
      workspaceId: workspace.id,
      title: 'Researcher',
    };

    await createConversationInSession(input);
    // The retry must RESOLVE — swallowing a rejection here would let the count
    // stay at 1 because the retry never reached the membership write at all,
    // which is a pass for the wrong reason.
    await createConversationInSession(input);

    expect(await memberCountFor(workspace.id)).toBe(1);
  }, 20_000);

  it('closing REMOVES the node, and reopening admits a fresh one on the grid', async () => {
    if (!dbAvailable) return;
    const { owner, agentPage, workspace } = await seedWorkspace('Move Agent');
    const conversationId = createId();
    await createConversationInSession({
      conversationId,
      userId: owner.id,
      agentPageId: agentPage.id,
      workspaceId: workspace.id,
    });
    const born = await nodeFor(conversationId);
    expect(born).not.toBeNull();

    expect(await closeConversationInSession({ conversationId, userId: owner.id, workspaceId: workspace.id })).toBe(
      'closed',
    );
    // The node is GONE. Closing used to park it — same row, null parent, still a
    // member — which is the state that made a closed pane and a broken one
    // identical. The thread's history is untouched; only its membership went.
    expect(await nodeFor(conversationId)).toBeNull();
    expect(await memberCountFor(workspace.id)).toBe(0);

    expect(await reopenConversationInSession({ conversationId, userId: owner.id, workspaceId: workspace.id })).toBe(
      'reopened',
    );
    const reopened = await nodeFor(conversationId);
    // A NEW node, on the grid. Reopening is re-admitting, because a closed
    // thread is a member of nothing.
    expect(reopened).not.toBeNull();
    expect(reopened?.parentId).not.toBeNull();
    expect(await memberCountFor(workspace.id)).toBe(1);
  }, 20_000);
});

describe('ensureGlobalSandboxSession — auto-provisioning the default Global Assistant conversation', () => {
  beforeAll(connect);

  it('mints a real, ordinary workspace (driveId null) and admits a never-claimed global conversation', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const conversationId = createId();
    await db.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      type: 'global',
      contextId: null,
      isActive: true,
    });

    const result = await ensureGlobalSandboxSession(conversationId, owner.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.ownerId).toBe(owner.id);
    expect(result.session.driveId).toBeNull();
    expect((await nodeFor(conversationId))?.rootId).toBe(result.session.id);
  });

  it('given a conversation that already has a home, resolves to THAT workspace rather than failing', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const [existing] = await db
      .insert(agentWorkspaces)
      .values({ id: createId(), driveId: null, ownerId: owner.id })
      .returning();

    const conversationId = createId();
    await db.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      type: 'global',
      contextId: null,
      isActive: true,
    });
    await claimConversationInSession({ conversationId, userId: owner.id, workspaceId: existing.id });

    const result = await ensureGlobalSandboxSession(conversationId, owner.id);

    // The claim this call attempted lost (the conversation already had a home)
    // — it re-resolves through the conversation instead of failing, so a caller
    // sees the SAME outcome whether the binding happened just now (a concurrent
    // winner) or long ago (a stale pre-check).
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.id).toBe(existing.id);

    // The scratch workspace this call spawned to attempt the claim was torn
    // down rather than left sitting empty and billed forever.
    const [live] = await db
      .select({ n: count() })
      .from(agentWorkspaces)
      .where(and(eq(agentWorkspaces.ownerId, owner.id), isNull(agentWorkspaces.endedAt)));
    expect(live.n).toBe(1);
  });

  it("two concurrent calls for ONE never-bound conversation converge on ONE workspace", async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const conversationId = createId();
    await db.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      type: 'global',
      contextId: null,
      isActive: true,
    });

    const [a, b] = await Promise.all([
      ensureGlobalSandboxSession(conversationId, owner.id),
      ensureGlobalSandboxSession(conversationId, owner.id),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Both callers end up pointed at the SAME sandbox — the shared-workspace
    // invariant a per-conversation sandbox would violate.
    expect(a.session.id).toBe(b.session.id);
    expect((await nodeFor(conversationId))?.rootId).toBe(a.session.id);

    const [live] = await db
      .select({ n: count() })
      .from(agentWorkspaces)
      .where(and(eq(agentWorkspaces.ownerId, owner.id), isNull(agentWorkspaces.endedAt)));
    expect(live.n).toBe(1);
  });

  it('given the owner is already at the active-workspace cap, fails with session_limit_reached', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    await db.insert(agentWorkspaces).values(
      Array.from({ length: MAX_ACTIVE_SESSIONS_PER_OWNER }, () => ({
        id: createId(),
        driveId: null,
        ownerId: owner.id,
      })),
    );

    const conversationId = createId();
    await db.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      type: 'global',
      contextId: null,
      isActive: true,
    });

    const result = await ensureGlobalSandboxSession(conversationId, owner.id);
    expect(result).toEqual({ ok: false, reason: 'session_limit_reached' });
    expect(await nodeFor(conversationId)).toBeNull();
  });
});
