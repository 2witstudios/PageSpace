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
 * - Pending id already present in server list: returns serverMessages (deduped to one).
 */
export const mergeServerAndPending = (
  serverMessages: UIMessage[],
  pendingParts: readonly UIMessagePart[],
  pendingMessageId: string | undefined,
): UIMessage[] => {
  if (pendingMessageId === undefined) return serverMessages;
  if (serverMessages.some((m) => m.id === pendingMessageId)) return serverMessages;
  return [...serverMessages, synthesizeAssistantMessage(pendingMessageId, pendingParts)];
};
