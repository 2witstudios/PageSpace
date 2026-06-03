/**
 * Resolves the stable assistant messageId to abort when the user clicks stop.
 *
 * The server registers its AbortController under the assistant `messageId`
 * (`serverAssistantMessageId`), and the client's rendered assistant message
 * shares that id (`generateId: () => serverAssistantMessageId`). So aborting by
 * messageId reliably reaches the server registry — unlike the chatId→streamId
 * map, which can be orphaned when the conversation id shifts mid-stream.
 *
 * Precedence:
 *   1. `ownStreamMessageId` — an own stream tracked via the multicast/bootstrap
 *      path (e.g. after a refresh mid-stream); always the authoritative target.
 *   2. The last assistant message id, but only while `useChat` is actively
 *      streaming it (the rendered streaming bubble === serverAssistantMessageId).
 *
 * Returns `undefined` only in the brief `submitted`-before-first-chunk window
 * where no assistant id exists yet; callers fall back to the chatId abort.
 */
export const resolveActiveAssistantMessageId = ({
  ownStreamMessageId,
  isStreaming,
  lastAssistantMessageId,
}: {
  ownStreamMessageId: string | undefined;
  isStreaming: boolean;
  lastAssistantMessageId: string | null | undefined;
}): string | undefined => {
  if (ownStreamMessageId) return ownStreamMessageId;
  if (isStreaming && lastAssistantMessageId) return lastAssistantMessageId;
  return undefined;
};
