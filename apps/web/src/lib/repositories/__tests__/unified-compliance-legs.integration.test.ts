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
 *            FK graph only started reaching at 0248/0249.
 *   RULE 3 — the new cascades (conversations → chat_messages,
 *            conversations → ai_stream_sessions) delete what they claim to.
 *
 * It also pins the NULL-`userId` class of bug directly: `messages.userId` is
 * the HUMAN author and is NULL for every agent-authored row, so any
 * compliance query keyed on it alone silently skips the agent side of the
 * subject's own conversations.
 *
 * Requires DATABASE_URL → a Postgres with migrations applied. Skipped when no
 * DB is reachable, mirroring `unified-reader-parity.integration.test.ts`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { pages, chatMessages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { aiStreamSessions, aiPendingAbortIntents } from '@pagespace/db/schema/ai-streams';
import { factories } from '@pagespace/db/test/factories';
import { collectUserMessages } from '@pagespace/lib/compliance/export/gdpr-export';
import { cleanupSoftDeletedChatRecords } from '@pagespace/lib/compliance/retention/retention-engine';
import { deleteStreamStateForUser } from '@pagespace/lib/compliance/erasure/purge-stream-state';
import { messageRepository } from '@/lib/repositories/message-repository';

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

describe('compliance over a dual-written message corpus (Phase 4 PR 13)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch {
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

      // THE DUAL-WRITE PATH — the production writer, both legs, one transaction.
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

    it('the dual-writer really did populate BOTH legs — without this the rest of the suite proves nothing', async () => {
      if (!dbAvailable) return;

      const legacy = await db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(eq(chatMessages.conversationId, corpus.pageConversationId));
      const unified = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.conversationId, corpus.pageConversationId));

      expect(legacy.map((r) => r.id).sort()).toEqual(unified.map((r) => r.id).sort());
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

    it('covers every legacy-leg row the subject authored — the unified leg is a SUPERSET, which is the premise of reading it alone', async () => {
      if (!dbAvailable) return;

      const legacyOwn = await db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.conversationId, corpus.pageConversationId),
            eq(chatMessages.userId, corpus.ownerId)
          )
        );
      const exportedIds = new Set((await collectUserMessages(db, corpus.ownerId)).map((m) => m.id));

      expect(legacyOwn.length).toBeGreaterThan(0);
      for (const row of legacyOwn) expect(exportedIds.has(row.id)).toBe(true);
    });
  });

  // ==========================================================================
  // RULE 2 — erasure reaches BOTH legs, plus the stream state no FK reached.
  // ==========================================================================
  describe('RULE 2 — erasure reaches both message legs and the subject\'s stream state', () => {
    it('deleting the user removes their rows from BOTH message tables — including the agent-authored (userId NULL) row, which only the 0248 conversations FK reaches', async () => {
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

      const legacyLeft = await db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(inArray(chatMessages.id, [questionId, agentReplyId]));
      const unifiedLeft = await db
        .select({ id: messages.id })
        .from(messages)
        .where(inArray(messages.id, [questionId, agentReplyId]));

      // The user-authored row goes via `userId → users` on BOTH legs; the
      // agent-authored one has no userId at all and is reached only through
      // `conversations` — on the unified leg by its long-standing FK, on the
      // legacy leg by the FK migration 0248 added. Erasure must keep naming
      // both tables until PR 15 drops chat_messages.
      expect(legacyLeft).toEqual([]);
      expect(unifiedLeft).toEqual([]);
    });

    it('deleting the user takes the stream checkpoints in their own conversation with it (0249 cascade)', async () => {
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
  describe('RULE 2/3 — retention sweeps both legs and cascades as documented', () => {
    it('hard-deletes soft-deleted rows from BOTH message tables, and a purged conversation takes its legacy rows and stream state with it', async () => {
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

      const staleLegacyOnlyId = createId();
      const staleUnifiedId = createId();
      const cascadedLegacyId = createId();
      const cascadedUnifiedId = createId();
      const old = daysAgo(90);

      await db.insert(chatMessages).values([
        { id: staleLegacyOnlyId, pageId: agentPage.id, conversationId: liveConversationId, role: 'user', content: 'soft-deleted', isActive: false, createdAt: old, userId: owner.id },
        { id: cascadedLegacyId, pageId: agentPage.id, conversationId: purgedConversationId, role: 'user', content: 'still active', isActive: true, createdAt: old, userId: owner.id },
      ]);
      await db.insert(messages).values([
        { id: staleUnifiedId, conversationId: liveConversationId, role: 'user', content: 'soft-deleted', isActive: false, createdAt: old, userId: owner.id },
        { id: cascadedUnifiedId, conversationId: purgedConversationId, role: 'user', content: 'still active', isActive: true, createdAt: old, userId: owner.id },
      ]);
      const cascadedStreamId = await seedStreamSession({
        conversationId: purgedConversationId,
        userId: owner.id,
      });

      const results = await cleanupSoftDeletedChatRecords(db);

      // Both legs are named in the report — the cron output is where a leg
      // that silently stopped working would first be visible.
      expect(results.map((r) => r.table)).toEqual(
        expect.arrayContaining(['chat_messages', 'messages', 'conversations'])
      );

      const legacyLeft = await db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(inArray(chatMessages.id, [staleLegacyOnlyId, cascadedLegacyId]));
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

      // The age-based sweeps got the soft-deleted rows on both legs; the
      // conversations delete cascaded into the still-active ones (0248) and
      // into the stream checkpoints (0249). Nothing that was condemned
      // survived, on either leg.
      expect(legacyLeft).toEqual([]);
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

    it('leaves recent soft-deleted rows alone on both legs — the grace period is not leg-dependent', async () => {
      if (!dbAvailable) return;

      const owner = await factories.createUser();
      const drive = await factories.createDrive(owner.id);
      const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Agent' });
      const conversationId = createId();
      await db.insert(conversations).values({
        id: conversationId, userId: owner.id, type: 'page', contextId: agentPage.id, isActive: true, updatedAt: new Date(),
      });

      const recentLegacyId = createId();
      const recentUnifiedId = createId();
      await db.insert(chatMessages).values({
        id: recentLegacyId, pageId: agentPage.id, conversationId, role: 'user',
        content: 'just deleted', isActive: false, createdAt: new Date(), userId: owner.id,
      });
      await db.insert(messages).values({
        id: recentUnifiedId, conversationId, role: 'user',
        content: 'just deleted', isActive: false, createdAt: new Date(), userId: owner.id,
      });

      await cleanupSoftDeletedChatRecords(db);

      const legacyLeft = await db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(eq(chatMessages.id, recentLegacyId));
      const unifiedLeft = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.id, recentUnifiedId));
      expect(legacyLeft).toHaveLength(1);
      expect(unifiedLeft).toHaveLength(1);
    });
  });
});
