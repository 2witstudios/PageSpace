/**
 * `countOpenConversations` — THE open-conversation cap predicate, against a
 * REAL Postgres.
 *
 * The whole point of `conversation-cap.ts` (epic "Agent-Session Single Source
 * of Truth", Phase 1 / D7) is that the predicate
 *
 *   workspaceId = $1 AND isActive = true AND closedInWorkspaceAt IS NULL
 *
 * exists EXACTLY ONCE, because it used to be written out three times and three
 * copies is three chances for one of them to drift and unbalance which
 * listings count toward `MAX_SESSION_CONVERSATIONS`. Every consumer — the
 * claim path, close/reopen, the tool layer's advisory spawn pre-count, the
 * end-session warning — injects a `vi.fn()` for it, which is correct for those
 * suites and leaves the actual SQL asserted NOWHERE: a re-inlined second copy
 * that quietly dropped a clause would go green in every one of them. This
 * suite is the one place the statement itself is executed and pinned.
 *
 * It also pins the `executor` parameter, which exists so a caller holding its
 * own connection (a transaction, a lock-scoped client) is counted ON THAT
 * CONNECTION rather than having this module reach for the shared pool
 * underneath it. That is a property no mock can express: it is only true or
 * false against a real database with real transaction visibility.
 *
 * Requires DATABASE_URL → a Postgres with migrations applied. Deliberately
 * does NOT skip when the database is unreachable: a silently-skipping cap test
 * is indistinguishable from no cap test at all, which is the hole this file
 * was written to close.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
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
 * One conversation row, seeded directly: what is under test is a COUNT over
 * existing state, so the rows are state, not the output of a writer.
 */
async function seedConversation(opts: {
  workspaceId: string | null;
  isActive?: boolean;
  closedInWorkspaceAt?: Date | null;
  executor?: Executor;
}): Promise<string> {
  const id = createId();
  await (opts.executor ?? db).insert(conversations).values({
    id,
    userId: ownerIds[0],
    type: 'page',
    contextId: agentPageId,
    workspaceId: opts.workspaceId,
    isActive: opts.isActive ?? true,
    closedInWorkspaceAt: opts.closedInWorkspaceAt ?? null,
    updatedAt: new Date(),
  });
  return id;
}

describe('countOpenConversations — the one open-listing predicate, on a real database', () => {
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

  it('counts conversations bound to the workspace that are history-alive and not closed in it', async () => {
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

  it('does not count a history-deleted conversation (isActive = false)', async () => {
    const workspaceId = await createWorkspace();
    await seedConversation({ workspaceId });
    await seedConversation({ workspaceId, isActive: false });

    expect(await countOpenConversations(workspaceId)).toBe(1);
  });

  it('does not count a conversation closed out of the workspace listing (closedInWorkspaceAt set)', async () => {
    const workspaceId = await createWorkspace();
    await seedConversation({ workspaceId });
    await seedConversation({ workspaceId, closedInWorkspaceAt: new Date() });

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

  it('does not count an unbound conversation (workspaceId IS NULL)', async () => {
    const workspaceId = await createWorkspace();
    // A plain chat with no session. `eq(workspaceId, $1)` is never true of
    // NULL, so a session's cap is not consumed by threads outside every
    // session.
    await seedConversation({ workspaceId: null });

    expect(await countOpenConversations(workspaceId)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // CLOSE / REOPEN SYMMETRY
  // ---------------------------------------------------------------------------

  it('drops the count when a conversation is closed and restores it when reopened', async () => {
    const workspaceId = await createWorkspace();
    await seedConversation({ workspaceId });
    const toggled = await seedConversation({ workspaceId });
    expect(await countOpenConversations(workspaceId)).toBe(2);

    // Closing is only ever stamping the column; history (`isActive`) is
    // untouched, which is why reopening can be exactly its inverse.
    await db
      .update(conversations)
      .set({ closedInWorkspaceAt: new Date() })
      .where(eq(conversations.id, toggled));
    expect(await countOpenConversations(workspaceId)).toBe(1);

    await db
      .update(conversations)
      .set({ closedInWorkspaceAt: null })
      .where(eq(conversations.id, toggled));
    expect(await countOpenConversations(workspaceId)).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // THE EXECUTOR PARAMETER
  // ---------------------------------------------------------------------------

  it('counts on the CALLER\'S connection when one is passed, not on the shared pool', async () => {
    const workspaceId = await createWorkspace();
    await seedConversation({ workspaceId });

    await db.transaction(async (tx) => {
      // Two more rows that exist only inside this transaction. A lock-holding
      // caller (`withSessionListingLock` → create/close/reopen) writes exactly
      // like this and then re-counts before deciding, so a count that reached
      // for the pool would decide against state its own transaction has
      // already changed.
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
