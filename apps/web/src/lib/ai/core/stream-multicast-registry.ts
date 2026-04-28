const MAX_STREAM_AGE_MS = 10 * 60 * 1000;

interface StreamMeta {
  pageId: string;
  userId: string;
}

interface Subscriber {
  onChunk: (text: string) => void;
  onComplete: (aborted: boolean) => void;
}

interface StreamEntry {
  meta: StreamMeta;
  buffer: string[];
  subscribers: Map<symbol, Subscriber>;
  finished: boolean;
  cleanupTimeoutId: ReturnType<typeof setTimeout> | null;
}

export class StreamMulticastRegistry {
  private entries = new Map<string, StreamEntry>();

  register(messageId: string, meta: StreamMeta): void {
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

  push(messageId: string, text: string): void {
    const entry = this.entries.get(messageId);
    if (!entry || entry.finished) return;

    entry.buffer.push(text);
    for (const subscriber of entry.subscribers.values()) {
      subscriber.onChunk(text);
    }
  }

  subscribe(
    messageId: string,
    onChunk: (text: string) => void,
    onComplete: (aborted: boolean) => void,
  ): (() => void) | null {
    const entry = this.entries.get(messageId);
    if (!entry || entry.finished) return null;

    for (const chunk of entry.buffer) {
      onChunk(chunk);
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

    for (const subscriber of entry.subscribers.values()) {
      subscriber.onComplete(aborted);
    }

    this.entries.delete(messageId);
  }

  getMeta(messageId: string): StreamMeta | undefined {
    return this.entries.get(messageId)?.meta;
  }
}

export const streamMulticastRegistry = new StreamMulticastRegistry();
