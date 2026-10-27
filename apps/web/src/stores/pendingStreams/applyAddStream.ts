import type { UIMessage } from 'ai';

type UIMessagePart = UIMessage['parts'][number];

export interface PendingStream {
  messageId: string;
  pageId: string;
  conversationId: string;
  triggeredBy: { userId: string; displayName: string };
  parts: UIMessagePart[];
  isOwn: boolean;
  /** ISO timestamp of the stream's start, used to stamp synthesized bubbles with a `createdAt`. */
  startedAt?: string;
  /**
   * Monotonic write counter, set by `setStreamParts`. Absent until the first
   * replace-semantics write — `addStream`/`appendPart` never set it.
   */
  lastSeq?: number;
}

export type PendingStreamsMap = Map<string, PendingStream>;

/**
 * No-op when the messageId already exists — so initial `parts` (a restored
 * server snapshot) seed at most once even when co-mounted surfaces
 * bootstrap the same channel concurrently.
 */
export const applyAddStream = (
  streams: PendingStreamsMap,
  stream: Omit<PendingStream, 'parts' | 'lastSeq'> & { parts?: UIMessagePart[] },
): PendingStreamsMap => {
  if (streams.has(stream.messageId)) return streams;
  const next = new Map(streams);
  next.set(stream.messageId, { ...stream, parts: stream.parts ?? [] });
  return next;
};
