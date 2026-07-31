/**
 * `hasActiveMessage` regression coverage against a REAL Postgres (real DB, not
 * mocked) — the drizzle-mock unit test in this same directory can prove the
 * pagination math, but "does this predicate actually see rows written by the
 * real page-agent send path" needs real SQL against the real `chat_messages`
 * table, joined the way `conversationRepository.conversationExists` does.
 *
 * The bug this guards: `hasActiveMessage` originally checked only the
 * `messages` table, which only `type: 'global'` conversations ever write to —
 * every `type: 'page'` conversation (including session-bound agent chats)
 * writes its content to `chat_messages` instead, keyed by `pageId` +
 * `conversationId` (review finding: this silently excluded every real
 * page-agent conversation from the listing).
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). Skipped when no DB is reachable —
 * mirrors `reorder-task-list.integration.test.ts` in this same convention.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { pages, chatMessages } from '@pagespace/db/schema/core';
import { conversations } from '@pagespace/db/schema/conversations';
import { factories } from '@pagespace/db/test/factories';
import { listAllConversationsPaginated } from '../agent-sessions-conversations-runtime';

let dbAvailable = false;

describe('listAllConversationsPaginated — hasActiveMessage against real chat_messages', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it('surfaces a type: "page" conversation whose content lives in chat_messages, not messages', async () => {
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
    await db.insert(chatMessages).values({
      id: createId(),
      pageId: agentPage.id,
      conversationId,
      role: 'user',
      content: 'hello',
      isActive: true,
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
    await db.insert(chatMessages).values({
      id: createId(),
      pageId: oldAgent.id,
      conversationId: oldConversationId,
      role: 'user',
      content: 'still using this one',
      isActive: true,
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
    await db.insert(chatMessages).values({
      id: createId(),
      pageId: newAgent.id,
      conversationId: newConversationId,
      role: 'user',
      content: 'sent right after creating, never touched again',
      isActive: true,
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
    await db.insert(chatMessages).values({
      id: createId(),
      pageId: agentPage.id,
      conversationId,
      role: 'user',
      content: 'hi from the API',
      isActive: true,
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
