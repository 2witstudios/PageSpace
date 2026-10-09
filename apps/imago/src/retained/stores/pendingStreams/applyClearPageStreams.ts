import type { PendingStreamsMap } from './applyAddStream';

export const applyClearPageStreams = (streams: PendingStreamsMap, pageId: string): PendingStreamsMap => {
  let changed = false;
  const next: PendingStreamsMap = new Map();
  for (const [id, stream] of streams) {
    if (stream.pageId === pageId) {
      changed = true;
      continue;
    }
    next.set(id, stream);
  }
  return changed ? next : streams;
};
