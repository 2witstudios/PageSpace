import { appendPart as appendPartPure } from '@/lib/ai/streams/appendPart';
import type { PendingStream, PendingStreamsMap } from './applyAddStream';

export interface ApplyAppendPartEvent {
  messageId: string;
  part: PendingStream['parts'][number];
}

/** Incremental merge-append (reuses `appendPart`'s shape-aware merge). No-ops on an unknown messageId. */
export const applyAppendPart = (
  streams: PendingStreamsMap,
  event: ApplyAppendPartEvent,
): PendingStreamsMap => {
  const existing = streams.get(event.messageId);
  if (!existing) return streams;
  const next = new Map(streams);
  next.set(event.messageId, { ...existing, parts: appendPartPure(existing.parts, event.part) });
  return next;
};
