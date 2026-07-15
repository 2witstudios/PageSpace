import type { PendingStream, PendingStreamsMap } from './applyAddStream';

export interface ApplySetStreamPartsEvent {
  messageId: string;
  parts: PendingStream['parts'];
  seq: number;
}

/**
 * Replaces a stream's parts wholesale — unlike `appendPart`'s incremental
 * merge, this is for writers whose source is already the fully-merged
 * snapshot at any tick (the own-stream mirror reads useChat's local message,
 * which is exactly that). No-ops on an unknown messageId.
 *
 * Gated by `seq`: a write whose seq does not exceed the entry's current
 * `lastSeq` is stale — superseded by a later tick (e.g. a delayed effect
 * re-run) — and is dropped rather than clobbering newer parts.
 */
export const applySetStreamParts = (
  streams: PendingStreamsMap,
  event: ApplySetStreamPartsEvent,
): PendingStreamsMap => {
  const existing = streams.get(event.messageId);
  if (!existing) return streams;
  if (event.seq <= (existing.lastSeq ?? -1)) return streams;

  const next = new Map(streams);
  next.set(event.messageId, { ...existing, parts: event.parts, lastSeq: event.seq });
  return next;
};
