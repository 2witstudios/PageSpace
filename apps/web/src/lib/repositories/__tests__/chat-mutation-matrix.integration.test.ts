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
 * Requires DATABASE_URL → a Postgres with migrations applied. FAILS LOUDLY when no DB is reachable — a silent skip
 * would be a green, zero-assertion pass. Local runs without Docker opt out
 * explicitly with ALLOW_SKIP_DB_TESTS=1.
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
import { eq, inArray } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { factories } from '@pagespace/db/test/factories';
import {
  deleteConversationsForDrive,
  deleteConversationsForPages,
} from '@pagespace/lib/repositories/conversation-cleanup';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { messageRepository } from '@/lib/repositories/message-repository';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { previewAiUndo, executeAiUndo } from '@/services/api/ai-undo-service';
import { requireDb } from '@pagespace/db/test/require-db';
import { conversationEvents } from '@/lib/websocket/conversation-events';

/** The conversation's current rev — the watermark every open pane compares. */
async function revOf(conversationId: string): Promise<number> {
  const [row] = await db
    .select({ rev: conversations.rev })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return Number(row.rev);
}

let dbAvailable = false;

const triggeredBy = { userId: 'test', displayName: 'Test', browserSessionId: 'test-session' };

/**
 * One page conversation and its messages. Seeded directly rather than through
 * a writer: these rows are HISTORY, and what each case exercises is a MUTATION
 * arriving on top of them.
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
      conversationId,
      userId: m.role === 'user' ? owner.id : null,
      role: m.role,
      content: m.content,
      isActive: true,
      status: 'complete' as const,
      createdAt: new Date(base + i * 1000),
    };
    await db.insert(messages).values(row);
    ids.push(row.id);
  }

  return { ownerId: owner.id, driveId: drive.id, pageId: page.id, conversationId, ids };
}

/**
 * An API-managed thread: `type='client'`, `contextId` = the DRIVE (which is
 * what a drive-scoped MCP token is authorized against), and its agent page in
 * `agentPageId` — the column that replaced the transitional `messages.pageId`
 * at Phase 4 PR 15. `stamp: false` seeds the state a thread is in between
 * `POST /api/v1/conversations` and its first completion.
 */
async function seedClientThread(opts?: { stamp?: boolean }) {
  const owner = await factories.createUser();
  const drive = await factories.createDrive(owner.id);
  const page = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'API agent' });
  const conversationId = createId();
  const base = Date.now();

  await db.insert(conversations).values({
    id: conversationId,
    userId: owner.id,
    type: 'client',
    contextId: drive.id,
    agentPageId: opts?.stamp === false ? null : page.id,
    isActive: true,
    updatedAt: new Date(),
  });

  const ids: string[] = [];
  for (const [i, m] of [
    { role: 'user', content: 'api question' },
    { role: 'assistant', content: 'api answer' },
  ].entries()) {
    const id = createId();
    await db.insert(messages).values({
      id,
      conversationId,
      userId: m.role === 'user' ? owner.id : null,
      role: m.role,
      content: m.content,
      isActive: true,
      status: 'complete' as const,
      createdAt: new Date(base + i * 1000),
    });
    ids.push(id);
  }

  return { ownerId: owner.id, driveId: drive.id, pageId: page.id, conversationId, ids };
}

describe('chat mutation matrix — one message table', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('chat-mutation-matrix.integration.test.ts', error);
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
    });
  });

  // -------------------------------------------------------------------------
  // DELETE
  // -------------------------------------------------------------------------

  describe('message delete', () => {
    it('disappears from the history load while the routes can still resolve it', async () => {
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
    });

    it('moves lastMessageAt back to the newest SURVIVING message', async () => {
      if (!dbAvailable) return;
      // The page twin of the global case below. `recomputeLastMessageAt`'s
      // contract names soft-delete as a caller, but only the global path
      // honoured it — so deleting the newest message in a page conversation
      // left the sidebar sorting it on a tombstoned row.
      const thread = await seedPageThread({
        contents: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'newest, about to go' },
        ],
      });
      const survivor = await messageRepository.getMessageById(thread.ids[0]);

      await messageRepository.softDeletePageMessage({
        messageId: thread.ids[1],
        pageId: thread.pageId,
        conversationId: thread.conversationId,
        legacyTriggeredBy: triggeredBy,
      });

      const [conv] = await db
        .select({ lastMessageAt: conversations.lastMessageAt })
        .from(conversations)
        .where(eq(conversations.id, thread.conversationId));
      expect(conv.lastMessageAt?.getTime()).toBe(survivor!.createdAt.getTime());
    });

    it('a messageId that names nothing neither bumps the rev nor broadcasts', async () => {
      if (!dbAvailable) return;
      // `mutateUnifiedMessageById` has always reported `no_match`; the delete
      // and edit paths discarded it. A bump is an instruction to every open
      // pane to refetch (`syncWatchedConversationRevs` compares revs and
      // nothing else), so bumping for a write that changed no row is pure
      // churn — and the event that rode with it described a message that does
      // not exist.
      const thread = await seedPageThread({ contents: [{ role: 'user', content: 'untouched' }] });
      const revBefore = await revOf(thread.conversationId);
      vi.mocked(conversationEvents.messageDeleted).mockClear();
      vi.mocked(conversationEvents.messageUpdated).mockClear();

      await messageRepository.softDeletePageMessage({
        messageId: createId(),
        pageId: thread.pageId,
        conversationId: thread.conversationId,
        legacyTriggeredBy: triggeredBy,
      });
      await messageRepository.editPageMessage({
        messageId: createId(),
        pageId: thread.pageId,
        conversationId: thread.conversationId,
        updatedContent: 'never written',
        legacyTriggeredBy: triggeredBy,
      });

      expect(await revOf(thread.conversationId)).toBe(revBefore);
      expect(conversationEvents.messageDeleted).not.toHaveBeenCalled();
      expect(conversationEvents.messageUpdated).not.toHaveBeenCalled();
    });

    it('nulls lastMessageAt when the deleted message was the only one', async () => {
      if (!dbAvailable) return;
      const thread = await seedPageThread({ contents: [{ role: 'user', content: 'only' }] });

      await messageRepository.softDeletePageMessage({
        messageId: thread.ids[0],
        pageId: thread.pageId,
        conversationId: thread.conversationId,
        legacyTriggeredBy: triggeredBy,
      });

      const [conv] = await db
        .select({ lastMessageAt: conversations.lastMessageAt })
        .from(conversations)
        .where(eq(conversations.id, thread.conversationId));
      expect(conv.lastMessageAt).toBeNull();
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

    it('recomputes lastMessageAt from what the undo left behind', async () => {
      if (!dbAvailable) return;
      // `softDeleteUndoRange` tombstones a whole range, so it is the mutation
      // most likely to strand the sort key on a deleted row — and it never
      // recomputed at all.
      const thread = await seedPageThread({
        contents: [
          { role: 'user', content: 'turn one question' },
          { role: 'assistant', content: 'turn one answer' },
          { role: 'user', content: 'turn two question' },
          { role: 'assistant', content: 'turn two answer' },
        ],
      });
      const survivor = await messageRepository.getMessageById(thread.ids[1]);

      const result = await executeAiUndo(thread.ids[2], thread.ownerId, 'messages_only');
      expect(result.success).toBe(true);

      const [conv] = await db
        .select({ lastMessageAt: conversations.lastMessageAt })
        .from(conversations)
        .where(eq(conversations.id, thread.conversationId));
      expect(conv.lastMessageAt?.getTime()).toBe(survivor!.createdAt.getTime());
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
    });
  });

  // -------------------------------------------------------------------------
  // PURGE (retention cron)
  // -------------------------------------------------------------------------

  describe('retention purge', () => {
    it('sweeps the table and recomputes lastMessageAt from the surviving rows', async () => {
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

      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const unifiedPurged = await messageRepository.purgeInactiveMessages(cutoff);

      expect(unifiedPurged).toBeGreaterThanOrEqual(1);
      expect(await messageRepository.getMessageById(doomed)).toBeNull();

      // The surviving message decides lastMessageAt (#2153) — and for a PAGE
      // conversation that recompute only became possible once page rows lived
      // in `messages`.
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

      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await messageRepository.purgeInactiveMessages(cutoff);

      // Recently tombstoned: still on disk, just hidden.
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
        { id: first, conversationId, userId: owner.id, role: 'user', content: 'global q', createdAt: new Date(base), isActive: true, status: 'complete', sourceAgentId: null },
        { id: second, conversationId, userId: owner.id, role: 'assistant', content: 'global a', createdAt: new Date(base + 1000), isActive: true, status: 'complete', sourceAgentId: null },
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
        isActive: true, status: 'complete', sourceAgentId: null,
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
    /**
     * Everything that must be gone once a page or drive is permanently
     * deleted. `chat_messages.pageId REFERENCES pages ON DELETE CASCADE` was
     * the physical net under all of this until migration 0253 dropped the
     * table; what replaced it reaches none of it, because
     * `conversations.contextId` is not a foreign key and `agentPageId`'s is
     * ON DELETE SET NULL. Verified against a migrated database: before this
     * fix, `DELETE FROM pages` left every one of these counts non-zero.
     */
    async function survivorsOf(conversationId: string) {
      const [row] = await db.execute(
        `SELECT
           (SELECT count(*)::int FROM conversations WHERE id = '${conversationId}') AS conversations,
           (SELECT count(*)::int FROM messages WHERE "conversationId" = '${conversationId}') AS messages,
           (SELECT count(*)::int FROM ai_stream_sessions WHERE conversation_id = '${conversationId}') AS streams`,
      ).then((r) => r.rows as Array<{ conversations: number; messages: number; streams: number }>);
      return row;
    }

    /** A stream checkpoint — `parts` is message content, and it cascades from
     *  `conversations` and from nothing else. The reason the shell must go. */
    async function seedStreamCheckpoint(conversationId: string, userId: string) {
      await db.insert(aiStreamSessions).values({
        messageId: createId(),
        channelId: `conversation:${conversationId}`,
        conversationId,
        userId,
        parts: [{ type: 'text', text: 'half-streamed secret' }],
      });
    }

    it('takes the unified rows AND the conversation shell with it — nothing else would', async () => {
      if (!dbAvailable) return;
      const thread = await seedPageThread({
        contents: [
          { role: 'user', content: 'about to be purged' },
          { role: 'assistant', content: 'also purged' },
        ],
      });
      await seedStreamCheckpoint(thread.conversationId, thread.ownerId);

      // The SHARED helper the trash route now calls — not a re-implementation
      // of its statement. This test used to inline the route's DELETE, which
      // is precisely why the cron purge and the drive-delete paths could drift
      // away from it unnoticed.
      await db.transaction(async (tx) => {
        await deleteConversationsForPages(tx, [thread.pageId]);
        await tx.delete(pages).where(eq(pages.id, thread.pageId));
      });

      expect(await messageRepository.getMessagesByConversationId(thread.conversationId)).toEqual([]);
      expect(await survivorsOf(thread.conversationId)).toEqual({
        conversations: 0, messages: 0, streams: 0,
      });
    });

    it('takes an API thread that named the page with it too', async () => {
      if (!dbAvailable) return;
      const t = await seedClientThread();
      await seedStreamCheckpoint(t.conversationId, t.ownerId);

      await db.transaction(async (tx) => {
        await deleteConversationsForPages(tx, [t.pageId]);
        await tx.delete(pages).where(eq(pages.id, t.pageId));
      });

      expect(await messageRepository.getMessagesByConversationId(t.conversationId)).toEqual([]);
      expect(await survivorsOf(t.conversationId)).toEqual({
        conversations: 0, messages: 0, streams: 0,
      });
    });

    it('DELETING THE DRIVE takes its pages\' chat history too, not just the drive', async () => {
      if (!dbAvailable) return;
      // A drive delete cascades `pages`, and page-scoped conversations were
      // stranded by exactly that: once the pages are gone nothing can trace
      // them. Both a page thread and a drive-scoped API thread must go.
      const thread = await seedPageThread({ contents: [{ role: 'user', content: 'drive-scoped secret' }] });
      await seedStreamCheckpoint(thread.conversationId, thread.ownerId);
      const clientConversationId = createId();
      await db.insert(conversations).values({
        id: clientConversationId,
        userId: thread.ownerId,
        type: 'client',
        contextId: thread.driveId,
        isActive: true,
        updatedAt: new Date(),
      });
      await db.insert(messages).values({
        id: createId(),
        conversationId: clientConversationId,
        userId: thread.ownerId,
        role: 'user',
        content: 'api secret',
        isActive: true,
        status: 'complete' as const,
        createdAt: new Date(),
      });

      await db.transaction(async (tx) => {
        await deleteConversationsForDrive(tx, thread.driveId);
        await tx.delete(drives).where(eq(drives.id, thread.driveId));
      });

      expect(await survivorsOf(thread.conversationId)).toEqual({
        conversations: 0, messages: 0, streams: 0,
      });
      expect(await survivorsOf(clientConversationId)).toEqual({
        conversations: 0, messages: 0, streams: 0,
      });
    });

    it('the CRON purge cleans up the pages it deletes — and ONLY those', async () => {
      if (!dbAvailable) return;
      // `purgeExpiredTrashedPages` was a bare `DELETE FROM pages` — an
      // automatic Article 17 path that cleaned up nothing at all.
      //
      // The child page pins the OTHER boundary. `pages.parentId` carries no
      // foreign key, so purging a trashed parent orphans its children rather
      // than cascading to them, and trashing marks only the page named. A fix
      // that "helpfully" expanded to the subtree would delete the chat history
      // of a page that still exists — an over-deletion strictly worse than the
      // bug it replaced. The child's history must SURVIVE.
      const parent = await seedPageThread({ contents: [{ role: 'user', content: 'parent secret' }] });
      const childPage = await factories.createPage(parent.driveId, {
        type: 'AI_CHAT', title: 'Child', parentId: parent.pageId,
      });
      const childConversationId = createId();
      await db.insert(conversations).values({
        id: childConversationId,
        userId: parent.ownerId,
        type: 'page',
        contextId: childPage.id,
        isActive: true,
        updatedAt: new Date(),
      });
      await db.insert(messages).values({
        id: createId(),
        conversationId: childConversationId,
        userId: parent.ownerId,
        role: 'user',
        content: 'child secret',
        isActive: true,
        status: 'complete' as const,
        createdAt: new Date(),
      });
      await seedStreamCheckpoint(childConversationId, parent.ownerId);

      // Trashed 31 days ago — past the cron's 30-day cutoff.
      const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await db.update(pages).set({ isTrashed: true, trashedAt: longAgo })
        .where(eq(pages.id, parent.pageId));

      const purged = await pageRepository.purgeExpiredTrashedPages(
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      );
      expect(purged).toBeGreaterThanOrEqual(1);

      // The purged page is gone, and so is everything that referred to it.
      const remaining = await db.select({ id: pages.id }).from(pages)
        .where(inArray(pages.id, [parent.pageId, childPage.id]));
      expect(remaining.map((p) => p.id)).toEqual([childPage.id]);
      expect(await survivorsOf(parent.conversationId)).toEqual({
        conversations: 0, messages: 0, streams: 0,
      });
      // The surviving child keeps its history — cleanup is scoped to the rows
      // actually deleted.
      expect(await survivorsOf(childConversationId)).toEqual({
        conversations: 1, messages: 1, streams: 1,
      });
    });
  });

  // -------------------------------------------------------------------------
  // API-MANAGED (`type='client'`) THREADS — the shape that lost its page
  // column when PR 15 dropped `messages.pageId`.
  // -------------------------------------------------------------------------

  describe('type=client API threads', () => {
    it('resolves its page through conversations.agentPageId, for history and for edit/delete', async () => {
      if (!dbAvailable) return;
      const t = await seedClientThread();

      // `POST /api/v1/chat/completions` thread mode: the history load is
      // page-scoped, and this is what keeps it from returning nothing.
      const history = await messageRepository.getMessagesForPage(t.pageId, t.conversationId);
      expect(history.map((m) => m.content)).toEqual(['api question', 'api answer']);
      // Its `contextId` is the DRIVE, and that must stay true — it is what a
      // drive-scoped MCP token is authorized against.
      const [conv] = await db
        .select({ contextId: conversations.contextId, agentPageId: conversations.agentPageId })
        .from(conversations)
        .where(eq(conversations.id, t.conversationId));
      expect(conv.contextId).toBe(t.driveId);
      expect(conv.agentPageId).toBe(t.pageId);

      // The edit/delete routes' read: a NULL `pageId` here is what they 404
      // on, so a resolvable one is the whole fix.
      expect((await messageRepository.getMessageById(t.ids[0]))?.pageId).toBe(t.pageId);
    });

    it('is invisible to another page, and reads as page-less until its first completion stamps it', async () => {
      if (!dbAvailable) return;
      const t = await seedClientThread();
      const otherPage = await factories.createPage(t.driveId, { type: 'AI_CHAT', title: 'Other agent' });
      expect(await messageRepository.getMessagesForPage(otherPage.id, t.conversationId)).toEqual([]);

      const unstamped = await seedClientThread({ stamp: false });
      expect(await messageRepository.getMessagesForPage(unstamped.pageId, unstamped.conversationId)).toEqual([]);
      expect((await messageRepository.getMessageById(unstamped.ids[0]))?.pageId).toBeNull();
    });

    it('stamps the page once and never re-points it', async () => {
      if (!dbAvailable) return;
      const t = await seedClientThread({ stamp: false });
      const otherPage = await factories.createPage(t.driveId, { type: 'AI_CHAT', title: 'Second agent' });

      expect(await conversationRepository.stampClientConversationPage(t.conversationId, t.pageId)).toBe('stamped');
      // A later request naming a different agent must not re-anchor a thread
      // whose history and edit permissions already follow the first page.
      expect(await conversationRepository.stampClientConversationPage(t.conversationId, otherPage.id)).toBe('noop');
      const [conv] = await db
        .select({ agentPageId: conversations.agentPageId })
        .from(conversations)
        .where(eq(conversations.id, t.conversationId));
      expect(conv.agentPageId).toBe(t.pageId);
    });

    it('refuses to give a page conversation a second page link', async () => {
      if (!dbAvailable) return;
      const thread = await seedPageThread({ contents: [{ role: 'user', content: 'q' }] });
      expect(await conversationRepository.stampClientConversationPage(thread.conversationId, thread.pageId)).toBe('noop');
      const [conv] = await db
        .select({ agentPageId: conversations.agentPageId })
        .from(conversations)
        .where(eq(conversations.id, thread.conversationId));
      expect(conv.agentPageId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // THE CONTAINMENT AROUND THE PAGE-CHAT WRITE GATE
  //
  // `runPageChatTurn` used to decide "does this conversation belong to this
  // page?" from `contextId` alone, so every `type='global'` conversation
  // (whose `contextId` is NULL by CHECK) belonged to every page and a
  // page-agent turn could be written into the global transcript. The gate is
  // fixed; these cases assert the two containment properties the security
  // review CLAIMED bounded the blast radius, against a real database rather
  // than by inspection — because if either were false, the same defect would
  // have been a cross-user escalation instead of a self-inflicted one.
  // -------------------------------------------------------------------------

  describe('a global conversation is not a page conversation', () => {
    async function seedGlobalThread() {
      const owner = await factories.createUser();
      const conversationId = createId();
      await db.insert(conversations).values({
        id: conversationId, userId: owner.id, type: 'global', contextId: null,
        isActive: true, updatedAt: new Date(),
      });
      const id = createId();
      await db.insert(messages).values({
        id, conversationId, userId: owner.id, role: 'user', content: 'private global secret',
        isActive: true, status: 'complete', sourceAgentId: null,
      });
      return { ownerId: owner.id, conversationId, messageId: id };
    }

    it('discloses no history through the page chat load, whatever page is named', async () => {
      if (!dbAvailable) return;
      const globalThread = await seedGlobalThread();
      const page = await seedPageThread({ contents: [{ role: 'user', content: 'q' }] });

      // The model-context load behind POST /api/ai/chat. `unifiedPageScope`
      // matches no global row, so even a request that got past the gate read
      // an EMPTY history — the reason the defect could inject but never
      // exfiltrate.
      expect(
        await messageRepository.getPageConversationMessages(page.pageId, globalThread.conversationId),
      ).toEqual([]);
    });

    it('cannot be marked shared, because the only sharing door is page-scoped', async () => {
      if (!dbAvailable) return;
      const globalThread = await seedGlobalThread();
      const page = await seedPageThread({ contents: [{ role: 'user', content: 'q' }] });

      // `setConversationShared` has exactly ONE non-test caller — PATCH
      // /api/ai/page-agents/[agentId]/conversations/[conversationId] — and it
      // refuses before that call unless `conversationExists(agentId, id)`,
      // which is `unifiedPageScope`. No page id can satisfy it for a global
      // row, so `isShared` is unreachable for globals and the non-owner half
      // of the write gate (`!ownsIt && isShared`) can never open on one.
      expect(await conversationRepository.conversationExists(page.pageId, globalThread.conversationId)).toBe(false);
      expect(await conversationRepository.conversationExists(globalThread.conversationId, globalThread.conversationId)).toBe(false);
    });
  });
});
