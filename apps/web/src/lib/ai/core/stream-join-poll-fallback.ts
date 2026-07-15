import type { UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { isValidPartFrame } from '@/lib/ai/streams/isValidPartFrame';

type UIMessagePart = UIMessage['parts'][number];

/** Matches the server's checkpoint cadence (CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS) — polling any
 * faster cannot see fresher content; any slower widens the gap this fallback exists to close. */
export const STREAM_JOIN_POLL_INTERVAL_MS = 1000;

interface ActiveStreamsPollResponse {
  streams?: { messageId: string; parts?: unknown[] }[];
}

/**
 * Leaf 5.4 — cross-instance rejoin fallback. When an SSE stream-join 404s, the usual cause is
 * that the stream lives on another web instance: the multicast registry is per-process, so
 * this instance simply cannot see its live tokens (see `stream-join-client.ts`'s
 * `StreamJoinError` doc). The generation is still running, still checkpointing its parts
 * snapshot to `ai_stream_sessions` roughly every second (see checkpoint-scheduler.ts's
 * `CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS`) — so instead of freezing the view until
 * `chat:stream_complete` finally arrives, poll that same channel-scoped snapshot at (about)
 * that cadence for a near-live view. A stopgap until the AI SDK 7 Phase 3 durable transport
 * removes the per-process registry dependency entirely.
 *
 * Best-effort: a single failed tick is swallowed and retried on the next one (the stream
 * itself is durable regardless — this only affects how fresh the mid-stream view looks).
 * Stops when `signal` aborts. Does not detect stream completion itself; the caller is expected
 * to abort `signal` once `chat:stream_complete` arrives and let the normal DB-reload path take
 * over for the final, authoritative content.
 */
export function startStreamJoinPollFallback(
  channelId: string,
  messageId: string,
  signal: AbortSignal,
  onSnapshot: (parts: UIMessagePart[]) => void,
): void {
  if (signal.aborted) return;

  const tick = async (): Promise<void> => {
    if (signal.aborted) return;
    try {
      const res = await fetchWithAuth(
        `/api/ai/chat/active-streams?channelId=${encodeURIComponent(channelId)}`,
        { credentials: 'include', signal },
      );
      if (signal.aborted || !res.ok) return;
      const data = (await res.json()) as ActiveStreamsPollResponse;
      if (signal.aborted) return;
      const row = (data.streams ?? []).find((s) => s.messageId === messageId);
      if (!row) return;
      onSnapshot((row.parts ?? []).filter(isValidPartFrame));
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) return;
      console.warn('[stream-join-poll-fallback] poll tick failed, retrying next interval', err);
    }
  };

  void tick();
  const intervalId = setInterval(() => void tick(), STREAM_JOIN_POLL_INTERVAL_MS);
  signal.addEventListener('abort', () => clearInterval(intervalId), { once: true });
}
