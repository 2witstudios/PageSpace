import type { UIMessage } from 'ai';
import { synthesizeAssistantMessage } from './synthesizeAssistantMessage';

type UIMessagePart = UIMessage['parts'][number];

/**
 * Reconciles a server-loaded message list with an in-flight pending stream so
 * a DB reload during an active own-stream never drops or double-renders the
 * streaming assistant message.
 *
 * - No pending stream (pendingMessageId undefined): returns serverMessages as-is.
 * - Pending id absent from server list: appends a synthesized assistant message.
 * - Pending id present with a non-'streaming' status (or no status — legacy/pre-PR2 rows and
 *   every row from a client that hasn't opted into includeStreaming=1): returns serverMessages
 *   (deduped to one) — the server row is the finished message, strictly newer than the stream.
 * - Pending id present with status:'streaming' (Server Stream Durability epic PR 2 — a client
 *   that opted into includeStreaming=1 can now see its own in-flight placeholder row): that row
 *   is an empty, mid-flight DB snapshot — strictly STALER than the pending stream's own buffered
 *   parts. The live pending message replaces it in place, at the same array position.
 */
export const mergeServerAndPending = (
  serverMessages: UIMessage[],
  pendingParts: readonly UIMessagePart[],
  pendingMessageId: string | undefined,
  pendingStartedAt?: string,
): UIMessage[] => {
  if (pendingMessageId === undefined) return serverMessages;
  const index = serverMessages.findIndex((m) => m.id === pendingMessageId);
  if (index === -1) {
    return [...serverMessages, synthesizeAssistantMessage(pendingMessageId, pendingParts, pendingStartedAt)];
  }
  const matched = serverMessages[index] as UIMessage & { status?: string };
  if (matched.status !== 'streaming') return serverMessages;
  const next = serverMessages.slice();
  next[index] = synthesizeAssistantMessage(pendingMessageId, pendingParts, pendingStartedAt);
  return next;
};
