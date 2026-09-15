import type { UIMessage } from 'ai';
import { eq, and, ne, desc } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { conversations, messages as globalMessages } from '@pagespace/db/schema/conversations';
import {
  convertDbMessageToUIMessage,
  convertGlobalAssistantMessageToUIMessage,
} from '@/lib/ai/core/message-utils';
import { messageRepository } from '@/lib/repositories/message-repository';
import { unifiedPageScope, derivedPageId } from '@/lib/repositories/unified-message-scope';
import type { AssistantPersistencePayload } from '@/lib/ai/core/persistAssistantParts';

/**
 * The ONE fetch/persist seam for "resume a paused turn by amending the
 * assistant message that paused it". Two resumes ride it — the `ask_user`
 * answer (`ask-user-resume.ts`) and the tool-approval response
 * (`approval-resume.ts`) — over the same two persistence legs (page-agent and
 * Global Assistant rows of the unified `messages` table). Extracted from
 * ask-user-resume so both resumes share one streaming-row exclusion rule and
 * one terminal-status preservation rule, rather than drifting apart.
 */

/**
 * A fetched assistant row, reconstructed into a UIMessage, paired with a
 * `persist` closure already bound to that specific row (id, and for the
 * global backend, its non-null userId) — so the shared orchestration below
 * never needs to know the row's shape or carry state between fetch and save.
 *
 * KNOWN LIMITATION: fetch → merge → persist is an unlocked read-modify-write,
 * not a transaction. Two requests racing on the SAME pending toolCallId (a
 * double-submit, or answering in one tab while a dismiss-triggering message
 * arrives from another) can interleave and the later write wins, silently
 * dropping the earlier one. Not fixed here: doing so correctly requires
 * threading a transaction/row-lock through the message repository's save
 * methods (apps/web/src/lib/repositories/message-repository.ts), which are
 * shared by many unrelated AI features — broader blast radius than this
 * narrow, low-probability, self-healing race (the user can just answer
 * again) justifies in isolation.
 */
export interface FetchedAssistantMessage {
  message: UIMessage;
  /** Result (the repository's MessageWriteResult) is intentionally ignored by callers. */
  persist(payload: AssistantPersistencePayload): Promise<unknown>;
}

/**
 * Row-agnostic backend for the merge/dismiss orchestration below, so that
 * logic is written once and shared by both the page-agent (chatMessages) and
 * Global Assistant (messages) persistence tables, which differ only in
 * table/where-clause shape and save-call field requirements.
 */
export interface AssistantMessageAdapter {
  /** Fetch + reconstruct the specific assistant message this resume answers, or null if not found/not assistant. */
  fetchById(messageId: string): Promise<FetchedAssistantMessage | null>;
  /** Fetch + reconstruct the conversation's most recent assistant message, or null if none exists. */
  fetchLastAssistant(): Promise<FetchedAssistantMessage | null>;
  /**
   * The id of the conversation's most recent settled message of ANY role. An
   * approval may only be acted on while its message is still the newest thing
   * in the conversation — once the user has typed past it (or another reply
   * exists) the card is stale and must not execute.
   */
  fetchLastMessageId(): Promise<string | null>;
}

// --- Page (page-agent) conversations -------------------------------------

export function pageAdapter(args: { pageId: string; conversationId: string }): AssistantMessageAdapter {
  const toUIMessage = (row: {
    id: string;
    pageId: string | null;
    userId: string | null;
    role: string;
    content: string;
    toolCalls: unknown;
    toolResults: unknown;
    createdAt: Date;
    isActive: boolean;
    editedAt: Date | null;
    messageType: string | null;
    status: 'streaming' | 'complete' | 'interrupted';
  }) =>
    convertDbMessageToUIMessage({
      id: row.id,
      pageId: row.pageId,
      userId: row.userId,
      role: row.role,
      content: row.content,
      toolCalls: row.toolCalls,
      toolResults: row.toolResults,
      createdAt: row.createdAt,
      isActive: row.isActive,
      editedAt: row.editedAt,
      messageType: row.messageType === 'todo_list' ? 'todo_list' : 'standard',
      status: row.status,
    });

  const persistFor = (messageId: string, status: 'complete' | 'interrupted') => (payload: AssistantPersistencePayload) =>
    messageRepository.savePageMessage({
      messageId,
      pageId: args.pageId,
      conversationId: args.conversationId,
      userId: null,
      role: 'assistant',
      ...payload,
      status,
    });

  // Reads the one `messages` table (Phase 4 / D6). The page predicate is
  // `unifiedPageScope` — the join through `conversations`, which is what
  // `chat_messages.pageId` became — and the page itself is DERIVED from that
  // same join rather than read off the row.
  const pageRowColumns = {
    id: globalMessages.id,
    pageId: derivedPageId(),
    userId: globalMessages.userId,
    role: globalMessages.role,
    content: globalMessages.content,
    toolCalls: globalMessages.toolCalls,
    toolResults: globalMessages.toolResults,
    createdAt: globalMessages.createdAt,
    isActive: globalMessages.isActive,
    editedAt: globalMessages.editedAt,
    messageType: globalMessages.messageType,
    status: globalMessages.status,
  } as const;

  return {
    // Both fetchers skip 'streaming' placeholders: a still-empty, mid-flight row is never
    // the message an ask_user resume should target — fetchLastAssistant in particular would
    // otherwise pick up its own conversation's in-flight placeholder as "the last assistant
    // message" and merge results into the wrong row. See Server Stream Durability epic PR 2.
    async fetchById(messageId) {
      const [row] = await db
        .select(pageRowColumns)
        .from(globalMessages)
        .innerJoin(conversations, eq(conversations.id, globalMessages.conversationId))
        .where(
          and(
            eq(globalMessages.id, messageId),
            unifiedPageScope(args.pageId),
            eq(globalMessages.conversationId, args.conversationId),
            eq(globalMessages.isActive, true),
            ne(globalMessages.status, 'streaming')
          )
        )
        .limit(1);
      if (!row || row.role !== 'assistant') return null;
      // The fetchers' ne(status, 'streaming') filter guarantees row.status is 'complete' or
      // 'interrupted' here — persist must preserve it, not silently default back to 'complete'
      // (the repository save's own default), or a genuinely cut-short reply with a pending
      // ask_user call would read as fully complete the moment it's answered/dismissed.
      return { message: await toUIMessage(row), persist: persistFor(row.id, row.status === 'interrupted' ? 'interrupted' : 'complete') };
    },
    async fetchLastAssistant() {
      const [row] = await db
        .select(pageRowColumns)
        .from(globalMessages)
        .innerJoin(conversations, eq(conversations.id, globalMessages.conversationId))
        .where(
          and(
            unifiedPageScope(args.pageId),
            eq(globalMessages.conversationId, args.conversationId),
            eq(globalMessages.isActive, true),
            eq(globalMessages.role, 'assistant'),
            ne(globalMessages.status, 'streaming')
          )
        )
        .orderBy(desc(globalMessages.createdAt))
        .limit(1);
      if (!row) return null;
      return { message: await toUIMessage(row), persist: persistFor(row.id, row.status === 'interrupted' ? 'interrupted' : 'complete') };
    },
    async fetchLastMessageId() {
      const [row] = await db
        .select({ id: globalMessages.id })
        .from(globalMessages)
        .innerJoin(conversations, eq(conversations.id, globalMessages.conversationId))
        .where(
          and(
            unifiedPageScope(args.pageId),
            eq(globalMessages.conversationId, args.conversationId),
            eq(globalMessages.isActive, true),
            ne(globalMessages.status, 'streaming')
          )
        )
        .orderBy(desc(globalMessages.createdAt), desc(globalMessages.id))
        .limit(1);
      return row?.id ?? null;
    },
  };
}

// --- Global Assistant conversations --------------------------------------

export function globalAdapter(args: { conversationId: string }): AssistantMessageAdapter {
  const toUIMessage = (row: {
    id: string;
    conversationId: string;
    // Nullable since migration 0249 (agent-authored rows); the converter never
    // reads it.
    userId: string | null;
    role: string;
    content: string;
    toolCalls: unknown;
    toolResults: unknown;
    createdAt: Date;
    isActive: boolean;
    editedAt: Date | null;
    messageType: string | null;
    status: 'streaming' | 'complete' | 'interrupted';
  }) =>
    convertGlobalAssistantMessageToUIMessage({
      id: row.id,
      conversationId: row.conversationId,
      userId: row.userId,
      role: row.role,
      content: row.content,
      toolCalls: row.toolCalls,
      toolResults: row.toolResults,
      createdAt: row.createdAt,
      isActive: row.isActive,
      editedAt: row.editedAt,
      messageType: row.messageType === 'todo_list' ? 'todo_list' : 'standard',
      status: row.status,
    });

  const persistFor = (messageId: string, userId: string, status: 'complete' | 'interrupted') => (payload: AssistantPersistencePayload) =>
    messageRepository.saveGlobalMessage({
      messageId,
      conversationId: args.conversationId,
      userId,
      role: 'assistant',
      ...payload,
      status,
    });

  return {
    // Both fetchers skip 'streaming' placeholders — see the page adapter's doc comment above.
    async fetchById(messageId) {
      const [row] = await db
        .select()
        .from(globalMessages)
        .where(
          and(
            eq(globalMessages.id, messageId),
            eq(globalMessages.conversationId, args.conversationId),
            eq(globalMessages.isActive, true),
            ne(globalMessages.status, 'streaming')
          )
        )
        .limit(1);
      // `userId === null` (possible on `messages` since 0249) means the row has
      // no author to re-persist AS, so it is not resumable. No writer produces
      // that shape yet — the guard is what keeps this path honest once one does.
      if (!row || row.role !== 'assistant' || row.userId === null) return null;
      // See pageAdapter's fetchById: preserve the fetched row's terminal status rather than
      // letting persist silently default to 'complete'.
      return { message: await toUIMessage(row), persist: persistFor(row.id, row.userId, row.status === 'interrupted' ? 'interrupted' : 'complete') };
    },
    async fetchLastAssistant() {
      const [row] = await db
        .select()
        .from(globalMessages)
        .where(
          and(
            eq(globalMessages.conversationId, args.conversationId),
            eq(globalMessages.isActive, true),
            eq(globalMessages.role, 'assistant'),
            ne(globalMessages.status, 'streaming')
          )
        )
        .orderBy(desc(globalMessages.createdAt))
        .limit(1);
      if (!row || row.userId === null) return null;
      return { message: await toUIMessage(row), persist: persistFor(row.id, row.userId, row.status === 'interrupted' ? 'interrupted' : 'complete') };
    },
    async fetchLastMessageId() {
      const [row] = await db
        .select({ id: globalMessages.id })
        .from(globalMessages)
        .where(
          and(
            eq(globalMessages.conversationId, args.conversationId),
            eq(globalMessages.isActive, true),
            ne(globalMessages.status, 'streaming')
          )
        )
        .orderBy(desc(globalMessages.createdAt), desc(globalMessages.id))
        .limit(1);
      return row?.id ?? null;
    },
  };
}

