import type { UIMessage } from 'ai';
import { eq, and, ne, desc } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { chatMessages } from '@pagespace/db/schema/core';
import { messages as globalMessages } from '@pagespace/db/schema/conversations';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  convertDbMessageToUIMessage,
  convertGlobalAssistantMessageToUIMessage,
  saveMessageToDatabase,
  saveGlobalAssistantMessageToDatabase,
} from '@/lib/ai/core/message-utils';
import {
  buildAssistantPersistencePayload,
  type AssistantPersistencePayload,
} from '@/lib/ai/core/persistAssistantParts';
import { ASK_USER_TOOL_NAME, askUserOutputSchema } from '@/lib/ai/tools/ask-user-tools';

const ASK_USER_PART_TYPE = `tool-${ASK_USER_TOOL_NAME}`;
const DISMISSED_REASON = 'User replied in chat instead of selecting an option.';

type AskUserToolPart = { type: string; toolCallId: string; state?: string; output?: unknown };

function isAskUserPart(part: { type: string }): part is AskUserToolPart {
  return part.type === ASK_USER_PART_TYPE;
}

export interface ClientAskUserResult {
  toolCallId: string;
  output: unknown;
}

/**
 * Pull `tool-ask_user` output-available parts off a trailing ASSISTANT request
 * message (produced client-side by `addToolResult`). Everything except
 * toolCallId/output is untrusted and discarded — the merge re-derives the
 * rest from the persisted assistant row.
 */
export function extractClientAskUserResults(
  message: UIMessage | undefined
): ClientAskUserResult[] {
  if (!message || message.role !== 'assistant' || !message.parts) return [];
  const results: ClientAskUserResult[] = [];
  for (const part of message.parts) {
    if (!isAskUserPart(part)) continue;
    if (part.state === 'output-available' && part.output !== undefined) {
      results.push({ toolCallId: part.toolCallId, output: part.output });
    }
  }
  return results;
}

/**
 * Merge validated results into a reconstructed message's ask_user parts.
 * Only flips parts that are still pending (input-available) — already
 * answered parts are left untouched (idempotent under double-submit races),
 * and invalid client output is rejected and logged rather than persisted.
 */
function mergeResultsIntoParts(
  parts: UIMessage['parts'],
  results: ClientAskUserResult[]
): { parts: UIMessage['parts']; changed: boolean } {
  const byId = new Map(results.map((r) => [r.toolCallId, r]));
  let changed = false;

  const nextParts = parts.map((part) => {
    if (!isAskUserPart(part)) return part;
    const result = byId.get(part.toolCallId);
    if (!result) return part;
    if (part.state !== 'input-available') return part;

    const parsed = askUserOutputSchema.safeParse(result.output);
    if (!parsed.success) {
      loggers.ai.warn('ask_user resume: rejected invalid client output', {
        toolCallId: part.toolCallId,
        issues: parsed.error.issues,
      });
      return part;
    }

    changed = true;
    return { ...part, state: 'output-available', output: parsed.data };
  });

  return { parts: nextParts as UIMessage['parts'], changed };
}

function pendingAskUserToolCallIds(parts: UIMessage['parts']): string[] {
  const ids: string[] = [];
  for (const part of parts) {
    if (isAskUserPart(part) && part.state === 'input-available') ids.push(part.toolCallId);
  }
  return ids;
}

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
 * threading a transaction/row-lock through `saveMessageToDatabase` /
 * `saveGlobalAssistantMessageToDatabase` in message-utils.ts, which are
 * shared by many unrelated AI features — broader blast radius than this
 * narrow, low-probability, self-healing race (the user can just answer
 * again) justifies in isolation.
 */
interface FetchedAssistantMessage {
  message: UIMessage;
  persist(payload: AssistantPersistencePayload): Promise<void>;
}

/**
 * Row-agnostic backend for the merge/dismiss orchestration below, so that
 * logic is written once and shared by both the page-agent (chatMessages) and
 * Global Assistant (messages) persistence tables, which differ only in
 * table/where-clause shape and save-call field requirements.
 */
interface AssistantMessageAdapter {
  /** Fetch + reconstruct the specific assistant message this resume answers, or null if not found/not assistant. */
  fetchById(messageId: string): Promise<FetchedAssistantMessage | null>;
  /** Fetch + reconstruct the conversation's most recent assistant message, or null if none exists. */
  fetchLastAssistant(): Promise<FetchedAssistantMessage | null>;
}

async function applyAskUserResults(
  adapter: AssistantMessageAdapter,
  messageId: string,
  results: ClientAskUserResult[]
): Promise<{ merged: boolean }> {
  if (results.length === 0) return { merged: false };

  const fetched = await adapter.fetchById(messageId);
  if (!fetched) return { merged: false };

  const { parts, changed } = mergeResultsIntoParts(fetched.message.parts, results);
  if (!changed) return { merged: false };

  await fetched.persist(buildAssistantPersistencePayload(messageId, parts));
  return { merged: true };
}

/**
 * A new user message arrived instead of an answer. Synthesize a
 * `{dismissed: true}` result onto any still-pending ask_user calls on the
 * conversation's last assistant message so the model sees its questions were
 * answered free-form in chat and does not re-ask.
 */
async function dismissPendingAskUser(adapter: AssistantMessageAdapter): Promise<void> {
  const fetched = await adapter.fetchLastAssistant();
  if (!fetched) return;

  const pendingIds = pendingAskUserToolCallIds(fetched.message.parts);
  if (pendingIds.length === 0) return;

  const results: ClientAskUserResult[] = pendingIds.map((toolCallId) => ({
    toolCallId,
    output: { dismissed: true, reason: DISMISSED_REASON },
  }));

  const { parts, changed } = mergeResultsIntoParts(fetched.message.parts, results);
  if (!changed) return;

  await fetched.persist(buildAssistantPersistencePayload(fetched.message.id, parts));
}

// --- Page (page-agent) conversations -------------------------------------

function pageAdapter(args: { pageId: string; conversationId: string }): AssistantMessageAdapter {
  const toUIMessage = (row: {
    id: string;
    pageId: string;
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
    saveMessageToDatabase({
      messageId,
      pageId: args.pageId,
      conversationId: args.conversationId,
      userId: null,
      role: 'assistant',
      ...payload,
      status,
    });

  return {
    // Both fetchers skip 'streaming' placeholders: a still-empty, mid-flight row is never
    // the message an ask_user resume should target — fetchLastAssistant in particular would
    // otherwise pick up its own conversation's in-flight placeholder as "the last assistant
    // message" and merge results into the wrong row. See Server Stream Durability epic PR 2.
    async fetchById(messageId) {
      const [row] = await db
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.id, messageId),
            eq(chatMessages.pageId, args.pageId),
            eq(chatMessages.conversationId, args.conversationId),
            eq(chatMessages.isActive, true),
            ne(chatMessages.status, 'streaming')
          )
        )
        .limit(1);
      if (!row || row.role !== 'assistant') return null;
      // The fetchers' ne(status, 'streaming') filter guarantees row.status is 'complete' or
      // 'interrupted' here — persist must preserve it, not silently default back to 'complete'
      // (saveMessageToDatabase's own default), or a genuinely cut-short reply with a pending
      // ask_user call would read as fully complete the moment it's answered/dismissed.
      return { message: await toUIMessage(row), persist: persistFor(row.id, row.status === 'interrupted' ? 'interrupted' : 'complete') };
    },
    async fetchLastAssistant() {
      const [row] = await db
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.pageId, args.pageId),
            eq(chatMessages.conversationId, args.conversationId),
            eq(chatMessages.isActive, true),
            eq(chatMessages.role, 'assistant'),
            ne(chatMessages.status, 'streaming')
          )
        )
        .orderBy(desc(chatMessages.createdAt))
        .limit(1);
      if (!row) return null;
      return { message: await toUIMessage(row), persist: persistFor(row.id, row.status === 'interrupted' ? 'interrupted' : 'complete') };
    },
  };
}

export function applyAskUserResultsToPageMessage(args: {
  messageId: string;
  pageId: string;
  conversationId: string;
  results: ClientAskUserResult[];
}): Promise<{ merged: boolean }> {
  return applyAskUserResults(pageAdapter(args), args.messageId, args.results);
}

export function dismissPendingAskUserForPageConversation(args: {
  pageId: string;
  conversationId: string;
}): Promise<void> {
  return dismissPendingAskUser(pageAdapter(args));
}

// --- Global Assistant conversations --------------------------------------

function globalAdapter(args: { conversationId: string }): AssistantMessageAdapter {
  const toUIMessage = (row: {
    id: string;
    conversationId: string;
    userId: string;
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
    saveGlobalAssistantMessageToDatabase({
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
      if (!row || row.role !== 'assistant') return null;
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
      if (!row) return null;
      return { message: await toUIMessage(row), persist: persistFor(row.id, row.userId, row.status === 'interrupted' ? 'interrupted' : 'complete') };
    },
  };
}

export function applyAskUserResultsToGlobalMessage(args: {
  messageId: string;
  conversationId: string;
  results: ClientAskUserResult[];
}): Promise<{ merged: boolean }> {
  return applyAskUserResults(globalAdapter(args), args.messageId, args.results);
}

export function dismissPendingAskUserForGlobalConversation(args: {
  conversationId: string;
}): Promise<void> {
  return dismissPendingAskUser(globalAdapter(args));
}
