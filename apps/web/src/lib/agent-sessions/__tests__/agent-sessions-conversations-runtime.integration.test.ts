/**
 * `hasActiveMessage` regression coverage against a REAL Postgres (real DB, not
 * mocked) — the drizzle-mock unit test in this same directory can prove the
 * pagination math, but "does this predicate actually see rows written by the
 * real page-agent send path" needs real SQL against the real tables.
 *
 * The bug this guards: `hasActiveMessage` originally checked only the
 * `messages` table, while every `type: 'page'` conversation (including
 * session-bound agent chats) wrote its content to `chat_messages` — which
 * silently excluded every real page-agent conversation from the listing
 * (review finding).
 *
 * SINCE THE MESSAGE-TABLE MERGE (epic "Agent-Session Single Source of Truth",
 * Phase 4 / D6) the reader queries the unified `messages` table only, and
 * page-chat writes land on BOTH legs (PR 10's dual-write). So the seeding here
 * writes both legs too — `insertPageMessage` below — which keeps the original
 * regression honest: the fixture is still "content written by the page-agent
 * send path", it is just no longer single-legged. A reader that reverted to
 * checking only the legacy leg would still be caught, because the assertions
 * are about what the LISTING returns, not about which table it read.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). Skipped when no DB is reachable —
 * mirrors `reorder-task-list.integration.test.ts` in this same convention.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { pages, chatMessages } from '@pagespace/db/schema/core';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { factories } from '@pagespace/db/test/factories';
import { listAllConversationsPaginated, decodeCursor } from '../agent-sessions-conversations-runtime';

let dbAvailable = false;

/**
 * Seed one page-chat message on BOTH legs — exactly what PR 10's dual-write
 * does for every live page-chat write. Returns the shared row id so a test can
 * reach back for a raw-SQL timestamp fixup.
 */
async function insertPageMessage(row: {
  pageId: string;
  conversationId: string;
  role: string;
  content: string;
  isActive?: boolean;
  createdAt?: Date;
}): Promise<string> {
  const id = createId();
  const values = {
    id,
    pageId: row.pageId,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    isActive: row.isActive ?? true,
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
  };
  await db.insert(chatMessages).values(values);
  await db.insert(messages).values(values);
  return id;
}

describe('listAllConversationsPaginated — hasActiveMessage against a real Postgres', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it('surfaces a type: "page" conversation written by the page-agent send path', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'My Agent' });
    const conversationId = createId();

    await db.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      type: 'page',
      contextId: agentPage.id,
      title: null,
      isActive: true,
    });
    await insertPageMessage({
      pageId: agentPage.id,
      conversationId,
      role: 'user',
      content: 'hello',
    });

    const result = await listAllConversationsPaginated({ ownerId: owner.id });

    const row = result.conversations.find((c) => c.conversationId === conversationId);
    expect(row).toBeDefined();
    expect(row?.agentPageId).toBe(agentPage.id);
    expect(row?.pageTitle).toBe('My Agent');
  });

  it('still excludes a type: "page" conversation with NO messages in either table', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Empty Agent' });
    const conversationId = createId();

    await db.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      type: 'page',
      contextId: agentPage.id,
      title: null,
      isActive: true,
    });

    const result = await listAllConversationsPaginated({ ownerId: owner.id });

    expect(result.conversations.find((c) => c.conversationId === conversationId)).toBeUndefined();
  });

  it('sorts a page conversation by its ACTUAL last message time, not its creation time (P1 review finding)', async () => {
    if (!dbAvailable) return;

    // conversations.lastMessageAt is never set for type: 'page' (nothing writes
    // it — the send path only touches chat_messages), so before the fix the
    // sort/cursor key fell back to createdAt for every page conversation. An
    // OLD thread (created first) that just received a message today must
    // still sort AHEAD of a NEWER thread (created after it) with no recent
    // activity — the opposite of createdAt order.
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const oldAgent = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Old Agent' });
    const newAgent = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'New Agent' });

    const oldConversationId = createId();
    await db.insert(conversations).values({
      id: oldConversationId,
      userId: owner.id,
      type: 'page',
      contextId: oldAgent.id,
      title: null,
      isActive: true,
      createdAt: new Date('2020-01-01'),
    });
    // Its only message is TODAY — real recent activity.
    await insertPageMessage({
      pageId: oldAgent.id,
      conversationId: oldConversationId,
      role: 'user',
      content: 'still using this one',
      createdAt: new Date(),
    });

    const newConversationId = createId();
    await db.insert(conversations).values({
      id: newConversationId,
      userId: owner.id,
      type: 'page',
      contextId: newAgent.id,
      title: null,
      isActive: true,
      createdAt: new Date('2026-01-01'),
    });
    // Created much later, but its only message is old — no recent activity.
    await insertPageMessage({
      pageId: newAgent.id,
      conversationId: newConversationId,
      role: 'user',
      content: 'sent right after creating, never touched again',
      createdAt: new Date('2026-01-01'),
    });

    const result = await listAllConversationsPaginated({ ownerId: owner.id });

    const oldIndex = result.conversations.findIndex((c) => c.conversationId === oldConversationId);
    const newIndex = result.conversations.findIndex((c) => c.conversationId === newConversationId);
    expect(oldIndex).toBeGreaterThanOrEqual(0);
    expect(newIndex).toBeGreaterThanOrEqual(0);
    // Newest-first: the one with today's activity must come BEFORE the one
    // whose only activity is from years ago, despite being created later.
    expect(oldIndex).toBeLessThan(newIndex);

    const oldRow = result.conversations.find((c) => c.conversationId === oldConversationId);
    // The returned lastMessageAt must reflect the REAL message time, not stay
    // null (conversations.lastMessageAt is never set for this type) and not
    // silently fall back to createdAt while messages exist.
    expect(oldRow?.lastMessageAt).not.toBeNull();
    expect(new Date(oldRow!.lastMessageAt!).getFullYear()).toBeGreaterThan(2020);
  });

  it('surfaces a type: "client" (API-managed) conversation, whose messages can carry a DIFFERENT pageId per message', async () => {
    if (!dbAvailable) return;

    // v1-conversations.ts: a `client` conversation's own contextId is an
    // optional driveId, never a pageId — its chat_messages rows are written
    // by whatever page a given /v1/chat/completions call targeted, which can
    // differ message-to-message. Matching hasActiveMessage on conversationId
    // ALONE (no pageId equality) is what makes this findable at all.
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT' });
    const conversationId = createId();

    await db.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      type: 'client',
      contextId: drive.id,
      title: 'My API thread',
      isActive: true,
    });
    await insertPageMessage({
      pageId: agentPage.id,
      conversationId,
      role: 'user',
      content: 'hi from the API',
    });

    const result = await listAllConversationsPaginated({ ownerId: owner.id });

    const row = result.conversations.find((c) => c.conversationId === conversationId);
    expect(row).toBeDefined();
    expect(row?.type).toBe('client');
    // Resolved directly from contextId (a driveId for this type), not via the
    // `pages` join (which only ever matches type: 'page').
    expect(row?.driveId).toBe(drive.id);
    expect(row?.agentPageId).toBeNull();
    expect(row?.pageTitle).toBeNull();
  });
});

describe('listAllConversationsPaginated — cursor pagination is immune to concurrent mutation (P2 review finding)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it('a message arriving in the cursor conversation between page fetches does not cause a duplicate or a skipped row', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agent1 = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Agent 1' });
    const agent2 = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Agent 2' });
    const agent3 = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Agent 3' });

    // Three conversations, oldest to newest by their real last-activity time.
    const makeConversation = async (agentId: string, activityAt: Date) => {
      const conversationId = createId();
      await db.insert(conversations).values({
        id: conversationId, userId: owner.id, type: 'page', contextId: agentId, title: null, isActive: true,
      });
      await insertPageMessage({ pageId: agentId, conversationId, role: 'user', content: 'hi', createdAt: activityAt });
      return conversationId;
    };

    const oldest = await makeConversation(agent1.id, new Date('2020-01-01'));
    const middle = await makeConversation(agent2.id, new Date('2020-01-02'));
    const newest = await makeConversation(agent3.id, new Date('2020-01-03'));

    // Page 1: newest first, limit 2 → [newest, middle]. nextCursor freezes
    // `middle`'s sort key as it was AT THIS MOMENT.
    const page1 = await listAllConversationsPaginated({ ownerId: owner.id }, { limit: 2 });
    expect(page1.conversations.map((c) => c.conversationId)).toEqual([newest, middle]);
    expect(page1.pagination.hasMore).toBe(true);
    const cursor = page1.pagination.nextCursor!;
    // Sanity: the cursor really did freeze `middle`'s ORIGINAL sort key, not
    // some later value — this is the whole point of the fix.
    expect(decodeCursor(cursor)?.id).toBe(middle);

    // Concurrent activity: `middle` receives a brand-new message NOW —
    // this is what the review flagged as the race. With the old
    // live-re-lookup design, decoding the cursor's id and re-querying its
    // CURRENT sort key would see this new, much-more-recent timestamp
    // instead of the frozen one.
    await insertPageMessage({ pageId: agent2.id, conversationId: middle, role: 'user', content: 'still here', createdAt: new Date() });

    // Page 2, using the cursor obtained BEFORE that mutation.
    const page2 = await listAllConversationsPaginated({ ownerId: owner.id }, { limit: 2, cursor });

    // Correct: exactly the one conversation strictly older than the FROZEN
    // boundary — `middle` must not reappear (duplicate), and this must not
    // silently return page one again either.
    expect(page2.conversations.map((c) => c.conversationId)).toEqual([oldest]);
  });

  it('a cursor whose conversation was deleted in between still returns the correct next page, not page one again', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agent1 = await factories.createPage(drive.id, { type: 'AI_CHAT' });
    const agent2 = await factories.createPage(drive.id, { type: 'AI_CHAT' });
    const agent3 = await factories.createPage(drive.id, { type: 'AI_CHAT' });

    const makeConversation = async (agentId: string, activityAt: Date) => {
      const conversationId = createId();
      await db.insert(conversations).values({
        id: conversationId, userId: owner.id, type: 'page', contextId: agentId, title: null, isActive: true,
      });
      await insertPageMessage({ pageId: agentId, conversationId, role: 'user', content: 'hi', createdAt: activityAt });
      return conversationId;
    };

    // A THIRD, older conversation matters here: if the cursor's own row
    // disappearing were allowed to silently drop the boundary entirely (the
    // bug), the query would still exclude the now-inactive cursor row on its
    // own merits — a weaker test with only two conversations would pass
    // either way. With three, a dropped boundary wrongly re-admits `newest`
    // (already shown on page 1) alongside `oldest`.
    const oldest = await makeConversation(agent1.id, new Date('2020-02-01'));
    const middle = await makeConversation(agent2.id, new Date('2020-02-02'));
    const newest = await makeConversation(agent3.id, new Date('2020-02-03'));

    const page1 = await listAllConversationsPaginated({ ownerId: owner.id }, { limit: 2 });
    expect(page1.conversations.map((c) => c.conversationId)).toEqual([newest, middle]);
    const cursor = page1.pagination.nextCursor!;

    // The cursor conversation (`middle`) is soft-deleted — a LIVE lookup by
    // id would find nothing (or, if hard-deleted, literally nothing at all);
    // the frozen cursor needs no lookup at all, so this can't degrade
    // pagination into silently re-admitting `newest`.
    await db.update(conversations).set({ isActive: false }).where(eq(conversations.id, middle));

    const page2 = await listAllConversationsPaginated({ ownerId: owner.id }, { limit: 2, cursor });
    expect(page2.conversations.map((c) => c.conversationId)).toEqual([oldest]);
  });

  // Confirmed empirically against this real test DB before writing this test:
  // drizzle's own query builder returns `sortKeyExpr` (a raw computed
  // COALESCE/subquery expression, not a schema-mapped column) as a STRING
  // with full microsecond precision, e.g. "2020-03-01 00:00:00.123456" —
  // Postgres timestamps carry six fractional digits, a plain JS `Date` only
  // three. `encodeCursor` previously round-tripped every sort key through
  // `new Date(...).toISOString()` regardless, silently truncating two
  // distinct sub-millisecond sort keys onto the identical encoded value
  // (review finding).
  it('two rows whose sort keys differ only below the millisecond are still paginated correctly, not collapsed onto one cursor', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agentNewer = await factories.createPage(drive.id, { type: 'AI_CHAT' });
    const agentOlder = await factories.createPage(drive.id, { type: 'AI_CHAT' });

    const makeConversation = async (agentId: string) => {
      const conversationId = createId();
      await db.insert(conversations).values({
        id: conversationId, userId: owner.id, type: 'page', contextId: agentId, title: null, isActive: true,
      });
      const messageId = await insertPageMessage({ pageId: agentId, conversationId, role: 'user', content: 'hi' });
      return { conversationId, messageId };
    };

    // A plain JS `Date` (and drizzle's own `.values({ createdAt })` insert
    // path) cannot express microseconds at all — raw SQL is the only way to
    // actually seed the sub-millisecond difference this test needs.
    const newer = await makeConversation(agentNewer.id);
    const older = await makeConversation(agentOlder.id);
    // Both legs, so the fixture stays coherent whichever one a reader looks at.
    await db.execute(sql`UPDATE chat_messages SET "createdAt" = '2020-03-01 00:00:00.123456' WHERE id = ${newer.messageId}`);
    await db.execute(sql`UPDATE chat_messages SET "createdAt" = '2020-03-01 00:00:00.123400' WHERE id = ${older.messageId}`);
    await db.execute(sql`UPDATE messages SET "createdAt" = '2020-03-01 00:00:00.123456' WHERE id = ${newer.messageId}`);
    await db.execute(sql`UPDATE messages SET "createdAt" = '2020-03-01 00:00:00.123400' WHERE id = ${older.messageId}`);

    const page1 = await listAllConversationsPaginated({ ownerId: owner.id }, { limit: 1 });
    expect(page1.conversations.map((c) => c.conversationId)).toEqual([newer.conversationId]);
    expect(page1.pagination.hasMore).toBe(true);
    const cursor = page1.pagination.nextCursor!;

    // With the pre-fix truncating cursor, both rows' sort keys collapse onto
    // the exact same encoded millisecond, and the boundary comparison either
    // re-admits `newer` (a duplicate) or drops `older` entirely, depending on
    // how the id tie-breaker happens to land — never the single correct
    // `[older]` this asserts.
    const page2 = await listAllConversationsPaginated({ ownerId: owner.id }, { limit: 1, cursor });
    expect(page2.conversations.map((c) => c.conversationId)).toEqual([older.conversationId]);
  });
});
