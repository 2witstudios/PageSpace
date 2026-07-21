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
 * Pure decision core for what a failed (`!ok`) poll tick means.
 *
 * `'suspend'` — an auth failure (401/403). The 1s interval must STOP, not retry: the session
 * cookie/bearer is dead, and re-polling every second just hammers the device-refresh endpoint
 * ~1/sec until the rate limit locks the user out (the D2 "API-401 storm" that stranded desktop
 * users). Polling resumes only once `auth-fetch` dispatches `auth:refreshed`.
 *
 * `'continue'` — any other non-ok status (network blip, 429, 5xx). Transient: swallow it and
 * retry on the next interval, exactly as before.
 */
export function decidePollTickOutcome(status: number): 'continue' | 'suspend' {
  return status === 401 || status === 403 ? 'suspend' : 'continue';
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
 * Best-effort: a single failed (network/non-ok) tick is swallowed and retried on the next one
 * (the stream itself is durable regardless — this only affects how fresh the mid-stream view
 * looks). Stops when `signal` aborts. Does not detect stream completion itself via a done
 * sentinel; the caller is expected to abort `signal` once `chat:stream_complete` arrives and let
 * the normal DB-reload path take over for the final, authoritative content.
 *
 * The row disappearing from the response IS treated as terminal, though (Codex review finding):
 * `active-streams` filters to `status='streaming'` AND to what this user may subscribe to (same
 * filter `stream-join` itself applies) — so a missing row means either the stream finished, or
 * this 404 was never a liveness gap to begin with (e.g. a private conversation, distinguishable
 * from the intended cross-instance case only by outcome, not by the join's own 404 status). Both
 * are un-recoverable by polling further: `onNotFound` fires once and the interval stops, instead
 * of ticking forever against a row that will never reappear.
 */
export function startStreamJoinPollFallback(
  channelId: string,
  messageId: string,
  signal: AbortSignal,
  onSnapshot: (parts: UIMessagePart[]) => void,
  onNotFound: () => void,
): void {
  if (signal.aborted) return;

  // The interval is stopped-and-restarted across auth-failure suspends, so it is a mutable
  // handle rather than a `const`. `null` means "not currently polling" (suspended, or terminally
  // stopped after a row-gone / abort).
  let intervalId: ReturnType<typeof setInterval> | null = null;
  // The `auth:refreshed` resume listener, tracked so the abort cleanup can remove it if the caller
  // gives up mid-suspend (before any refresh lands) — otherwise it would leak past this poll.
  let resumeListener: (() => void) | null = null;

  const startInterval = (): void => {
    intervalId = setInterval(() => void tick(), STREAM_JOIN_POLL_INTERVAL_MS);
  };

  const stopInterval = (): void => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const clearResumeListener = (): void => {
    if (resumeListener) {
      window.removeEventListener('auth:refreshed', resumeListener);
      resumeListener = null;
    }
  };

  // Auth failure: kill the 1s interval and wait — once, no polling in the meantime — for
  // `auth-fetch` to announce a healed session via `auth:refreshed`. On that event, resume with an
  // immediate tick (don't make the user wait a full interval for fresh content) plus a fresh
  // interval. "Unless the signal is aborted, restart" is enforced by the abort cleanup below,
  // which removes this listener the instant the caller gives up — so a suspended-then-aborted
  // poll can never resume, and the `{ once: true }` listener never leaks. (No inner
  // `signal.aborted` re-check: an aborted signal removes this listener synchronously, so it
  // simply never fires afterward.)
  const suspendUntilAuthRefreshed = (): void => {
    stopInterval();
    resumeListener = () => {
      resumeListener = null; // consumed — the browser already removed the once-listener
      startInterval();
      void tick();
    };
    window.addEventListener('auth:refreshed', resumeListener, { once: true });
  };

  const tick = async (): Promise<void> => {
    if (signal.aborted) return;
    try {
      const res = await fetchWithAuth(
        `/api/ai/chat/active-streams?channelId=${encodeURIComponent(channelId)}`,
        { credentials: 'include', signal },
      );
      if (signal.aborted) return;
      if (!res.ok) {
        if (decidePollTickOutcome(res.status) === 'suspend') suspendUntilAuthRefreshed();
        return;
      }
      const data = (await res.json()) as ActiveStreamsPollResponse;
      if (signal.aborted) return;
      const row = (data.streams ?? []).find((s) => s.messageId === messageId);
      if (!row) {
        stopInterval();
        onNotFound();
        return;
      }
      onSnapshot((row.parts ?? []).filter(isValidPartFrame));
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) return;
      console.warn('[stream-join-poll-fallback] poll tick failed, retrying next interval', err);
    }
  };

  void tick();
  // `tick`'s closure references `intervalId`/`resumeListener` before this line runs — safe because
  // those branches only execute asynchronously, after both are initialized: `void tick()` above
  // suspends at its first `await` and returns control here synchronously.
  startInterval();
  signal.addEventListener('abort', () => {
    stopInterval();
    clearResumeListener();
  }, { once: true });
}
