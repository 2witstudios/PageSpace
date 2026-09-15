import type { UIMessage } from 'ai';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { buildAssistantPersistencePayload } from '@/lib/ai/core/persistAssistantParts';
import { ASK_USER_TOOL_NAME, askUserOutputSchema } from '@/lib/ai/tools/ask-user-tools';
import {
  pageAdapter,
  globalAdapter,
  type AssistantMessageAdapter,
} from '@/lib/ai/core/assistant-message-adapter';

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
