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
 * CALLERS MUST PASS `isStreaming` FROM `status === 'streaming'`, never from the looser
 * `submitted || streaming`. useChat sets status='submitted' BEFORE issuing the request and
 * pushes the new assistant message only inside write(), which flips the status to 'streaming'
 * in the same job. So during the whole submitted window the array's last assistant message is
 * THE PREVIOUS TURN'S reply — and resolving to it means aborting a message that finished
 * minutes ago while the real generation keeps running and keeps billing.
 *
 * (An earlier version of this docstring claimed the submitted window is one "where no assistant
 * id exists yet". That is true only of the very first turn of a conversation. On every turn
 * after that, an id exists — it is just the wrong one.)
 *
 * Returns `undefined` in the `submitted`-before-first-chunk window; callers fall back to the
 * chatId abort, which is correct there.
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
