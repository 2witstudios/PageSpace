import type { UIMessage } from 'ai';
import { STREAM_MAX_LIFETIME_MS } from '@/lib/ai/core/stream-horizons';

// Hard cap on how long an entry survives without finish() — a leak backstop, not a policy.
// Shares STREAM_MAX_LIFETIME_MS with the abort registry and the heartbeat cap: if this were
// shorter, a still-running long generation would be reported as live by /active-streams
// while no client could join it any more.
const MAX_STREAM_AGE_MS = STREAM_MAX_LIFETIME_MS;

export type UIMessagePart = UIMessage['parts'][number];

export interface StreamMeta {
  pageId: string;
  userId: string;
  displayName: string;
  conversationId: string;
  browserSessionId: string;
}

interface Subscriber {
  onChunk: (part: UIMessagePart) => void;
  onComplete: (aborted: boolean) => void;
}

interface StreamEntry {
  meta: StreamMeta;
  buffer: UIMessagePart[];
  subscribers: Map<symbol, Subscriber>;
  finished: boolean;
  cleanupTimeoutId: ReturnType<typeof setTimeout> | null;
}

export class StreamMulticastRegistry {
  private entries = new Map<string, StreamEntry>();

  register(messageId: string, meta: StreamMeta): void {
    // Notify and evict any existing entry so its subscribers aren't silently dropped.
    this.finish(messageId, true);

    const cleanupTimeoutId = setTimeout(() => {
      this.finish(messageId, true);
    }, MAX_STREAM_AGE_MS);

    this.entries.set(messageId, {
      meta,
      buffer: [],
      subscribers: new Map(),
      finished: false,
      cleanupTimeoutId,
    });
  }

  push(messageId: string, part: UIMessagePart): void {
    const entry = this.entries.get(messageId);
    if (!entry || entry.finished) return;

    entry.buffer.push(part);
    for (const subscriber of entry.subscribers.values()) {
      try {
        subscriber.onChunk(part);
      } catch {
        // one bad subscriber must not break fanout to others
      }
    }
  }

  subscribe(
    messageId: string,
    onChunk: (part: UIMessagePart) => void,
    onComplete: (aborted: boolean) => void,
  ): (() => void) | null {
    const entry = this.entries.get(messageId);
    if (!entry || entry.finished) return null;

    for (const part of entry.buffer) {
      onChunk(part);
    }

    const key = Symbol();
    entry.subscribers.set(key, { onChunk, onComplete });

    return () => {
      entry.subscribers.delete(key);
    };
  }

  finish(messageId: string, aborted = false): void {
    const entry = this.entries.get(messageId);
    if (!entry || entry.finished) return;

    entry.finished = true;

    if (entry.cleanupTimeoutId !== null) {
      clearTimeout(entry.cleanupTimeoutId);
      entry.cleanupTimeoutId = null;
    }

    this.entries.delete(messageId);

    for (const subscriber of entry.subscribers.values()) {
      try {
        subscriber.onComplete(aborted);
      } catch {
        // one bad subscriber must not prevent others from being notified
      }
    }
  }

  getBufferedParts(messageId: string): UIMessagePart[] {
    return this.entries.get(messageId)?.buffer.slice() ?? [];
  }

  getMeta(messageId: string): StreamMeta | undefined {
    return this.entries.get(messageId)?.meta;
  }
}

// Single-process only — streams registered on one Node.js instance are not visible to others.
export const streamMulticastRegistry = new StreamMulticastRegistry();
