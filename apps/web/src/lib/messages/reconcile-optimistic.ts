/**
 * Merging a server-confirmed message into a list that may still hold the
 * optimistic row that produced it.
 *
 * This lives in one place on purpose. The channel and DM surfaces each grew
 * their own reconcile strategy, and that divergence is what let a bug survive
 * on one surface while the other looked fine: the channel view dropped EVERY
 * pending row on the first confirmation, while the DM page matched rows by
 * comparing (content, fileId) — which cannot tell two attachment-only messages
 * apart, because both have empty content.
 *
 * Both now match on a nonce the sender mints and the server echoes back on the
 * response and the broadcast, so one confirmation retires exactly one pending
 * row.
 */

interface OptimisticallySent {
  /** Optimistic rows carry a `temp-` prefixed id until the server confirms. */
  id: string;
  /** Set on an in-flight send and echoed back by the server. Never stored. */
  clientNonce?: string;
}

const isPending = (row: OptimisticallySent) => row.id.startsWith('temp-');

interface AttachmentRef {
  fileId?: string | null;
  position?: number;
}

const orderedFileIds = (attachments: AttachmentRef[]) =>
  [...attachments]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((a) => a.fileId ?? null);

/**
 * Do two rows carry the same attachments? Used only by the nonce-less
 * fallback below, where content alone cannot tell two sends apart.
 *
 * Comparing just the FIRST file is not enough: two sends can share their text
 * and their first photo and differ from the second one on, and matching those
 * would retire the wrong pending row and leave the stream mis-ordered. So when
 * both sides name their batch, the whole ordered batch has to agree — and a
 * pending row carrying SEVERAL files is never matched by a payload that does
 * not name them at all.
 *
 * That last case costs nothing real: a server old enough to omit the nonce is
 * also old enough to read only `fileId`, so it rejects a multi-attachment send
 * outright (400, "Message content or file is required") rather than echoing
 * one. Refusing the match just declines to guess.
 */
export function sameAttachmentBatch(
  pending: { fileId?: string | null; attachments?: AttachmentRef[] | null },
  confirmed: { fileId?: string | null; attachments?: AttachmentRef[] | null },
): boolean {
  const pendingBatch = pending.attachments ?? [];
  const confirmedBatch = confirmed.attachments ?? [];

  if (pendingBatch.length > 0 && confirmedBatch.length > 0) {
    if (pendingBatch.length !== confirmedBatch.length) return false;
    const a = orderedFileIds(pendingBatch);
    const b = orderedFileIds(confirmedBatch);
    return a.every((fileId, index) => fileId === b[index]);
  }

  if (pendingBatch.length > 1) return false;

  return (pending.fileId ?? null) === (confirmed.fileId ?? null);
}

/**
 * Replace the pending row this message confirms, or append it if there is
 * none (which is the case for every other viewer in the channel).
 *
 * A message with no nonce, or whose nonce matches nothing, is appended unless
 * it is already present — so a re-delivered socket event is a no-op rather
 * than a duplicate.
 *
 * `authorOf` is how a nonce match is confirmed to be the sender's OWN echo.
 * The nonce travels to every subscriber in the broadcast and the API accepts
 * whatever nonce a caller sends, so another member of the channel can post a
 * message carrying a nonce they watched go by. Matching on the nonce alone
 * would let that message take over the pending row — the sender's own message
 * would disappear from their view until a refetch, replaced by someone else's.
 * The surfaces name the author differently (`userId` on a channel message,
 * `senderId` on a DM), hence an accessor rather than a field on the interface.
 */
export function reconcileOptimistic<T extends OptimisticallySent>(
  prev: T[],
  message: T,
  authorOf?: (row: T) => string | null | undefined,
  looksLikeSameSend?: (pending: T, confirmed: T) => boolean,
): T[] {
  const sameAuthor = (row: T) => {
    if (!authorOf) return true;
    const pendingAuthor = authorOf(row);
    const confirmedAuthor = authorOf(message);
    // An optimistic row always knows its author (the signed-in user built it),
    // so an unknown author on either side means "not a match" rather than
    // "close enough".
    return pendingAuthor != null && pendingAuthor === confirmedAuthor;
  };

  const nonceIndex = message.clientNonce
    ? prev.findIndex(
        (row) => isPending(row) && row.clientNonce === message.clientNonce && sameAuthor(row),
      )
    : -1;

  // A confirmation with NO nonce is what a server that predates the nonce
  // broadcasts — which is a real state during a rolling deploy: a new client
  // posts to an old pod, the echo comes back without the nonce it sent, and
  // nothing retires the pending row. That leaves the sender looking at their
  // own message twice, which is the bug this whole change exists to remove.
  //
  // So when there is no nonce to match, fall back to what the DM surface did
  // before it had one: the same author, the same content, the same attachment.
  // It is guesswork — two identical sends are indistinguishable — but they are
  // also interchangeable, and only ONE pending row is ever retired. The nonce
  // path above is still the only one that runs against a current server.
  const pendingIndex =
    nonceIndex !== -1 || !looksLikeSameSend || message.clientNonce
      ? nonceIndex
      : prev.findIndex(
          (row) => isPending(row) && sameAuthor(row) && looksLikeSameSend(row, message),
        );

  if (pendingIndex !== -1) {
    // Replace in place, so the message keeps its position in the stream rather
    // than jumping to the end. Any copy that already arrived by another route
    // (a refetch, say) is dropped in the same pass.
    return prev.reduce<T[]>((next, current, index) => {
      if (index !== pendingIndex && current.id === message.id) return next;
      next.push(index === pendingIndex ? message : current);
      return next;
    }, []);
  }

  if (prev.some((row) => row.id === message.id)) return prev;
  return [...prev, message];
}
