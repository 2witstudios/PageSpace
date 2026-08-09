/**
 * `countOpenConversations` — THE membership count, against a REAL Postgres.
 *
 * The predicate it executes has gone from a three-column conjunction over
 * `conversations`
 *
 *   workspaceId = $1 AND isActive = true AND closedInWorkspaceAt IS NULL
 *
 * to one over the node table
 *
 *   rootId = $1 AND targetKind = 'chat' AND targetId IS NOT NULL
 *
 * and the shrinkage is the whole point of this leaf: membership was three facts
 * that had to be kept in agreement at four call sites, and it is now one row.
 * The two clauses that disappeared did not become someone else's job — they
 * stopped existing. A history-deleted thread has its NODE removed by the delete
 * (`expelConversationFromSession`), and so does a CLOSED one: closing is the
 * same single removal, not a move to somewhere off the screen.
 *
 * An earlier cut of this model let a closed thread keep a parentless node and
 * stay a member, and this suite pinned that. It is gone — a member is somewhere
 * or is not a member — so closing frees a cap slot again and reopening is an
 * ordinary admission that consumes one.
 *
 * It also pins the `executor` parameter, which exists so a caller holding its
 * own connection is counted ON THAT CONNECTION rather than having this module
 * reach for the shared pool underneath it — the property the membership write
 * depends on, and one no mock can express.
 *
 * Requires DATABASE_URL → a Postgres with migrations applied. Deliberately
 * does NOT skip when the database is unreachable: a silently-skipping cap test
 * is indistinguishable from no cap test at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { agentWorkspaceNodes } from '@pagespace/db/schema/agent-workspace-nodes';
import { conversations } from '@pagespace/db/schema/conversations';
import { factories } from '@pagespace/db/test/factories';
import { countOpenConversations } from '../conversation-cap';

/**
 * A Drizzle handle that is either the pooled singleton or an open transaction
 * — the same "singleton or transaction" shape `countOpenConversations` takes.
 */
type Executor = Pick<typeof db, 'select' | 'insert'>;

/** Everything this file minted, torn down by deleting the owning users (all of
 *  drives → pages → workspaces → conversations cascade from there). */
const ownerIds: string[] = [];

/** The drive/agent-page a seeded conversation hangs off. `type='page'` rows
 *  carry a CHECK requiring a non-null `contextId`, so this is not optional. */
let agentPageId = '';

/** A fresh session row. Every assertion in this file is scoped to one of these
 *  ids — the database is shared, so global counts are never asserted. */
async function createWorkspace(): Promise<string> {
  const [row] = await db
    .insert(agentWorkspaces)
    .values({ id: createId(), driveId: null, ownerId: ownerIds[0] })
    .returning({ id: agentWorkspaces.id });
  return row.id;
}

/**
 * One conversation and, when it has a home, the NODE that is its membership —
 * seeded directly: what is under test is a COUNT over existing state, so the
 * rows are state, not the output of a writer.
 *
 * EVERY seeded node is under the root, because there is nowhere else. The
 * `attached` option this helper used to take chose between a node under the
 * root and one with `parentId: null` — "in the workspace, off the screen" —
 * and that state no longer exists at any layer: `validateTree` calls it
 * `null_parent`, `nodeFromRow` throws on it, and the table's root CHECK is
 * biconditional, so the database refuses the row outright.
 */
async function seedConversation(opts: {
  workspaceId: string | null;
  isActive?: boolean;
  executor?: Executor;
}): Promise<string> {
  const id = createId();
  const executor = opts.executor ?? db;
  await executor.insert(conversations).values({
    id,
    userId: ownerIds[0],
    type: 'page',
    contextId: agentPageId,
    isActive: opts.isActive ?? true,
    updatedAt: new Date(),
  });
  if (opts.workspaceId !== null) {
    await executor.insert(agentWorkspaceNodes).values({
      id: createId(),
      rootId: opts.workspaceId,
      parentId: await rootOfWorkspace(opts.workspaceId, executor),
      position: 0,
      nodeType: 'pane',
      targetKind: 'chat',
      targetId: id,
      updatedAt: new Date(),
    });
  }
  return id;
}

/** The workspace's root node id, minted on first use. Every tree needs one. */
async function rootOfWorkspace(workspaceId: string, executor: Executor): Promise<string> {
  const [existing] = await executor
    .select({ id: agentWorkspaceNodes.id })
    .from(agentWorkspaceNodes)
    .where(and(eq(agentWorkspaceNodes.rootId, workspaceId), eq(agentWorkspaceNodes.nodeType, 'root')))
    .limit(1);
  if (existing) return existing.id;
  const id = createId();
  await executor.insert(agentWorkspaceNodes).values({
    id,
    rootId: workspaceId,
    parentId: null,
    position: 0,
    nodeType: 'root',
    axis: 'row',
    updatedAt: new Date(),
  });
  return id;
}

describe('countOpenConversations — the one membership count, on a real database', () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'conversation-cap.integration.test.ts requires DATABASE_URL: this suite asserts real SQL ' +
          'and must fail loudly rather than skip.',
      );
    }
    try {
      await db.select({ id: users.id }).from(users).limit(1);
    } catch (error) {
      throw new Error(
        `conversation-cap.integration.test.ts could not reach DATABASE_URL: ${String(error)}`,
      );
    }

    const owner = await factories.createUser();
    ownerIds.push(owner.id);
    const drive = await factories.createDrive(owner.id);
    const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Cap Agent' });
    agentPageId = agentPage.id;
  });

  afterAll(async () => {
    if (ownerIds.length > 0) {
      await db.delete(users).where(inArray(users.id, ownerIds));
    }
  });

  // ---------------------------------------------------------------------------
  // WHAT COUNTS
  // ---------------------------------------------------------------------------

  it('counts every conversation the workspace HOLDS', async () => {
    const workspaceId = await createWorkspace();

    expect(await countOpenConversations(workspaceId)).toBe(0);
    await seedConversation({ workspaceId });
    expect(await countOpenConversations(workspaceId)).toBe(1);
    await seedConversation({ workspaceId });
    expect(await countOpenConversations(workspaceId)).toBe(2);
  });

  it('returns 0 — a number, never undefined or NaN — for a session with no conversations at all', async () => {
    const workspaceId = await createWorkspace();

    const n = await countOpenConversations(workspaceId);
    // A brand-new session is the FIRST state the claim path counts, so the
    // `row?.n ?? 0` fallback is on the hot path, not a defensive afterthought:
    // an `undefined` here would compare `undefined < MAX` as false and refuse
    // the session's very first conversation.
    expect(n).toBe(0);
    expect(Number.isInteger(n)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // WHAT DOES NOT COUNT
  // ---------------------------------------------------------------------------

  it('counts every node the workspace holds, because holding one IS membership', async () => {
    // THIS TEST USED TO SEED A THREAD "off the grid" — a node with
    // `parentId: null` — and assert it still counted, on the reasoning that
    // closing was a MOVE and a moved thread was still a member. The one-removal
    // correction deleted that state: closing DESTROYS the node, so there is no
    // longer a way to be a member and not be somewhere, and the database now
    // refuses the row the old fixture inserted.
    //
    // What the old test was really pinning survives and is stronger for it: the
    // count is of MEMBERSHIP, and membership is the presence of a row. Nothing
    // about where the row sits enters the predicate.
    const workspaceId = await createWorkspace();
    await seedConversation({ workspaceId });
    await seedConversation({ workspaceId });

    expect(await countOpenConversations(workspaceId)).toBe(2);
  });

  it('does not count a history-deleted thread, because the delete takes its NODE too', async () => {
    // `isActive` is not in the predicate any more. What keeps a deleted thread
    // out of the count is that `expelConversationFromSession` removes its node,
    // so this seeds the state that write leaves: a row with no membership.
    const workspaceId = await createWorkspace();
    await seedConversation({ workspaceId });
    await seedConversation({ workspaceId: null, isActive: false });

    expect(await countOpenConversations(workspaceId)).toBe(1);
  });

  it('does not count conversations belonging to a DIFFERENT workspace', async () => {
    const mine = await createWorkspace();
    const theirs = await createWorkspace();
    await seedConversation({ workspaceId: mine });
    await seedConversation({ workspaceId: theirs });
    await seedConversation({ workspaceId: theirs });

    // Each session's cap is its own; neither can be consumed by the other.
    expect(await countOpenConversations(mine)).toBe(1);
    expect(await countOpenConversations(theirs)).toBe(2);
  });

  it('does not count a thread that belongs to no workspace at all', async () => {
    const workspaceId = await createWorkspace();
    // A plain chat with no membership row. It has no `rootId` to match, so no
    // workspace's cap is consumed by threads outside every workspace.
    await seedConversation({ workspaceId: null });

    expect(await countOpenConversations(workspaceId)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // CLOSE / REOPEN SYMMETRY
  // ---------------------------------------------------------------------------

  it('FREES A SLOT on close and consumes one on reopen — both are the one removal and an ordinary admission', async () => {
    // THE INVERSE OF WHAT THIS PINNED BEFORE, and the inversion is the point.
    // This test asserted the count was UNMOVED by a close, because closing was
    // a `move` to no parent and the thread stayed a member. Closing is a
    // `destroy` now — the single removal — so a closed thread is a member of
    // nothing, its slot is freed, and reopening it is an ordinary admission
    // that consumes one again (which is why `reopen` can answer `session_full`).
    //
    // The old shape only worked because a parentless pane was storable. It is
    // not: the root CHECK is biconditional.
    const workspaceId = await createWorkspace();
    await seedConversation({ workspaceId });
    const toggled = await seedConversation({ workspaceId });
    expect(await countOpenConversations(workspaceId)).toBe(2);

    // Closing: the node is destroyed, and the slot goes with it.
    await db.delete(agentWorkspaceNodes).where(eq(agentWorkspaceNodes.targetId, toggled));
    expect(await countOpenConversations(workspaceId)).toBe(1);

    // Reopening: a new node, seated under the root like any other admission.
    await db.insert(agentWorkspaceNodes).values({
      id: createId(),
      rootId: workspaceId,
      parentId: await rootOfWorkspace(workspaceId, db),
      position: 1,
      nodeType: 'pane',
      targetKind: 'chat',
      targetId: toggled,
      updatedAt: new Date(),
    });
    expect(await countOpenConversations(workspaceId)).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // THE EXECUTOR PARAMETER
  // ---------------------------------------------------------------------------

  it('counts on the CALLER\'S connection when one is passed, not on the shared pool', async () => {
    const workspaceId = await createWorkspace();
    await seedConversation({ workspaceId });

    await db.transaction(async (tx) => {
      // Two more rows that exist only inside this transaction. The membership
      // write does exactly this — it decides the cap against the tree it is
      // about to change, inside its own transaction — so a count that reached
      // for the pool would decide against state it has already changed.
      await seedConversation({ workspaceId, executor: tx });
      await seedConversation({ workspaceId, executor: tx });

      expect(await countOpenConversations(workspaceId, tx)).toBe(3);

      // The control: the same call on the DEFAULT executor is a different
      // connection, and READ COMMITTED hides uncommitted rows from it. If the
      // `executor` argument were ignored, this and the assertion above would
      // agree — so their disagreement is what proves it is honoured.
      expect(await countOpenConversations(workspaceId)).toBe(1);
    });

    // Committed: the pooled view catches up, and the two counts converge.
    expect(await countOpenConversations(workspaceId)).toBe(3);
  });

  it('sees a rollback on the caller\'s connection too — nothing leaks to the pool', async () => {
    const workspaceId = await createWorkspace();
    await seedConversation({ workspaceId });

    class Rollback extends Error {}
    await expect(
      db.transaction(async (tx) => {
        await seedConversation({ workspaceId, executor: tx });
        expect(await countOpenConversations(workspaceId, tx)).toBe(2);
        throw new Rollback('abort');
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(await countOpenConversations(workspaceId)).toBe(1);
  });
});
