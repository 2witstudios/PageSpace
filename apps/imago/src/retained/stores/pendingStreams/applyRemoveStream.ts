import type { PendingStreamsMap } from './applyAddStream';

export const applyRemoveStream = (streams: PendingStreamsMap, messageId: string): PendingStreamsMap => {
  if (!streams.has(messageId)) return streams;
  const next = new Map(streams);
  next.delete(messageId);
  return next;
};
