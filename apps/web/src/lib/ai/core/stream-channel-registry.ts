import { STREAM_MAX_LIFETIME_MS } from '@/lib/ai/core/stream-horizons';
import { openStreamChannel, type StreamChannel } from '@/lib/ai/core/stream-channel';

/**
 * Process-local index of live stream channels, keyed by assistant `messageId`.
 *
 * Replaces `stream-multicast-registry.ts`. Same job — let a joiner find the generation it
 * wants to watch — but the entries hold raw `UIMessageChunk` frames rather than the
 * `chunkToPart` projection, and a subscriber addresses them by seq rather than by "replay
 * the whole buffer and trust the client to skip the right number of frames".
 *
 * Single-process, exactly as before: a channel opened on one Node instance is invisible to
 * the others, and `stream-join` degrades accordingly. That is unchanged by this module and
 * is the durable frame log's problem to solve, not this one's.
 */

export interface StreamMeta {
  pageId: string;
  userId: string;
  displayName: string;
  conversationId: string;
  browserSessionId: string;
}

interface Entry {
  channel: StreamChannel;
  meta: StreamMeta;
  evictionTimer: ReturnType<typeof setTimeout> | null;
}

export class StreamChannelRegistry {
  private entries = new Map<string, Entry>();

  /**
   * Open a channel for this messageId, replacing any existing one.
   *
   * A re-registered messageId (the retry/takeover path) finishes the previous channel
   * first, so its subscribers are told rather than silently stranded — the behaviour the
   * registry this replaces also had, and for the same reason.
   */
  open(messageId: string, meta: StreamMeta): StreamChannel {
    this.close(messageId, true);

    const channel = openStreamChannel({ messageId });

    // Leak backstop, not policy. A stream that ends normally removes its own entry in
    // `close()`; the only thing this reclaims is a channel whose process-side owner died
    // without finishing. Shares STREAM_MAX_LIFETIME_MS with the heartbeat cap and the abort
    // registry deliberately: when those three disagreed, a long generation still alive past
    // the shortest of them was reported as running while no client could join it and its
    // Stop button had already become a no-op. See stream-horizons.ts.
    const evictionTimer = setTimeout(() => {
      this.close(messageId, true);
    }, STREAM_MAX_LIFETIME_MS);
    evictionTimer.unref?.();

    this.entries.set(messageId, { channel, meta, evictionTimer });
    return channel;
  }

  get(messageId: string): StreamChannel | undefined {
    return this.entries.get(messageId)?.channel;
  }

  getMeta(messageId: string): StreamMeta | undefined {
    return this.entries.get(messageId)?.meta;
  }

  /** Finish the channel (notifying subscribers) and drop the entry. Idempotent. */
  close(messageId: string, aborted = false): void {
    const entry = this.entries.get(messageId);
    if (!entry) return;

    this.entries.delete(messageId);
    if (entry.evictionTimer !== null) clearTimeout(entry.evictionTimer);

    try {
      entry.channel.finish(aborted);
    } catch {
      // A subscriber throwing during teardown must not strand the entry.
    }
  }

  /** Test-only. Module state otherwise leaks across cases. */
  reset(): void {
    for (const messageId of [...this.entries.keys()]) this.close(messageId, true);
  }
}

export const streamChannelRegistry = new StreamChannelRegistry();
