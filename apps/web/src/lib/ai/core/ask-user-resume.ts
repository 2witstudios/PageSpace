import type { UIMessage } from 'ai';
import { eq, and, desc } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { chatMessages } from '@pagespace/db/schema/core';
import { messages as globalMessages } from '@pagespace/db/schema/conversations';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  convertDbMessageToUIMessage,
  convertGlobalAssistantMessageToUIMessage,
  saveMessageToDatabase,
  saveGlobalAssistantMessageToDatabase,
  extractMessageContent,
  extractToolCalls,
  extractToolResults,
} from '@/lib/ai/core/message-utils';
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

// --- Page (page-agent) conversations -------------------------------------

export async function applyAskUserResultsToPageMessage(args: {
  messageId: string;
  pageId: string;
  conversationId: string;
  results: ClientAskUserResult[];
}): Promise<{ merged: boolean }> {
  if (args.results.length === 0) return { merged: false };

  const [row] = await db
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.id, args.messageId),
        eq(chatMessages.pageId, args.pageId),
        eq(chatMessages.conversationId, args.conversationId),
        eq(chatMessages.isActive, true)
      )
    )
    .limit(1);

  if (!row || row.role !== 'assistant') return { merged: false };

  const uiMessage = await convertDbMessageToUIMessage({
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
  });

  const { parts, changed } = mergeResultsIntoParts(uiMessage.parts, args.results);
  if (!changed) return { merged: false };

  const merged: UIMessage = { ...uiMessage, parts };
  const content = extractMessageContent(merged);
  const toolCalls = extractToolCalls(merged);
  const toolResults = extractToolResults(merged);

  await saveMessageToDatabase({
    messageId: args.messageId,
    pageId: args.pageId,
    conversationId: args.conversationId,
    userId: null,
    role: 'assistant',
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    toolResults: toolResults.length > 0 ? toolResults : undefined,
    uiMessage: merged,
  });

  return { merged: true };
}

/**
 * A new user message arrived instead of an answer. Synthesize a
 * `{dismissed: true}` result onto any still-pending ask_user calls on the
 * conversation's last assistant message so the model sees its questions were
 * answered free-form in chat and does not re-ask.
 */
export async function dismissPendingAskUserForPageConversation(args: {
  pageId: string;
  conversationId: string;
}): Promise<void> {
  const [row] = await db
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.pageId, args.pageId),
        eq(chatMessages.conversationId, args.conversationId),
        eq(chatMessages.isActive, true),
        eq(chatMessages.role, 'assistant')
      )
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);

  if (!row) return;

  const uiMessage = await convertDbMessageToUIMessage({
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
  });

  const pendingIds = pendingAskUserToolCallIds(uiMessage.parts);
  if (pendingIds.length === 0) return;

  const results: ClientAskUserResult[] = pendingIds.map((toolCallId) => ({
    toolCallId,
    output: { dismissed: true, reason: DISMISSED_REASON },
  }));

  const { parts, changed } = mergeResultsIntoParts(uiMessage.parts, results);
  if (!changed) return;

  const merged: UIMessage = { ...uiMessage, parts };
  const content = extractMessageContent(merged);
  const toolCalls = extractToolCalls(merged);
  const toolResults = extractToolResults(merged);

  await saveMessageToDatabase({
    messageId: row.id,
    pageId: args.pageId,
    conversationId: args.conversationId,
    userId: null,
    role: 'assistant',
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    toolResults: toolResults.length > 0 ? toolResults : undefined,
    uiMessage: merged,
  });
}

// --- Global Assistant conversations --------------------------------------

export async function applyAskUserResultsToGlobalMessage(args: {
  messageId: string;
  conversationId: string;
  results: ClientAskUserResult[];
}): Promise<{ merged: boolean }> {
  if (args.results.length === 0) return { merged: false };

  const [row] = await db
    .select()
    .from(globalMessages)
    .where(
      and(
        eq(globalMessages.id, args.messageId),
        eq(globalMessages.conversationId, args.conversationId),
        eq(globalMessages.isActive, true)
      )
    )
    .limit(1);

  if (!row || row.role !== 'assistant') return { merged: false };

  const uiMessage = await convertGlobalAssistantMessageToUIMessage({
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
  });

  const { parts, changed } = mergeResultsIntoParts(uiMessage.parts, args.results);
  if (!changed) return { merged: false };

  const merged: UIMessage = { ...uiMessage, parts };
  const content = extractMessageContent(merged);
  const toolCalls = extractToolCalls(merged);
  const toolResults = extractToolResults(merged);

  await saveGlobalAssistantMessageToDatabase({
    messageId: args.messageId,
    conversationId: args.conversationId,
    userId: row.userId,
    role: 'assistant',
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    toolResults: toolResults.length > 0 ? toolResults : undefined,
    uiMessage: merged,
  });

  return { merged: true };
}

export async function dismissPendingAskUserForGlobalConversation(args: {
  conversationId: string;
}): Promise<void> {
  const [row] = await db
    .select()
    .from(globalMessages)
    .where(
      and(
        eq(globalMessages.conversationId, args.conversationId),
        eq(globalMessages.isActive, true),
        eq(globalMessages.role, 'assistant')
      )
    )
    .orderBy(desc(globalMessages.createdAt))
    .limit(1);

  if (!row) return;

  const uiMessage = await convertGlobalAssistantMessageToUIMessage({
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
  });

  const pendingIds = pendingAskUserToolCallIds(uiMessage.parts);
  if (pendingIds.length === 0) return;

  const results: ClientAskUserResult[] = pendingIds.map((toolCallId) => ({
    toolCallId,
    output: { dismissed: true, reason: DISMISSED_REASON },
  }));

  const { parts, changed } = mergeResultsIntoParts(uiMessage.parts, results);
  if (!changed) return;

  const merged: UIMessage = { ...uiMessage, parts };
  const content = extractMessageContent(merged);
  const toolCalls = extractToolCalls(merged);
  const toolResults = extractToolResults(merged);

  await saveGlobalAssistantMessageToDatabase({
    messageId: row.id,
    conversationId: args.conversationId,
    userId: row.userId,
    role: 'assistant',
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    toolResults: toolResults.length > 0 ? toolResults : undefined,
    uiMessage: merged,
  });
}
