/**
 * MESSAGE READS ARE TOTALLY ORDERED.
 *
 * `ORDER BY "createdAt"` is a PARTIAL order over `messages`: the column is a
 * millisecond timestamp, and a burst of writes inside one millisecond — a
 * user turn and its tool rows, an interrupt and the resumed row that replaces
 * it, any seeded fixture — produces rows Postgres is then free to return in
 * any order it likes. Not a stable-but-arbitrary order: the planner may hand
 * back heap order on one call and index order on the next, for the same rows.
 *
 * Every consumer of these readers treats the result as a TRANSCRIPT. The AI
 * chat history is replayed into a model prompt in returned order; the pane
 * renders it in returned order. A conversation whose last two turns swap
 * between reloads is not a cosmetic defect — it is a different prompt.
 *
 * This surfaced as a rare, unreproducible failure in
 * `chat-mutation-matrix.integration.test.ts > interrupt and resume`:
 *
 *     expected ['streaming','complete'] to deeply equal ['complete','streaming']
 *
 * The nondeterminism was in the READER, not the test.
 *
 * ── THE TIEBREAKER ─────────────────────────────────────────────────────────
 * `messages.id` — a cuid2, and deliberately NOT sortable-by-creation-time
 * (cuid2 dropped the k-sortable prefix of cuid v1 precisely to stop leaking
 * creation order and volume). That is fine, and it is worth being explicit
 * about why: rows tied on `createdAt` have no chronological truth left to
 * preserve, so the tiebreaker's only job is to be TOTAL and STABLE, which a
 * unique primary key is by construction. There is no monotonic sequence
 * column on this table to prefer instead.
 *
 * DESC readers tiebreak DESC, so that `ORDER BY … DESC LIMIT n` selects a
 * deterministic WINDOW and not merely a deterministic ordering of whichever
 * rows it happened to select.
 *
 * Requires DATABASE_URL → a Postgres with migrations applied.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';

import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { factories } from '@pagespace/db/test/factories';
import { messageRepository } from '@/lib/repositories/message-repository';

let dbAvailable = false;

/** How many rows share the tick. 8! = 40320 orderings — accidental agreement is not a risk. */
const TIED = 8;

/**
 * A conversation whose messages ALL share one `createdAt`, seeded in an order
 * that (with overwhelming probability) is not their id order — so a reader
 * with no tiebreaker cannot accidentally satisfy the assertion.
 */
async function seedSameTickThread() {
  const owner = await factories.createUser();
  const drive = await factories.createDrive(owner.id);
  const page = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Agent' });
  const conversationId = createId();
  const tick = new Date();

  await db.insert(conversations).values({
    id: conversationId,
    userId: owner.id,
    type: 'page',
    contextId: page.id,
    isActive: true,
    lastMessageAt: tick,
    updatedAt: new Date(),
  });

  const ids: string[] = [];
  for (let i = 0; i < TIED; i++) {
    const id = createId();
    await db.insert(messages).values({
      id,
      conversationId,
      userId: i % 2 === 0 ? owner.id : null,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
      isActive: true,
      status: 'complete' as const,
      createdAt: tick,
    });
    ids.push(id);
  }

  return { ownerId: owner.id, pageId: page.id, conversationId, ids, tick };
}

/** The total order the readers must produce: createdAt ASC, then id ASC. */
const expectedAsc = (ids: string[]) => [...ids].sort();

describe('message read ordering is total and stable', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it('getMessagesByConversationId breaks createdAt ties deterministically', async () => {
    if (!dbAvailable) throw new Error('DATABASE_URL must point at a migrated Postgres');
    const thread = await seedSameTickThread();

    const rows = await messageRepository.getMessagesByConversationId(thread.conversationId);
    expect(rows.map((r) => r.id)).toEqual(expectedAsc(thread.ids));
  });

  it('getPageConversationMessages breaks createdAt ties deterministically', async () => {
    if (!dbAvailable) throw new Error('DATABASE_URL must point at a migrated Postgres');
    const thread = await seedSameTickThread();

    const rows = await messageRepository.getPageConversationMessages(thread.pageId, thread.conversationId);
    expect(rows.map((r) => r.id)).toEqual(expectedAsc(thread.ids));
  });

  it('getMessagesForPage breaks createdAt ties deterministically', async () => {
    if (!dbAvailable) throw new Error('DATABASE_URL must point at a migrated Postgres');
    const thread = await seedSameTickThread();

    const rows = await messageRepository.getMessagesForPage(thread.pageId, thread.conversationId);
    expect(rows.map((r) => r.id)).toEqual(expectedAsc(thread.ids));
  });

  it('getRecentPageMessages selects a deterministic WINDOW, not just a deterministic order', async () => {
    if (!dbAvailable) throw new Error('DATABASE_URL must point at a migrated Postgres');
    const thread = await seedSameTickThread();

    // DESC + LIMIT under a tie: without a DESC tiebreaker, WHICH rows survive
    // the limit is itself arbitrary. The newest 3 by (createdAt, id) are the
    // last 3 of the ascending order, returned oldest-first.
    const rows = await messageRepository.getRecentPageMessages(thread.pageId, 3);
    expect(rows.map((r) => r.id)).toEqual(expectedAsc(thread.ids).slice(-3));
  });

  it('repeated reads of the same tied rows agree with each other', async () => {
    if (!dbAvailable) throw new Error('DATABASE_URL must point at a migrated Postgres');
    const thread = await seedSameTickThread();

    const reads = await Promise.all(
      Array.from({ length: 5 }, () => messageRepository.getMessagesByConversationId(thread.conversationId)),
    );
    const orders = reads.map((rows) => rows.map((r) => r.id).join(','));
    expect(new Set(orders).size).toBe(1);
  });
});
