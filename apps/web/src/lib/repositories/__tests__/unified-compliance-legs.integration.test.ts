/**
 * COMPLIANCE OVER A DUAL-WRITTEN CORPUS, against a REAL Postgres.
 *
 * Epic "Agent-Session Single Source of Truth", Phase 4 / D6, PR 13. The pure
 * table-level contract lives in
 * `packages/lib/src/compliance/__tests__/message-unification-compliance-legs.test.ts`;
 * this suite proves the same three rules end to end, over a corpus written by
 * the PRODUCTION dual-writer (`messageRepository`), because the claims are
 * about what the data actually looks like once both legs exist:
 *
 *   RULE 1 — the GDPR export reads the UNIFIED table only, and that is
 *            COMPLETE: every message appears EXACTLY ONCE (no duplicate from
 *            double-reading, no omission).
 *   RULE 2 — erasure and retention still reach BOTH legs, including rows the
 *            FK graph only started reaching at 0249/0250.
 *   RULE 3 — the new cascades (conversations → chat_messages,
 *            conversations → ai_stream_sessions) delete what they claim to.
 *
 * It also pins the NULL-`userId` class of bug directly: `messages.userId` is
 * the HUMAN author and is NULL for every agent-authored row, so any
 * compliance query keyed on it alone silently skips the agent side of the
 * subject's own conversations.
 *
 * Requires DATABASE_URL → a Postgres with migrations applied. FAILS LOUDLY when no DB is reachable — a silent skip
 * would be a green, zero-assertion pass. Local runs without Docker opt out
 * explicitly with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { aiStreamSessions, aiPendingAbortIntents } from '@pagespace/db/schema/ai-streams';
import { factories } from '@pagespace/db/test/factories';
import { collectUserMessages } from '@pagespace/lib/compliance/export/gdpr-export';
import { cleanupSoftDeletedChatRecords } from '@pagespace/lib/compliance/retention/retention-engine';
import { deleteStreamStateForUser } from '@pagespace/lib/compliance/erasure/purge-stream-state';
import { messageRepository } from '@/lib/repositories/message-repository';
import { requireDb } from '@pagespace/db/test/require-db';

let dbAvailable = false;

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/** Minimal stream row — the shape whose `parts` checkpoint is message content. */
async function seedStreamSession(args: {
  conversationId: string;
  userId: string;
  messageId?: string;
}): Promise<string> {
  const messageId = args.messageId ?? createId();
  await db.insert(aiStreamSessions).values({
    messageId,
    channelId: `chan-${args.conversationId}`,
    conversationId: args.conversationId,
    userId: args.userId,
    parts: [{ type: 'text', text: 'checkpointed content' }],
  });
  return messageId;
}

describe('compliance over the unified message corpus (Phase 4 PR 13; one table since PR 15)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('unified-compliance-legs.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  // ==========================================================================
  // RULE 1 — export the unified leg only, exactly once, and completely.
  // ==========================================================================
  describe('RULE 1 — GDPR export reads the unified table only', () => {
    interface ExportCorpus {
      ownerId: string;
      bystanderId: string;
      agentPageId: string;
      pageConversationId: string;
      globalConversationId: string;
      ownerQuestionId: string;
      agentReplyId: string;
      bystanderMessageId: string;
      globalQuestionId: string;
      globalReplyId: string;
    }
    let corpus: ExportCorpus;

    beforeAll(async () => {
      if (!dbAvailable) return;

      const owner = await factories.createUser();
      const bystander = await factories.createUser();
      const drive = await factories.createDrive(owner.id);
      const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Agent' });

      const pageConversationId = createId();
      const globalConversationId = createId();
      await db.insert(conversations).values([
        // SHARED: a page conversation the owner owns but any member with page
        // access may also post into — the shape that makes "export everything
        // in the subject's conversations" wrong.
        { id: pageConversationId, userId: owner.id, type: 'page', contextId: agentPage.id, title: 'Thread', isShared: true, updatedAt: new Date() },
        { id: globalConversationId, userId: owner.id, type: 'global', contextId: null, title: 'Global', updatedAt: new Date() },
      ]);

      const ownerQuestionId = createId();
      const agentReplyId = createId();
      const bystanderMessageId = createId();
      const globalQuestionId = createId();
      const globalReplyId = createId();

      // THE PRODUCTION WRITER — one table.
      await messageRepository.savePageMessage({
        messageId: ownerQuestionId,
        pageId: agentPage.id,
        conversationId: pageConversationId,
        userId: owner.id,
        role: 'user',
        content: 'owner question',
      });
      // Agent-authored: userId NULL, sourceAgentId set. The row the export
      // used to drop on the floor.
      await messageRepository.savePageMessage({
        messageId: agentReplyId,
        pageId: agentPage.id,
        conversationId: pageConversationId,
        userId: null,
        role: 'assistant',
        content: 'agent reply',
        sourceAgentId: agentPage.id,
      });
      // Another HUMAN inside the subject's shared conversation.
      await messageRepository.savePageMessage({
        messageId: bystanderMessageId,
        pageId: agentPage.id,
        conversationId: pageConversationId,
        userId: bystander.id,
        role: 'user',
        content: 'bystander question',
      });

      // Global history — one leg, always has been.
      await messageRepository.saveGlobalMessage({
        messageId: globalQuestionId,
        conversationId: globalConversationId,
        userId: owner.id,
        role: 'user',
        content: 'global question',
      });
      await messageRepository.saveGlobalMessage({
        messageId: globalReplyId,
        conversationId: globalConversationId,
        userId: owner.id,
        role: 'assistant',
        content: 'global reply',
      });

      corpus = {
        ownerId: owner.id,
        bystanderId: bystander.id,
        agentPageId: agentPage.id,
        pageConversationId,
        globalConversationId,
        ownerQuestionId,
        agentReplyId,
        bystanderMessageId,
        globalQuestionId,
        globalReplyId,
      };
    });

    it('the corpus really is what the rules below are asserted over', async () => {
      if (!dbAvailable) return;

      const unified = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.conversationId, corpus.pageConversationId));

      expect(unified).toHaveLength(3);
    });

    it('exports every message EXACTLY ONCE — reading both legs would duplicate each page-chat row under its shared primary key', async () => {
      if (!dbAvailable) return;

      const exported = await collectUserMessages(db, corpus.ownerId);
      const ids = exported.map((m) => m.id);

      expect(new Set(ids).size).toBe(ids.length);
    });

    it('is COMPLETE for the subject: their own page question, the AGENT reply in their thread, and both global rows', async () => {
      if (!dbAvailable) return;

      const ids = (await collectUserMessages(db, corpus.ownerId)).map((m) => m.id);

      expect(ids).toContain(corpus.ownerQuestionId);
      expect(ids).toContain(corpus.globalQuestionId);
      expect(ids).toContain(corpus.globalReplyId);
      // THE GAP THIS PR CLOSES. `messages.userId` is NULL for an agent-authored
      // row, so filtering on it alone exported the subject's questions and
      // dropped every answer inside their own page chats — while the SAME
      // answer in a global thread was exported, because the global writer
      // stamps the owner's id on assistant rows.
      expect(ids).toContain(corpus.agentReplyId);
    });

    it('does NOT export another human\'s message from the subject\'s shared conversation (Art 15(4) — the subject\'s access must not affect others\' rights)', async () => {
      if (!dbAvailable) return;

      const ids = (await collectUserMessages(db, corpus.ownerId)).map((m) => m.id);
      expect(ids).not.toContain(corpus.bystanderMessageId);
    });

    it('exports the bystander\'s OWN message from that conversation, and none of its agent rows — authorship, not thread membership, is the key', async () => {
      if (!dbAvailable) return;

      const ids = (await collectUserMessages(db, corpus.bystanderId)).map((m) => m.id);
      expect(ids).toContain(corpus.bystanderMessageId);
      expect(ids).not.toContain(corpus.agentReplyId);
      expect(ids).not.toContain(corpus.ownerQuestionId);
    });

    it('labels the page rows ai_chat with the pageId taken from conversations.contextId, and the global rows conversation', async () => {
      if (!dbAvailable) return;

      const exported = await collectUserMessages(db, corpus.ownerId);
      const pageRow = exported.find((m) => m.id === corpus.agentReplyId);
      const globalRow = exported.find((m) => m.id === corpus.globalReplyId);

      expect(pageRow).toEqual(
        expect.objectContaining({ source: 'ai_chat', pageId: corpus.agentPageId })
      );
      expect(globalRow?.source).toBe('conversation');
      expect(globalRow?.pageId).toBeUndefined();
    });

  });

  // ==========================================================================
  // RULE 2 — erasure reaches BOTH legs, plus the stream state no FK reached.
  // ==========================================================================
  describe('RULE 2 — erasure reaches every message and the subject\'s stream state', () => {
    it('deleting the user removes their messages — including the agent-authored (userId NULL) row, which only the conversations FK reaches', async () => {
      if (!dbAvailable) return;

      const subject = await factories.createUser();
      const drive = await factories.createDrive(subject.id);
      const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Agent' });
      const conversationId = createId();
      await db.insert(conversations).values({
        id: conversationId, userId: subject.id, type: 'page', contextId: agentPage.id, updatedAt: new Date(),
      });

      const questionId = createId();
      const agentReplyId = createId();
      await messageRepository.savePageMessage({
        messageId: questionId, pageId: agentPage.id, conversationId,
        userId: subject.id, role: 'user', content: 'question',
      });
      await messageRepository.savePageMessage({
        messageId: agentReplyId, pageId: agentPage.id, conversationId,
        userId: null, role: 'assistant', content: 'reply', sourceAgentId: agentPage.id,
      });

      await db.delete(users).where(eq(users.id, subject.id));

      const unifiedLeft = await db
        .select({ id: messages.id })
        .from(messages)
        .where(inArray(messages.id, [questionId, agentReplyId]));

      // The user-authored row goes via `userId → users`; the agent-authored
      // one has no userId at all and is reached only through `conversations`.
      // Both paths must land, or an erasure request leaves content behind.
      expect(unifiedLeft).toEqual([]);
    });

    it('deleting the user takes the stream checkpoints in their own conversation with it (0250 cascade)', async () => {
      if (!dbAvailable) return;

      const subject = await factories.createUser();
      const conversationId = createId();
      await db.insert(conversations).values({
        id: conversationId, userId: subject.id, type: 'global', contextId: null, updatedAt: new Date(),
      });
      const streamMessageId = await seedStreamSession({ conversationId, userId: subject.id });

      await db.delete(users).where(eq(users.id, subject.id));

      const left = await db
        .select({ messageId: aiStreamSessions.messageId })
        .from(aiStreamSessions)
        .where(eq(aiStreamSessions.messageId, streamMessageId));
      expect(left).toEqual([]);
    });

    it('purge-stream-state removes the subject\'s stream rows inside SOMEONE ELSE\'S conversation — no cascade reaches those, and nothing else in the codebase ever deletes them', async () => {
      if (!dbAvailable) return;

      const owner = await factories.createUser();
      const subject = await factories.createUser();
      const hostConversationId = createId();
      await db.insert(conversations).values({
        id: hostConversationId, userId: owner.id, type: 'global', contextId: null, updatedAt: new Date(),
      });
      const strandedStreamId = await seedStreamSession({
        conversationId: hostConversationId,
        userId: subject.id,
      });
      await db.insert(aiPendingAbortIntents).values({
        conversationId: hostConversationId,
        userId: subject.id,
      });

      // Deleting the user alone leaves both rows behind: neither table
      // references `users`, and the host conversation belongs to someone else.
      await db.delete(users).where(eq(users.id, subject.id));
      const survivedTheCascade = await db
        .select({ messageId: aiStreamSessions.messageId })
        .from(aiStreamSessions)
        .where(eq(aiStreamSessions.messageId, strandedStreamId));
      expect(survivedTheCascade).toHaveLength(1);

      // The erasure step is what reaches them.
      const result = await deleteStreamStateForUser(subject.id);
      expect(result.streamSessions).toBe(1);
      expect(result.abortIntents).toBe(1);

      const streamsLeft = await db
        .select({ messageId: aiStreamSessions.messageId })
        .from(aiStreamSessions)
        .where(eq(aiStreamSessions.messageId, strandedStreamId));
      const intentsLeft = await db
        .select({ userId: aiPendingAbortIntents.userId })
        .from(aiPendingAbortIntents)
        .where(eq(aiPendingAbortIntents.conversationId, hostConversationId));
      expect(streamsLeft).toEqual([]);
      expect(intentsLeft).toEqual([]);
    });
  });

  // ==========================================================================
  // RULE 2/3 — retention sweeps both legs, and its cascade is real.
  // ==========================================================================
  describe('RULE 2/3 — retention sweeps the table and cascades as documented', () => {
    it('hard-deletes soft-deleted messages, and a purged conversation takes its rows and stream state with it', async () => {
      if (!dbAvailable) return;

      const owner = await factories.createUser();
      const drive = await factories.createDrive(owner.id);
      const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Agent' });

      // (a) a soft-deleted message pair in a conversation that stays ACTIVE —
      //     only the age-based sweeps can reach these.
      const liveConversationId = createId();
      // (b) a soft-deleted CONVERSATION past its window — its rows are still
      //     marked active, so ONLY the cascade can reach them.
      const purgedConversationId = createId();
      await db.insert(conversations).values([
        { id: liveConversationId, userId: owner.id, type: 'page', contextId: agentPage.id, isActive: true, updatedAt: new Date() },
        { id: purgedConversationId, userId: owner.id, type: 'page', contextId: agentPage.id, isActive: false, updatedAt: daysAgo(90) },
      ]);

      const staleUnifiedId = createId();
      const cascadedUnifiedId = createId();
      const old = daysAgo(90);

      await db.insert(messages).values([
        { id: staleUnifiedId, conversationId: liveConversationId, role: 'user', content: 'soft-deleted', isActive: false, createdAt: old, userId: owner.id },
        { id: cascadedUnifiedId, conversationId: purgedConversationId, role: 'user', content: 'still active', isActive: true, createdAt: old, userId: owner.id },
      ]);
      const cascadedStreamId = await seedStreamSession({
        conversationId: purgedConversationId,
        userId: owner.id,
      });

      const results = await cleanupSoftDeletedChatRecords(db);

      // Every swept table is named in the report — the cron output is where a
      // sweep that silently stopped working would first be visible.
      expect(results.map((r) => r.table)).toEqual(
        expect.arrayContaining(['messages', 'conversations'])
      );
      // …and the dropped leg is NOT, because it no longer exists.
      expect(results.map((r) => r.table)).not.toContain('chat_messages');

      const unifiedLeft = await db
        .select({ id: messages.id })
        .from(messages)
        .where(inArray(messages.id, [staleUnifiedId, cascadedUnifiedId]));
      const conversationLeft = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, purgedConversationId));
      const streamLeft = await db
        .select({ messageId: aiStreamSessions.messageId })
        .from(aiStreamSessions)
        .where(eq(aiStreamSessions.messageId, cascadedStreamId));

      // The age-based sweep got the soft-deleted row; the conversations
      // delete cascaded into the still-active one and into the stream
      // checkpoints (0250). Nothing that was condemned survived.
      expect(unifiedLeft).toEqual([]);
      expect(conversationLeft).toEqual([]);
      expect(streamLeft).toEqual([]);

      // The still-active conversation is untouched.
      const liveLeft = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, liveConversationId), eq(conversations.isActive, true)));
      expect(liveLeft).toHaveLength(1);
    });

    it('leaves recent soft-deleted rows alone — the grace period is real', async () => {
      if (!dbAvailable) return;

      const owner = await factories.createUser();
      const drive = await factories.createDrive(owner.id);
      const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Agent' });
      const conversationId = createId();
      await db.insert(conversations).values({
        id: conversationId, userId: owner.id, type: 'page', contextId: agentPage.id, isActive: true, updatedAt: new Date(),
      });

      const recentUnifiedId = createId();
      await db.insert(messages).values({
        id: recentUnifiedId, conversationId, role: 'user',
        content: 'just deleted', isActive: false, createdAt: new Date(), userId: owner.id,
      });

      await cleanupSoftDeletedChatRecords(db);

      const unifiedLeft = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.id, recentUnifiedId));
      expect(unifiedLeft).toHaveLength(1);
    });
  });
});
