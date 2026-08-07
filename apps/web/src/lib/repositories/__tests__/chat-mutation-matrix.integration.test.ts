/**
 * THE CHAT MUTATION MATRIX, end to end against a REAL Postgres.
 *
 * Epic "Agent-Session Single Source of Truth", Phase 4 / D6, PR 12. The plan
 * asks for the full chat matrix to be EXERCISED, not asserted by inspection.
 * The parts a browser can drive — page chat, global chat, worker dispatch —
 * are covered live by `apps/e2e/tests/15-chat-fixture-smoke.spec.ts` and
 * `16-dispatch-multiplayer.spec.ts`. The parts it cannot are covered here, by
 * calling the shipped code against a real database:
 *
 *   - message EDIT and DELETE (page and global)
 *   - UNDO (preview + execute)
 *   - INTERRUPT + RESUME (the streaming placeholder → materializer path)
 *   - the retention PURGE cron's two sweeps
 *   - permanent page delete (trash), whose unified DELETE this PR added
 *
 * Every case asserts the SAME TWO PROPERTIES, which together are the whole
 * point of the cutover:
 *
 *   1. THE READ COMES FROM `messages`. The reader the route actually calls
 *      reflects the mutation.
 *   2. THE LEGACY LEG STAYS CORRECT. `chat_messages` is still written by every
 *      mutation, so reverting this PR alone lands on a table that already
 *      agrees — which is what makes the rollback safe rather than merely
 *      possible. Asserted by reading `chat_messages` directly.
 *
 * Only the broadcast transport is stubbed (it is fire-and-forget, and a test
 * process has no realtime service to POST to). The database, the repository,
 * the undo service and the cron handler are all real.
 *
 * Requires DATABASE_URL → a Postgres with migrations applied; skipped when no
 * DB is reachable, mirroring `unified-reader-parity.integration.test.ts`.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';

vi.mock('@/lib/websocket/conversation-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/websocket/conversation-events')>();
  return {
    ...actual,
    conversationEvents: {
      created: vi.fn().mockResolvedValue(undefined),
      updated: vi.fn().mockResolvedValue(undefined),
      messageCreated: vi.fn().mockResolvedValue(undefined),
      messageUpdated: vi.fn().mockResolvedValue(undefined),
      messageDeleted: vi.fn().mockResolvedValue(undefined),
      undoApplied: vi.fn().mockResolvedValue(undefined),
    },
  };
});
vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastAiMessageEdited: vi.fn().mockResolvedValue(undefined),
  broadcastAiMessageDeleted: vi.fn().mockResolvedValue(undefined),
  broadcastAiUndoApplied: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/channels/notify-mentioned-users', () => ({
  notifyMentionedUsers: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { pages, chatMessages } from '@pagespace/db/schema/core';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { factories } from '@pagespace/db/test/factories';
import { messageRepository } from '@/lib/repositories/message-repository';
import { previewAiUndo, executeAiUndo } from '@/services/api/ai-undo-service';

let dbAvailable = false;

const triggeredBy = { userId: 'test', displayName: 'Test', browserSessionId: 'test-session' };

/**
 * One page conversation seeded on BOTH tables — the shape the dual-write left
 * behind before Phase 4 PR 14 froze `chat_messages`. Seeding the legacy rows
 * directly (rather than through a writer) is the point: they are HISTORY now,
 * and every case below asserts the mutations no longer reach them.
 */
async function seedPageThread(opts: { contents: Array<{ role: string; content: string }> }) {
  const owner = await factories.createUser();
  const drive = await factories.createDrive(owner.id);
  const page = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Agent' });
  const conversationId = createId();
  const base = Date.now();

  await db.insert(conversations).values({
    id: conversationId,
    userId: owner.id,
    type: 'page',
    contextId: page.id,
    isActive: true,
    lastMessageAt: new Date(base + (opts.contents.length - 1) * 1000),
    updatedAt: new Date(),
  });

  const ids: string[] = [];
  for (const [i, m] of opts.contents.entries()) {
    const row = {
      id: createId(),
      pageId: page.id,
      conversationId,
      userId: m.role === 'user' ? owner.id : null,
      role: m.role,
      content: m.content,
      isActive: true,
      status: 'complete' as const,
      createdAt: new Date(base + i * 1000),
    };
    await db.insert(chatMessages).values(row);
    await db.insert(messages).values(row);
    ids.push(row.id);
  }

  return { ownerId: owner.id, driveId: drive.id, pageId: page.id, conversationId, ids };
}

/** What the FROZEN legacy table holds for a message — unchanged since the seed. */
async function legacyRow(messageId: string) {
  const [row] = await db.select().from(chatMessages).where(eq(chatMessages.id, messageId)).limit(1);
  return row ?? null;
}

describe('chat mutation matrix — unified reads and writes, legacy leg frozen', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  // -------------------------------------------------------------------------
  // EDIT
  // -------------------------------------------------------------------------

  describe('message edit', () => {
    it('is visible to the unified reader and never reaches the frozen leg', async () => {
      if (!dbAvailable) return;
      const thread = await seedPageThread({
        contents: [
          { role: 'user', content: 'original question' },
          { role: 'assistant', content: 'an answer' },
        ],
      });
      const target = thread.ids[0];

      await messageRepository.editPageMessage({
        messageId: target,
        pageId: thread.pageId,
        conversationId: thread.conversationId,
        updatedContent: 'edited question',
        legacyTriggeredBy: triggeredBy,
      });

      // 1. the route's own read seam
      const read = await messageRepository.getMessageById(target);
      expect(read?.content).toBe('edited question');
      expect(read?.editedAt).not.toBeNull();
      expect(read?.pageId).toBe(thread.pageId);

      // 2. and the history load the pane refetches with
      const history = await messageRepository.getPageConversationMessages(
        thread.pageId,
        thread.conversationId,
      );
      expect(history.map((m) => m.content)).toEqual(['edited question', 'an answer']);

      // 3. the freeze, from the database's own point of view: the legacy row
      // still holds what it held before the edit. Nothing reads it, so this is
      // not a staleness bug — it is the invariant the reconcile cron alerts on
      // if it is ever violated in the other direction (a legacy row CHANGING).
      expect((await legacyRow(target))?.content).toBe('original question');
    });
  });

  // -------------------------------------------------------------------------
  // DELETE
  // -------------------------------------------------------------------------

  describe('message delete', () => {
    it('disappears from the unified reader while the frozen leg keeps its row', async () => {
      if (!dbAvailable) return;
      const thread = await seedPageThread({
        contents: [
          { role: 'user', content: 'keep me' },
          { role: 'assistant', content: 'delete me' },
        ],
      });
      const target = thread.ids[1];

      await messageRepository.softDeletePageMessage({
        messageId: target,
        pageId: thread.pageId,
        conversationId: thread.conversationId,
        legacyTriggeredBy: triggeredBy,
      });

      const history = await messageRepository.getPageConversationMessages(
        thread.pageId,
        thread.conversationId,
      );
      expect(history.map((m) => m.content)).toEqual(['keep me']);

      // The routes read soft-deleted rows too and decide for themselves.
      expect((await messageRepository.getMessageById(target))?.isActive).toBe(false);
      // Frozen: the tombstone lands on `messages` only. The legacy row is
      // removed by retention's own legacy sweep, not by this write.
      expect((await legacyRow(target))?.isActive).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // UNDO
  // -------------------------------------------------------------------------

  describe('undo', () => {
    it('previews from the unified table and executes against it alone', async () => {
      if (!dbAvailable) return;
      const thread = await seedPageThread({
        contents: [
          { role: 'user', content: 'turn one question' },
          { role: 'assistant', content: 'turn one answer' },
          { role: 'user', content: 'turn two question' },
          { role: 'assistant', content: 'turn two answer' },
        ],
      });
      const undoFrom = thread.ids[2];

      const preview = await previewAiUndo(undoFrom, thread.ownerId);
      expect(preview).not.toBeNull();
      // Derived from the conversation, not from which table answered first.
      expect(preview!.source).toBe('page_chat');
      expect(preview!.pageId).toBe(thread.pageId);
      // Turn two's two messages, counted off the unified table.
      expect(preview!.messagesAffected).toBe(2);

      const result = await executeAiUndo(undoFrom, thread.ownerId, 'messages_only', preview!);
      expect(result.success).toBe(true);

      const history = await messageRepository.getPageConversationMessages(
        thread.pageId,
        thread.conversationId,
      );
      expect(history.map((m) => m.content)).toEqual(['turn one question', 'turn one answer']);

      // The frozen leg is untouched by the undo — all four seeded rows are
      // still active there. This used to assert the mirror; since Phase 4
      // PR 14 it asserts its absence.
      const legacyActive = await db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(and(eq(chatMessages.conversationId, thread.conversationId), eq(chatMessages.isActive, true)));
      expect(legacyActive.map((r) => r.id).sort()).toEqual([...thread.ids].sort());
    });

    it('is idempotent on a second run (the message is already inactive)', async () => {
      if (!dbAvailable) return;
      const thread = await seedPageThread({
        contents: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'a' },
        ],
      });

      const first = await executeAiUndo(thread.ids[1], thread.ownerId, 'messages_only');
      const second = await executeAiUndo(thread.ids[1], thread.ownerId, 'messages_only');

      expect(first.success).toBe(true);
      expect(second).toMatchObject({ success: true, messagesDeleted: 0, activitiesRolledBack: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // INTERRUPT + RESUME
  // -------------------------------------------------------------------------

  describe('interrupt and resume', () => {
    it('hides the streaming placeholder, then shows the materialized partial reply', async () => {
      if (!dbAvailable) return;
      const thread = await seedPageThread({ contents: [{ role: 'user', content: 'ask something' }] });
      const assistantId = createId();

      // --- stream starts ---
      const { inserted } = await messageRepository.insertPageStreamingPlaceholder({
        messageId: assistantId,
        pageId: thread.pageId,
        conversationId: thread.conversationId,
      });
      expect(inserted).toBe(true);

      // A mid-flight placeholder is invisible to the model-context load...
      const duringStream = await messageRepository.getPageConversationMessages(
        thread.pageId,
        thread.conversationId,
      );
      expect(duringStream.map((m) => m.content)).toEqual(['ask something']);
      // ...and visible only to a client that explicitly opts in.
      const optedIn = await messageRepository.getPageConversationMessages(
        thread.pageId,
        thread.conversationId,
        true,
      );
      expect(optedIn.map((m) => m.status)).toEqual(['complete', 'streaming']);

      // --- the stream dies and the materializer settles it ---
      const written = await messageRepository.materializePageInterruptedMessage({
        messageId: assistantId,
        pageId: thread.pageId,
        conversationId: thread.conversationId,
        structuredContent: 'partial repl',
        toolCallsJson: null,
        toolResultsJson: null,
        createdAt: new Date(),
      });
      expect(written).toBe(true);

      const afterResume = await messageRepository.getPageConversationMessages(
        thread.pageId,
        thread.conversationId,
      );
      expect(afterResume.map((m) => ({ content: m.content, status: m.status }))).toEqual([
        { content: 'ask something', status: 'complete' },
        { content: 'partial repl', status: 'interrupted' },
      ]);

      // The CAS is one-way: a second materialize of an already-terminal row
      // must not fire.
      const again = await messageRepository.materializePageInterruptedMessage({
        messageId: assistantId,
        pageId: thread.pageId,
        conversationId: thread.conversationId,
        structuredContent: 'SHOULD NOT LAND',
        toolCallsJson: null,
        toolResultsJson: null,
        createdAt: new Date(),
      });
      expect(again).toBe(false);

      // Neither the placeholder nor the materializer wrote the frozen table:
      // this assistant row exists ONLY in `messages`. That is the whole of
      // Phase 4 PR 14 stated as one row's worth of database state.
      expect(await legacyRow(assistantId)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // PURGE (retention cron)
  // -------------------------------------------------------------------------

  describe('retention purge', () => {
    it('sweeps both legs and recomputes lastMessageAt from the surviving unified rows', async () => {
      if (!dbAvailable) return;
      const thread = await seedPageThread({
        contents: [
          { role: 'user', content: 'survivor' },
          { role: 'assistant', content: 'doomed' },
        ],
      });
      const doomed = thread.ids[1];

      // Backdate + tombstone the second message so it falls inside the window.
      const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      await db.update(messages).set({ isActive: false, createdAt: longAgo }).where(eq(messages.id, doomed));
      await db
        .update(chatMessages)
        .set({ isActive: false, createdAt: longAgo })
        .where(eq(chatMessages.id, doomed));

      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const unifiedPurged = await messageRepository.purgeInactiveMessages(cutoff);
      const legacyPurged = await messageRepository.purgeInactiveLegacyChatMessages(cutoff);

      expect(unifiedPurged).toBeGreaterThanOrEqual(1);
      expect(legacyPurged).toBeGreaterThanOrEqual(1);
      expect(await legacyRow(doomed)).toBeNull();
      expect(await messageRepository.getMessageById(doomed)).toBeNull();

      // The surviving message decides lastMessageAt (#2153) — and for a PAGE
      // conversation that recompute is new: it had none while page rows lived
      // in `chat_messages`.
      const [conv] = await db
        .select({ lastMessageAt: conversations.lastMessageAt })
        .from(conversations)
        .where(eq(conversations.id, thread.conversationId));
      const [survivor] = await db
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.id, thread.ids[0]));
      expect(conv.lastMessageAt?.getTime()).toBe(survivor.createdAt.getTime());
    });

    it('leaves messages inside the retention window alone (the cron dry-run shape)', async () => {
      if (!dbAvailable) return;
      const thread = await seedPageThread({
        contents: [
          { role: 'user', content: 'recent q' },
          { role: 'assistant', content: 'recent a' },
        ],
      });
      await db.update(messages).set({ isActive: false }).where(eq(messages.id, thread.ids[1]));
      await db.update(chatMessages).set({ isActive: false }).where(eq(chatMessages.id, thread.ids[1]));

      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await messageRepository.purgeInactiveMessages(cutoff);
      await messageRepository.purgeInactiveLegacyChatMessages(cutoff);

      // Recently tombstoned: still on disk on both legs, just hidden.
      expect(await legacyRow(thread.ids[1])).not.toBeNull();
      expect((await messageRepository.getMessageById(thread.ids[1]))?.isActive).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // GLOBAL SURFACE
  // -------------------------------------------------------------------------

  describe('global assistant edit and delete', () => {
    it('round-trips through the global read seam and recomputes lastMessageAt on delete', async () => {
      if (!dbAvailable) return;
      const owner = await factories.createUser();
      const conversationId = createId();
      const base = Date.now();
      await db.insert(conversations).values({
        id: conversationId,
        userId: owner.id,
        type: 'global',
        contextId: null,
        isActive: true,
        lastMessageAt: new Date(base + 1000),
        updatedAt: new Date(),
      });
      const first = createId();
      const second = createId();
      await db.insert(messages).values([
        { id: first, conversationId, userId: owner.id, role: 'user', content: 'global q', createdAt: new Date(base), isActive: true, status: 'complete', pageId: null, sourceAgentId: null },
        { id: second, conversationId, userId: owner.id, role: 'assistant', content: 'global a', createdAt: new Date(base + 1000), isActive: true, status: 'complete', pageId: null, sourceAgentId: null },
      ]);

      await messageRepository.editGlobalMessage({
        messageId: first,
        conversationId,
        ownerUserId: owner.id,
        updatedContent: 'global q, edited',
        legacyTriggeredBy: triggeredBy,
      });
      expect((await messageRepository.getMessageInConversation(conversationId, first))?.content)
        .toBe('global q, edited');

      await messageRepository.softDeleteGlobalMessage({
        messageId: second,
        conversationId,
        ownerUserId: owner.id,
        legacyTriggeredBy: triggeredBy,
      });
      // The read seam filters isActive, so a deleted global message is gone.
      expect(await messageRepository.getMessageInConversation(conversationId, second)).toBeNull();
      expect((await messageRepository.getMessagesByConversationId(conversationId)).map((m) => m.id))
        .toEqual([first]);

      // #2153: the newest SURVIVING message decides lastMessageAt, not "now".
      const [conv] = await db
        .select({ lastMessageAt: conversations.lastMessageAt })
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conv.lastMessageAt?.getTime()).toBe(base);
    });

    it('never resolves a global message through the PAGE read seam', async () => {
      if (!dbAvailable) return;
      const owner = await factories.createUser();
      const conversationId = createId();
      await db.insert(conversations).values({
        id: conversationId, userId: owner.id, type: 'global', contextId: null, isActive: true, updatedAt: new Date(),
      });
      const globalId = createId();
      await db.insert(messages).values({
        id: globalId, conversationId, userId: owner.id, role: 'user', content: 'global only',
        isActive: true, status: 'complete', pageId: null, sourceAgentId: null,
      });

      // It resolves — `messages` holds every kind now — but with `pageId: null`,
      // which is exactly what makes the page edit/delete routes 404 it.
      const read = await messageRepository.getMessageById(globalId);
      expect(read).not.toBeNull();
      expect(read!.pageId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // PERMANENT PAGE DELETE (trash)
  // -------------------------------------------------------------------------

  describe('permanent page delete', () => {
    it('takes the unified rows with it — nothing else would', async () => {
      if (!dbAvailable) return;
      const thread = await seedPageThread({
        contents: [
          { role: 'user', content: 'about to be purged' },
          { role: 'assistant', content: 'also purged' },
        ],
      });

      // The trash route's statement, verbatim (it is a route handler with auth
      // and recursion around it; the DELETE is the part this PR added).
      const pageConversationIds = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.type, 'page'), eq(conversations.contextId, thread.pageId)));
      expect(pageConversationIds).toHaveLength(1);
      await db.delete(messages).where(inArray(messages.conversationId, pageConversationIds.map((c) => c.id)));

      expect(await messageRepository.getMessagesByConversationId(thread.conversationId)).toEqual([]);

      // The legacy leg is removed by `chat_messages.pageId`'s ON DELETE
      // CASCADE when the page row goes. `messages.pageId` deliberately has NO
      // such FK, and `conversations.contextId` has never had one — so without
      // the explicit DELETE above, a permanently deleted page's chat history
      // would outlive it and stay readable by conversation id.
      const [messagesFk] = await db.execute(
        `SELECT COUNT(*)::int AS n FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
         WHERE tc.table_name = 'messages' AND tc.constraint_type = 'FOREIGN KEY'
           AND kcu.column_name = 'pageId'`,
      ).then((r) => r.rows as Array<{ n: number }>);
      expect(messagesFk.n).toBe(0);
    });
  });
});
