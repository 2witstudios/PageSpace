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
});
