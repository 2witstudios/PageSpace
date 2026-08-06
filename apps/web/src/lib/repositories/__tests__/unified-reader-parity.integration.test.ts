/**
 * READER-CUTOVER PARITY — `chat_messages` (legacy leg) vs `messages` (unified
 * leg), against a REAL Postgres.
 *
 * Epic "Agent-Session Single Source of Truth", Phase 4 / D6, PR 11. The plan
 * calls for exactly one property per cut-over reader: OVER THE SAME CORPUS,
 * THE OLD PATH AND THE NEW PATH RETURN THE SAME ROWS. This suite lives until
 * the contract PR (Phase 4 PR 15) deletes `chat_messages` and takes it with
 * it.
 *
 * ── The corpus ────────────────────────────────────────────────────────────
 * `seedCorpus()` writes one drive containing two agent pages plus a global
 * conversation, and dual-writes every page-chat row to BOTH legs the way PR
 * 10's writer does. It is deliberately awkward, because the shapes below are
 * where a page-scoping translation goes wrong:
 *
 *   - an ACTIVE and a SOFT-DELETED row in the same conversation;
 *   - a `status='streaming'` placeholder (hidden from every model-facing
 *     reader, and the row whose handling the `pending` mapping changed);
 *   - an agent-authored row with `userId = NULL` and a `sourceAgentId`;
 *   - a SECOND page in the same drive, so a page-scoped reader that lost its
 *     scope returns too much rather than failing outright;
 *   - a `type='client'` conversation whose `contextId` is a DRIVE id, not a
 *     page id — the one shape for which "join through `conversations.contextId`"
 *     is NOT a page scope, and which therefore must stay invisible to
 *     page-scoped readers on both legs;
 *   - a `type='global'` conversation, which has only ever had the unified leg.
 *
 * ── What "old path" means here ────────────────────────────────────────────
 * Two strengths of assertion, both present, and the difference matters:
 *
 *   A. SHIPPED-READER PARITY (strongest). The production reader is CALLED, and
 *      its result is compared against a frozen copy of the legacy
 *      `chat_messages` query it replaced. A regression in the shipped code
 *      fails these.
 *
 *   B. TRANSLATION PARITY. Several readers are SQL embedded in a tool's
 *      `execute` closure with no seam to call (`search-tools`,
 *      `agent-communication-tools`' history load, the pulse routes, the admin
 *      counts). For those the suite pins the TRANSLATION RULE itself —
 *      `chat_messages.pageId = X` ⇒ `JOIN conversations ON id = conversationId
 *      WHERE type='page' AND contextId = X` — by running both forms over this
 *      corpus. That proves the rewrite preserves rows for every shape above;
 *      it does not prove a given call site was rewritten correctly, which is
 *      what typecheck plus each reader's own suite cover. The distinction is
 *      recorded here rather than papered over.
 *
 * Requires DATABASE_URL → a Postgres with migrations applied. Skipped when no
 * DB is reachable, mirroring the convention in
 * `agent-sessions-conversations-runtime.integration.test.ts`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, asc, desc, eq, gte, inArray, ne, sql, count, max, min } from '@pagespace/db/operators';
import { pages, chatMessages } from '@pagespace/db/schema/core';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { factories } from '@pagespace/db/test/factories';
import { messageRepository } from '@/lib/repositories/message-repository';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { buildSessionToolsDeps } from '@/lib/ai/tools/session-tools-runtime';

let dbAvailable = false;

interface Corpus {
  ownerId: string;
  driveId: string;
  agentPageId: string;
  otherAgentPageId: string;
  /** The main page conversation: active + soft-deleted + streaming + agent-authored rows. */
  pageConversationId: string;
  /** A second conversation on the same page. */
  secondPageConversationId: string;
  /** A conversation on the OTHER page in the same drive. */
  otherPageConversationId: string;
  /** `type='client'`: contextId is the DRIVE id, and its rows name a page. */
  clientConversationId: string;
  /** `type='global'`: unified leg only, always has been. */
  globalConversationId: string;
}

/**
 * Write one page-chat row to BOTH legs — the shape PR 10's dual-write
 * produces, and the only state in which a parity question is meaningful.
 */
async function dualWrite(row: {
  id?: string;
  pageId: string;
  conversationId: string;
  userId?: string | null;
  role: string;
  content: string;
  isActive?: boolean;
  status?: 'streaming' | 'complete' | 'interrupted';
  sourceAgentId?: string | null;
  createdAt: Date;
}): Promise<string> {
  const values = {
    id: row.id ?? createId(),
    pageId: row.pageId,
    conversationId: row.conversationId,
    userId: row.userId ?? null,
    role: row.role,
    content: row.content,
    isActive: row.isActive ?? true,
    status: row.status ?? ('complete' as const),
    sourceAgentId: row.sourceAgentId ?? null,
    createdAt: row.createdAt,
  };
  await db.insert(chatMessages).values(values);
  await db.insert(messages).values(values);
  return values.id;
}

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 12, minutes, 0));

async function seedCorpus(): Promise<Corpus> {
  const owner = await factories.createUser();
  const drive = await factories.createDrive(owner.id);
  const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Primary Agent' });
  const otherAgentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Other Agent' });

  const pageConversationId = createId();
  const secondPageConversationId = createId();
  const otherPageConversationId = createId();
  const clientConversationId = createId();
  const globalConversationId = createId();

  await db.insert(conversations).values([
    { id: pageConversationId, userId: owner.id, type: 'page', contextId: agentPage.id, title: 'Thread one', isActive: true, createdAt: at(0) },
    { id: secondPageConversationId, userId: owner.id, type: 'page', contextId: agentPage.id, title: 'Thread two', isActive: true, createdAt: at(1) },
    { id: otherPageConversationId, userId: owner.id, type: 'page', contextId: otherAgentPage.id, title: 'Other page thread', isActive: true, createdAt: at(2) },
    // `type='client'`: contextId is the DRIVE, not a page. Its rows still name
    // an agent page in `chat_messages.pageId` — the shape that makes
    // "join through contextId" a NON-page scope for this type.
    { id: clientConversationId, userId: owner.id, type: 'client', contextId: drive.id, title: 'API thread', isActive: true, createdAt: at(3) },
    { id: globalConversationId, userId: owner.id, type: 'global', contextId: null, title: 'Global thread', isActive: true, createdAt: at(4), lastMessageAt: at(9) },
  ]);

  // Thread one — the awkward one.
  await dualWrite({ pageId: agentPage.id, conversationId: pageConversationId, userId: owner.id, role: 'user', content: 'first question about widgets', createdAt: at(5) });
  await dualWrite({ pageId: agentPage.id, conversationId: pageConversationId, userId: null, role: 'assistant', content: 'an answer about widgets', sourceAgentId: agentPage.id, createdAt: at(6) });
  await dualWrite({ pageId: agentPage.id, conversationId: pageConversationId, userId: owner.id, role: 'user', content: 'a deleted question', isActive: false, createdAt: at(7) });
  await dualWrite({ pageId: agentPage.id, conversationId: pageConversationId, userId: null, role: 'assistant', content: '', status: 'streaming', createdAt: at(8) });

  // Thread two, same page.
  await dualWrite({ pageId: agentPage.id, conversationId: secondPageConversationId, userId: owner.id, role: 'user', content: 'second thread, same widgets', createdAt: at(9) });

  // Other page, same drive.
  await dualWrite({ pageId: otherAgentPage.id, conversationId: otherPageConversationId, userId: owner.id, role: 'user', content: 'unrelated widgets talk', createdAt: at(10) });

  // Client conversation — rows name a page, the conversation does not.
  await dualWrite({ pageId: agentPage.id, conversationId: clientConversationId, userId: owner.id, role: 'user', content: 'api widgets call', createdAt: at(11) });

  // Global conversation — unified leg only (it never had a legacy leg).
  await db.insert(messages).values([
    { id: createId(), conversationId: globalConversationId, userId: owner.id, role: 'user', content: 'global question', createdAt: at(12), isActive: true, status: 'complete' },
    { id: createId(), conversationId: globalConversationId, userId: null, role: 'assistant', content: 'global answer', createdAt: at(13), isActive: true, status: 'complete' },
    { id: createId(), conversationId: globalConversationId, userId: null, role: 'assistant', content: '', createdAt: at(14), isActive: true, status: 'streaming' },
  ]);

  return {
    ownerId: owner.id,
    driveId: drive.id,
    agentPageId: agentPage.id,
    otherAgentPageId: otherAgentPage.id,
    pageConversationId,
    secondPageConversationId,
    otherPageConversationId,
    clientConversationId,
    globalConversationId,
  };
}

/** The join every page-scoped reader was rewritten onto. */
const pageScope = (pageId: string) =>
  and(eq(conversations.type, 'page'), eq(conversations.contextId, pageId));

describe('unified reader parity — legacy chat_messages vs unified messages', () => {
  let corpus: Corpus;

  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
      return;
    }
    corpus = await seedCorpus();
  });

  // -------------------------------------------------------------------------
  // A. SHIPPED-READER PARITY
  // -------------------------------------------------------------------------

  describe('messageRepository.getMessagesByConversationId (v1 conversations GET)', () => {
    it('returns the same rows as the legacy chat-message repository, in the same order', async () => {
      if (!dbAvailable) return;

      const legacy = await chatMessageRepository.getMessagesByConversationId(corpus.pageConversationId);
      const unified = await messageRepository.getMessagesByConversationId(corpus.pageConversationId);

      // `pageId` is the ONE field the unified seam deliberately drops (the
      // transitional column dies at PR 15); everything a consumer serializes
      // must be identical.
      const shape = (rows: ReadonlyArray<{
        id: string;
        conversationId: string;
        userId: string | null;
        role: string;
        content: string;
        messageType: string;
        isActive: boolean;
        createdAt: Date;
        editedAt: Date | null;
        status: string;
      }>) =>
        rows.map((r) => ({
          id: r.id,
          conversationId: r.conversationId,
          userId: r.userId,
          role: r.role,
          content: r.content,
          messageType: r.messageType,
          isActive: r.isActive,
          createdAt: r.createdAt,
          editedAt: r.editedAt,
          status: r.status,
        }));

      expect(shape(unified)).toEqual(shape(legacy));
      // Sanity: the corpus really did exercise the filters (2 durable rows —
      // the soft-deleted and the streaming ones are excluded).
      expect(unified).toHaveLength(2);
    });

    it('matches the legacy reader with includeStreaming=1 too', async () => {
      if (!dbAvailable) return;

      const legacy = await chatMessageRepository.getMessagesByConversationId(corpus.pageConversationId, true);
      const unified = await messageRepository.getMessagesByConversationId(corpus.pageConversationId, true);

      expect(unified.map((m) => m.id)).toEqual(legacy.map((m) => m.id));
      expect(unified).toHaveLength(3);
    });

    it('reads a type: "client" conversation identically — conversationId alone scopes it', async () => {
      if (!dbAvailable) return;

      const legacy = await chatMessageRepository.getMessagesByConversationId(corpus.clientConversationId);
      const unified = await messageRepository.getMessagesByConversationId(corpus.clientConversationId);

      expect(unified.map((m) => m.content)).toEqual(legacy.map((m) => m.content));
      expect(unified).toHaveLength(1);
    });
  });

  describe('readSessionTranscript (session-tools-runtime)', () => {
    it('returns the page transcript the legacy chat_messages branch returned', async () => {
      if (!dbAvailable) return;

      // Frozen copy of the pre-cutover page branch.
      const legacyRows = await db
        .select({
          role: chatMessages.role,
          content: chatMessages.content,
          createdAt: chatMessages.createdAt,
          status: chatMessages.status,
        })
        .from(chatMessages)
        .where(and(
          eq(chatMessages.pageId, corpus.agentPageId),
          eq(chatMessages.conversationId, corpus.pageConversationId),
          eq(chatMessages.isActive, true),
        ))
        .orderBy(desc(chatMessages.createdAt))
        .limit(50);
      const legacy = legacyRows.reverse().map((row) => ({
        role: row.role === 'assistant' ? 'assistant' : 'user',
        content: row.content,
        at: row.createdAt,
        ...(row.status === 'streaming' ? { pending: true as const } : {}),
      }));

      const deps = buildSessionToolsDeps();
      const unified = await deps.readTranscript({
        conversationId: corpus.pageConversationId,
        agentPageId: corpus.agentPageId,
        limit: 50,
      });

      expect(unified).toEqual(legacy);
      // The streaming placeholder is present AND flagged — the behaviour the
      // legacy page branch already had.
      expect(unified.some((entry) => entry.pending === true)).toBe(true);
    });

    it('returns the same global transcript as before — and now flags its pending turn (the intended change)', async () => {
      if (!dbAvailable) return;

      // Frozen copy of the pre-cutover GLOBAL branch: same table, same rows,
      // but it never selected `status`, so it could not mark a turn pending.
      const legacyRows = await db
        .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.conversationId, corpus.globalConversationId), eq(messages.isActive, true)))
        .orderBy(desc(messages.createdAt))
        .limit(50);
      const legacy = legacyRows.reverse().map((row) => ({
        role: row.role === 'assistant' ? 'assistant' : 'user',
        content: row.content,
        at: row.createdAt,
      }));

      const deps = buildSessionToolsDeps();
      const unified = await deps.readTranscript({
        conversationId: corpus.globalConversationId,
        agentPageId: null,
        limit: 50,
      });

      // Same rows, same order, same content — row parity holds.
      expect(unified.map((e) => ({ role: e.role, content: e.content, at: e.at }))).toEqual(legacy);
      // THE DELIBERATE NON-PARITY: the in-flight turn is now reported as
      // pending instead of being handed to the model as a completed empty
      // message. See `readSessionTranscript`'s doc comment.
      const pending = unified.filter((entry) => entry.pending === true);
      expect(pending).toHaveLength(1);
      expect(pending[0].content).toBe('');
    });
  });

  describe('readLatestAssistantReply (session-tools-runtime)', () => {
    // Not directly callable — it is reached only through
    // `dispatchThroughChatPipeline`, which needs a live `next/headers` request
    // and a real HTTP round trip through the chat route. The closest
    // equivalent is pinned instead: the exact query, old form vs new.
    it('returns the same latest completed assistant turn for a page thread', async () => {
      if (!dbAvailable) return;

      const [legacy] = await db
        .select({ content: chatMessages.content })
        .from(chatMessages)
        .where(and(
          eq(chatMessages.pageId, corpus.agentPageId),
          eq(chatMessages.conversationId, corpus.pageConversationId),
          eq(chatMessages.role, 'assistant'),
          eq(chatMessages.isActive, true),
          ne(chatMessages.status, 'streaming'),
        ))
        .orderBy(desc(chatMessages.createdAt))
        .limit(1);

      const [unified] = await db
        .select({ content: messages.content })
        .from(messages)
        .where(and(
          eq(messages.conversationId, corpus.pageConversationId),
          eq(messages.role, 'assistant'),
          eq(messages.isActive, true),
          ne(messages.status, 'streaming'),
        ))
        .orderBy(desc(messages.createdAt))
        .limit(1);

      expect(unified?.content).toBe(legacy?.content);
      expect(unified?.content).toBe('an answer about widgets');
    });

    it('no longer returns a global thread\'s empty streaming placeholder as "the reply"', async () => {
      if (!dbAvailable) return;

      // The pre-cutover GLOBAL branch had no status filter, so the newest
      // assistant row it found was the in-flight placeholder — an empty
      // string reported as a completed answer.
      const [legacyGlobal] = await db
        .select({ content: messages.content })
        .from(messages)
        .where(and(
          eq(messages.conversationId, corpus.globalConversationId),
          eq(messages.role, 'assistant'),
          eq(messages.isActive, true),
        ))
        .orderBy(desc(messages.createdAt))
        .limit(1);

      const [unifiedGlobal] = await db
        .select({ content: messages.content })
        .from(messages)
        .where(and(
          eq(messages.conversationId, corpus.globalConversationId),
          eq(messages.role, 'assistant'),
          eq(messages.isActive, true),
          ne(messages.status, 'streaming'),
        ))
        .orderBy(desc(messages.createdAt))
        .limit(1);

      expect(legacyGlobal?.content).toBe('');
      expect(unifiedGlobal?.content).toBe('global answer');
    });
  });

  // -------------------------------------------------------------------------
  // B. TRANSLATION PARITY — `chat_messages.pageId = X` ⇒ join via contextId
  // -------------------------------------------------------------------------

  describe('page scoping: pageId equality vs the conversations.contextId join', () => {
    it('selects the same message ids for a page', async () => {
      if (!dbAvailable) return;

      const legacy = await db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(and(eq(chatMessages.pageId, corpus.agentPageId), eq(chatMessages.isActive, true)))
        .orderBy(asc(chatMessages.createdAt));

      const unified = await db
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(pageScope(corpus.agentPageId), eq(messages.isActive, true)))
        .orderBy(asc(messages.createdAt));

      // The ONE documented difference: the legacy `pageId` equality also
      // catches the `type='client'` row that merely NAMES this page, while the
      // conversation-scoped form does not — that row belongs to a drive-scoped
      // API thread, not to this page's chat. Assert the delta explicitly
      // rather than letting it hide inside a set comparison.
      const clientRow = await db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(eq(chatMessages.conversationId, corpus.clientConversationId));

      expect(new Set(unified.map((r) => r.id)))
        .toEqual(new Set(legacy.map((r) => r.id).filter((id) => id !== clientRow[0].id)));
    });

    it('does not leak the other page in the same drive', async () => {
      if (!dbAvailable) return;

      const unified = await db
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(pageScope(corpus.agentPageId), eq(messages.isActive, true)));

      const otherPageRows = await db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(eq(chatMessages.pageId, corpus.otherAgentPageId));

      const unifiedIds = new Set(unified.map((r) => r.id));
      for (const row of otherPageRows) expect(unifiedIds.has(row.id)).toBe(false);
    });
  });

  describe('page-read-tools: list_conversations aggregation', () => {
    it('groups, counts and time-stamps a page\'s conversations identically', async () => {
      if (!dbAvailable) return;

      const legacy = await db
        .select({
          conversationId: chatMessages.conversationId,
          messageCount: count(chatMessages.id),
          lastActivity: max(chatMessages.createdAt),
          firstMessageTime: min(chatMessages.createdAt),
        })
        .from(chatMessages)
        .where(and(eq(chatMessages.pageId, corpus.agentPageId), eq(chatMessages.isActive, true)))
        .groupBy(chatMessages.conversationId);

      const unified = await db
        .select({
          conversationId: messages.conversationId,
          messageCount: count(messages.id),
          lastActivity: max(messages.createdAt),
          firstMessageTime: min(messages.createdAt),
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(pageScope(corpus.agentPageId), eq(messages.isActive, true)))
        .groupBy(messages.conversationId);

      const byId = (rows: typeof legacy) =>
        Object.fromEntries(rows.map((r) => [r.conversationId, {
          messageCount: Number(r.messageCount),
          lastActivity: r.lastActivity,
          firstMessageTime: r.firstMessageTime,
        }]));

      const legacyById = byId(legacy);
      // The client conversation is the documented delta (see above): it groups
      // under the legacy pageId equality but is not this page's chat.
      delete legacyById[corpus.clientConversationId];

      expect(byId(unified)).toEqual(legacyById);
    });
  });

  describe('page-read-tools / agent-communication-tools: conversation history load', () => {
    it('returns the same durable rows for a (page, conversation) pair', async () => {
      if (!dbAvailable) return;

      const legacy = await db
        .select({ id: chatMessages.id, role: chatMessages.role, content: chatMessages.content, sourceAgentId: chatMessages.sourceAgentId })
        .from(chatMessages)
        .where(and(
          eq(chatMessages.conversationId, corpus.pageConversationId),
          eq(chatMessages.pageId, corpus.agentPageId),
          eq(chatMessages.isActive, true),
          ne(chatMessages.status, 'streaming'),
        ))
        .orderBy(asc(chatMessages.createdAt));

      const unified = await db
        .select({ id: messages.id, role: messages.role, content: messages.content, sourceAgentId: messages.sourceAgentId })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(
          eq(messages.conversationId, corpus.pageConversationId),
          pageScope(corpus.agentPageId),
          eq(messages.isActive, true),
          ne(messages.status, 'streaming'),
        ))
        .orderBy(asc(messages.createdAt));

      expect(unified).toEqual(legacy);
      // The agent-authored row (userId NULL, sourceAgentId set) survived the
      // copy with its attribution intact.
      expect(unified.some((r) => r.sourceAgentId === corpus.agentPageId)).toBe(true);
    });
  });

  describe('agent-communication-tools: "has conversation history" count', () => {
    it('counts the same rows for an agent page', async () => {
      if (!dbAvailable) return;

      const [legacy] = await db
        .select({ count: sql<number>`count(*)` })
        .from(chatMessages)
        .where(eq(chatMessages.pageId, corpus.otherAgentPageId));

      const [unified] = await db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(pageScope(corpus.otherAgentPageId));

      expect(Number(unified.count)).toBe(Number(legacy.count));
      expect(Number(unified.count)).toBeGreaterThan(0);
    });
  });

  describe('search-tools: regex match + ROW_NUMBER line numbering', () => {
    it('finds the same matching rows across a page set', async () => {
      if (!dbAvailable) return;

      const pageIds = [corpus.agentPageId, corpus.otherAgentPageId];
      const pattern = 'widgets';

      const legacy = await db
        .select({ id: chatMessages.id, conversationId: chatMessages.conversationId })
        .from(chatMessages)
        .where(and(
          inArray(chatMessages.pageId, pageIds),
          eq(chatMessages.isActive, true),
          sql`${chatMessages.content} ~ ${pattern}`,
        ))
        .orderBy(asc(chatMessages.createdAt));

      const unified = await db
        .select({ id: messages.id, conversationId: messages.conversationId })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(
          eq(conversations.type, 'page'),
          inArray(conversations.contextId, pageIds),
          eq(messages.isActive, true),
          sql`${messages.content} ~ ${pattern}`,
        ))
        .orderBy(asc(messages.createdAt));

      const legacyIds = legacy
        .filter((r) => r.conversationId !== corpus.clientConversationId)
        .map((r) => r.id);
      expect(unified.map((r) => r.id)).toEqual(legacyIds);
      expect(unified.length).toBeGreaterThan(1);
    });

    it('assigns the same line numbers within a conversation', async () => {
      if (!dbAvailable) return;

      const legacy = await db
        .select({
          id: chatMessages.id,
          lineNumber: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${chatMessages.pageId}, ${chatMessages.conversationId} ORDER BY ${chatMessages.createdAt})`.as('line_number'),
        })
        .from(chatMessages)
        .where(and(
          eq(chatMessages.pageId, corpus.agentPageId),
          eq(chatMessages.conversationId, corpus.pageConversationId),
          eq(chatMessages.isActive, true),
          ne(chatMessages.status, 'streaming'),
        ));

      const unified = await db
        .select({
          id: messages.id,
          lineNumber: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${conversations.contextId}, ${messages.conversationId} ORDER BY ${messages.createdAt})`.as('line_number'),
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(
          pageScope(corpus.agentPageId),
          eq(messages.conversationId, corpus.pageConversationId),
          eq(messages.isActive, true),
          ne(messages.status, 'streaming'),
        ));

      const toMap = (rows: Array<{ id: string; lineNumber: number }>) =>
        Object.fromEntries(rows.map((r) => [r.id, Number(r.lineNumber)]));
      expect(toMap(unified)).toEqual(toMap(legacy));
    });
  });

  describe('page-payload-service: recent AI_CHAT context bag', () => {
    it('returns the same recent rows, newest-first, streaming excluded', async () => {
      if (!dbAvailable) return;

      const legacy = await db
        .select({
          id: chatMessages.id,
          conversationId: chatMessages.conversationId,
          role: chatMessages.role,
          content: chatMessages.content,
          createdAt: chatMessages.createdAt,
          isActive: chatMessages.isActive,
          userId: chatMessages.userId,
        })
        .from(chatMessages)
        .where(and(
          eq(chatMessages.pageId, corpus.agentPageId),
          eq(chatMessages.isActive, true),
          ne(chatMessages.status, 'streaming'),
        ))
        .orderBy(desc(chatMessages.createdAt))
        .limit(50);

      const unified = await db
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          role: messages.role,
          content: messages.content,
          createdAt: messages.createdAt,
          isActive: messages.isActive,
          userId: messages.userId,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(
          pageScope(corpus.agentPageId),
          eq(messages.isActive, true),
          ne(messages.status, 'streaming'),
        ))
        .orderBy(desc(messages.createdAt))
        .limit(50);

      expect(unified).toEqual(legacy.filter((r) => r.conversationId !== corpus.clientConversationId));
    });
  });

  describe('discovery-service: the page-agent leg', () => {
    it('returns the same rows when reached through conversations + pages', async () => {
      if (!dbAvailable) return;

      const lookback = at(-1);

      const legacy = await db
        .select({ content: chatMessages.content, role: chatMessages.role, createdAt: chatMessages.createdAt })
        .from(chatMessages)
        .innerJoin(pages, eq(pages.id, chatMessages.pageId))
        .where(and(
          eq(chatMessages.userId, corpus.ownerId),
          eq(chatMessages.isActive, true),
          inArray(pages.driveId, [corpus.driveId]),
          gte(chatMessages.createdAt, lookback),
        ))
        .orderBy(desc(chatMessages.createdAt))
        .limit(100);

      const unified = await db
        .select({ content: messages.content, role: messages.role, createdAt: messages.createdAt })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .innerJoin(pages, eq(pages.id, conversations.contextId))
        .where(and(
          eq(conversations.type, 'page'),
          eq(messages.userId, corpus.ownerId),
          eq(messages.isActive, true),
          inArray(pages.driveId, [corpus.driveId]),
          gte(messages.createdAt, lookback),
        ))
        .orderBy(desc(messages.createdAt))
        .limit(100);

      // Same delta as everywhere else: the client-conversation row is not a
      // page-chat row under the conversation-scoped rule.
      expect(unified).toEqual(legacy.filter((r) => r.content !== 'api widgets call'));
    });

    it('the global leg no longer swallows page rows once scoped to type=global', async () => {
      if (!dbAvailable) return;

      // Without the `type='global'` predicate the "global" query would now
      // return every page row too — this is the reason the cutover added it.
      const unscoped = await db
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(eq(conversations.userId, corpus.ownerId), eq(messages.isActive, true)));

      const scoped = await db
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(
          eq(conversations.type, 'global'),
          eq(conversations.userId, corpus.ownerId),
          eq(messages.isActive, true),
        ));

      expect(scoped.length).toBe(3);
      expect(unscoped.length).toBeGreaterThan(scoped.length);
    });
  });

  describe('pulse routes: recent page-chat discussions', () => {
    it('returns the same user-authored rows joined through the page', async () => {
      if (!dbAvailable) return;

      const since = at(-1);
      const strangerId = 'nobody';

      const legacy = await db
        .select({ pageId: chatMessages.pageId, content: chatMessages.content, createdAt: chatMessages.createdAt })
        .from(chatMessages)
        .leftJoin(pages, eq(pages.id, chatMessages.pageId))
        .where(and(
          inArray(pages.driveId, [corpus.driveId]),
          eq(chatMessages.role, 'user'),
          eq(chatMessages.isActive, true),
          gte(chatMessages.createdAt, since),
          ne(chatMessages.userId, strangerId),
        ))
        .orderBy(desc(chatMessages.createdAt))
        .limit(15);

      const unified = await db
        .select({ pageId: sql<string>`${conversations.contextId}`, content: messages.content, createdAt: messages.createdAt })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .leftJoin(pages, eq(pages.id, conversations.contextId))
        .where(and(
          eq(conversations.type, 'page'),
          inArray(pages.driveId, [corpus.driveId]),
          eq(messages.role, 'user'),
          eq(messages.isActive, true),
          gte(messages.createdAt, since),
          ne(messages.userId, strangerId),
        ))
        .orderBy(desc(messages.createdAt))
        .limit(15);

      expect(unified).toEqual(legacy.filter((r) => r.content !== 'api widgets call'));
    });
  });

  describe('admin users route: per-user message counts', () => {
    it('splits the unified table into the same page/global buckets the two tables gave', async () => {
      if (!dbAvailable) return;

      const [legacyPage] = await db
        .select({ count: count() })
        .from(chatMessages)
        .where(eq(chatMessages.userId, corpus.ownerId));
      const [legacyGlobal] = await db
        .select({ count: count() })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(eq(messages.userId, corpus.ownerId), eq(conversations.type, 'global')));

      const [unifiedPage] = await db
        .select({ count: count() })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(inArray(messages.userId, [corpus.ownerId]), ne(conversations.type, 'global')));
      const [unifiedGlobal] = await db
        .select({ count: count() })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(inArray(messages.userId, [corpus.ownerId]), eq(conversations.type, 'global')));

      // The page bucket is `type <> 'global'`, which is exactly "everything
      // that used to live in chat_messages" — INCLUDING the client
      // conversation, which is why this bucket has no delta to subtract.
      expect(Number(unifiedPage.count)).toBe(Number(legacyPage.count));
      expect(Number(unifiedGlobal.count)).toBe(Number(legacyGlobal.count));
    });
  });

  describe('agent-sessions listing: hasActiveMessage / recency', () => {
    it('sees the same conversations as the two-legged OR it replaced', async () => {
      if (!dbAvailable) return;

      const legacy = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(
          eq(conversations.userId, corpus.ownerId),
          sql`(EXISTS (SELECT 1 FROM messages m WHERE m."conversationId" = ${conversations.id} AND m."isActive" = true)
               OR EXISTS (SELECT 1 FROM chat_messages cm WHERE cm."conversationId" = ${conversations.id} AND cm."isActive" = true AND cm."status" <> 'streaming'))`,
        ));

      const unified = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(
          eq(conversations.userId, corpus.ownerId),
          sql`EXISTS (SELECT 1 FROM messages m WHERE m."conversationId" = ${conversations.id} AND m."isActive" = true AND m."status" <> 'streaming')`,
        ));

      expect(new Set(unified.map((r) => r.id))).toEqual(new Set(legacy.map((r) => r.id)));
    });

    it('derives the same recency timestamp per conversation', async () => {
      if (!dbAvailable) return;

      const rows = await db
        .select({
          id: conversations.id,
          legacy: sql<string | null>`COALESCE((SELECT MAX(cm."createdAt") FROM chat_messages cm WHERE cm."conversationId" = ${conversations.id} AND cm."isActive" = true AND cm."status" <> 'streaming'), ${conversations.lastMessageAt})`,
          unified: sql<string | null>`COALESCE((SELECT MAX(m."createdAt") FROM messages m WHERE m."conversationId" = ${conversations.id} AND m."isActive" = true AND m."status" <> 'streaming'), ${conversations.lastMessageAt})`,
        })
        .from(conversations)
        .where(eq(conversations.userId, corpus.ownerId));

      for (const row of rows) {
        if (row.id === corpus.globalConversationId) {
          // The ONE conversation where the two forms legitimately differ: the
          // legacy expression had no legacy rows to MAX over and fell back to
          // `lastMessageAt`, while the unified one reads the real global rows.
          // Both are "the last activity"; the unified one is the more precise.
          expect(row.unified).not.toBeNull();
          continue;
        }
        expect(row.unified).toEqual(row.legacy);
      }
    });
  });
});
