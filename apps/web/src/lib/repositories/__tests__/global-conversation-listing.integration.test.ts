/**
 * The right sidebar's Conversation History, against a REAL Postgres.
 *
 * THE BUG THIS GUARDS. `listConversationsPaginated` is the Global Assistant
 * branch of `SidebarHistoryTab` (the page-agent branch has its own endpoint and
 * is correctly scoped). It filtered on `[userId, isActive, hasMessages]` and
 * nothing else, and `hasMessages` tests `EXISTS(messages …)`. That was an
 * ACCIDENTAL type filter: before the message-table merge (epic "Agent-Session
 * Single Source of Truth", Phase 4 / D6) `messages` held global-assistant rows
 * only, with page/client rows in `chat_messages`. The merge's backfill moved
 * every historical page-agent message into `messages`, the accident stopped
 * holding, and the sidebar filled with page-agent threads — 107 of one
 * account's first 180 rows, and the whole of another's first page.
 *
 * Two more defects rode in with them, both invisible while the listing
 * contained only globals:
 *
 *   * ORDERING. `ORDER BY lastMessageAt DESC` — a column only the two
 *     global-assistant message routes ever write. Page rows carry NULL, and
 *     Postgres orders `DESC` as NULLS FIRST, so they took the TOP of the
 *     list, tied, broken only by `id DESC` (a cuid2 — arbitrary).
 *   * PAGINATION. The cursor re-read its row live and guarded on
 *     `if (cursorConv?.lastMessageAt)`, which is FALSY for exactly those rows,
 *     falling through to an id-only comparison — two orderings inside one
 *     scroll, so "load more" could skip rows entirely.
 *
 * Mocked query-builder assertions cannot see any of this: NULLS FIRST is real
 * Postgres behaviour, and skipped rows only appear when a boundary is
 * evaluated against real data. Hence a real DB.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable —
 * a silent skip would be a green, zero-assertion pass. Local runs without
 * Docker opt out explicitly with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { globalConversationRepository } from '../global-conversation-repository';

let dbAvailable = false;

async function seedConversation(row: {
  userId: string;
  type: 'global' | 'page' | 'client';
  contextId?: string | null;
  title?: string | null;
  lastMessageAt?: Date | null;
  createdAt?: Date;
}): Promise<string> {
  const id = createId();
  await db.insert(conversations).values({
    id,
    userId: row.userId,
    type: row.type,
    contextId: row.contextId ?? null,
    title: row.title ?? null,
    isActive: true,
    lastMessageAt: row.lastMessageAt ?? null,
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
  });
  return id;
}

async function seedMessage(conversationId: string, createdAt?: Date): Promise<void> {
  await db.insert(messages).values({
    id: createId(),
    conversationId,
    role: 'user',
    content: 'hello',
    isActive: true,
    ...(createdAt ? { createdAt } : {}),
  });
}

describe('globalConversationRepository.listConversationsPaginated — real Postgres', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('global-conversation-listing.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  it('excludes a type: "page" conversation, which belongs to the page-agent tab', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'My Agent' });

    const globalId = await seedConversation({ userId: owner.id, type: 'global' });
    await seedMessage(globalId);
    const pageId = await seedConversation({
      userId: owner.id,
      type: 'page',
      contextId: agentPage.id,
    });
    await seedMessage(pageId);

    const result = await globalConversationRepository.listConversationsPaginated(owner.id);
    const ids = result.conversations.map((c) => c.id);

    expect(ids).toContain(globalId);
    expect(ids).not.toContain(pageId);
  });

  it('excludes a type: "client" conversation, minted by the public API', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const clientId = await seedConversation({ userId: owner.id, type: 'client' });
    await seedMessage(clientId);

    const result = await globalConversationRepository.listConversationsPaginated(owner.id);

    expect(result.conversations.map((c) => c.id)).not.toContain(clientId);
  });

  it('orders a NULL-lastMessageAt conversation by its real last message, not to the top', async () => {
    if (!dbAvailable) return;

    // The exact shape that shuffled the sidebar: `lastMessageAt` NULL. Under
    // `ORDER BY lastMessageAt DESC` Postgres puts NULLS FIRST, so this row
    // took position one regardless of when it was actually last used.
    const owner = await factories.createUser();

    const stale = await seedConversation({
      userId: owner.id,
      type: 'global',
      title: 'stale',
      lastMessageAt: null,
      createdAt: new Date('2026-01-01'),
    });
    await seedMessage(stale, new Date('2026-01-02'));

    const recent = await seedConversation({
      userId: owner.id,
      type: 'global',
      title: 'recent',
      lastMessageAt: new Date('2026-08-01'),
      createdAt: new Date('2026-07-01'),
    });
    await seedMessage(recent, new Date('2026-08-01'));

    const result = await globalConversationRepository.listConversationsPaginated(owner.id);
    const ids = result.conversations.map((c) => c.id);

    expect(ids.indexOf(recent)).toBeLessThan(ids.indexOf(stale));
  });

  it('paginates across a NULL-lastMessageAt boundary with no skipped or repeated rows', async () => {
    if (!dbAvailable) return;

    // The history has to MIX the two shapes for this to bite, which is what a
    // real account looks like: some threads carry `lastMessageAt`, the ones
    // that arrived with the message-table merge do not. Under the old cursor a
    // page ending on a NULL row fell through to `id < cursorId`, which then
    // excluded every non-NULL row with a larger id — rows that sort AFTER the
    // boundary and were never returned by any page. With all rows NULL the
    // id-only comparison is accidentally self-consistent and the skip cannot
    // appear, so a uniform fixture proves nothing here.
    const owner = await factories.createUser();
    const expected: string[] = [];
    for (let i = 0; i < 6; i++) {
      const hasColumn = i % 2 === 0;
      const id = await seedConversation({
        userId: owner.id,
        type: 'global',
        title: `conv-${i}`,
        lastMessageAt: hasColumn ? new Date(`2026-0${i + 1}-03`) : null,
        createdAt: new Date(`2026-0${i + 1}-01`),
      });
      await seedMessage(id, new Date(`2026-0${i + 1}-02`));
      expected.push(id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await globalConversationRepository.listConversationsPaginated(owner.id, {
        limit: 2,
        cursor,
      });
      seen.push(...result.conversations.map((c) => c.id));
      if (!result.pagination.hasMore || !result.pagination.nextCursor) break;
      cursor = result.pagination.nextCursor;
    }

    // No repeats, and every seeded conversation reached.
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...expected].sort());
  });
});
