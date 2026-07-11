/**
 * Suppressing the scrollback REPLAY on an in-place reconnect.
 *
 * Attaching to an exec session is defined to replay it: "when you attach to a
 * session, the server immediately sends the session's scrollback buffer as
 * stdout data" (sprites.dev/api/sprites/exec). That is exactly what a FRESH
 * viewer wants — open a terminal, get its history back. It is exactly what a
 * transparent, in-place reconnect does NOT want: the @fly/sprites watchdog
 * declares the socket dead after 45s with no inbound frame, so an idle prompt
 * trips it on a fixed cadence, `reconnect()` silently reattaches, and the replay
 * lands in an xterm that already shows every byte of it — the "opening banner
 * reprints every ~45s" bug.
 *
 * The dedupe is a pure stream transformer over BYTES (a UTF-8 code point is 1-4
 * bytes, so any arithmetic on decoded-string lengths cuts the tail in the wrong
 * place). Its inputs are `seen` — a rolling tail of what the client has actually
 * been shown — and the replayed chunks. Its job is to find where `seen` ENDS
 * inside the replay and emit only what follows.
 *
 * ## Why content, and not a byte counter
 *
 * The obvious implementation is a counter: remember how many bytes we forwarded,
 * skip that many off the front of the replay. It is correct only if the replay
 * always starts at stream offset 0 — i.e. if the server's scrollback is
 * unbounded. Neither the docs nor the SDK say that, and a bounded ring is the
 * normal shape for a scrollback. If the ring has trimmed its head, the replay
 * starts MID-stream, the counter's skip runs long, and it swallows the session's
 * LIVE output — a permanently frozen terminal, a far worse bug than a duplicate
 * banner.
 *
 * ## The invariant: we only ever suppress bytes the client demonstrably has
 *
 * Suppressing everything up to and including a match is sound for one reason:
 * inside a REPLAY, every byte preceding the match is older stream content, and
 * the client — which has watched this session from the start — has seen all of
 * it. Two things could break that, and both are closed here:
 *
 * 1. The match might not be in the replay at all. Once a replay is unalignable,
 *    the caller's buffer keeps filling with LIVE output; an anchor that recurs
 *    there (a TUI repainting the same bytes) would match past the true boundary
 *    and drop output the client never saw. So a match is CORROBORATED: the bytes
 *    preceding it must also be the bytes that precede the anchor in `seen`. A
 *    repaint reproduces the anchor; it does not reproduce the tens of KiB of
 *    unrelated history in front of it.
 * 2. The search could run forever over live output. The caller bounds the replay
 *    window (quiet gap, wall-clock deadline, MAX_PENDING_BYTES) and calls
 *    `flushReplay` to close it; after that every byte passes through unsearched.
 *
 * When alignment fails, the bytes are emitted verbatim. The accepted failure mode
 * is duplication — a redraw — never loss.
 */

const EMPTY = Buffer.alloc(0);

const concat = (head: Buffer, tail: Buffer): Buffer => {
  if (head.length === 0) return tail;
  if (tail.length === 0) return head;
  return Buffer.concat([head, tail]);
};

/**
 * How much of the delivered stream is retained as `seen`. Its tail is the anchor
 * we search for; the rest is what corroborates a match. 64 KiB mirrors the
 * app-side scrollback bound (`MAX_SCROLLBACK_BYTES`) — the same order as the
 * history a client is holding anyway.
 */
export const MAX_SEEN_BYTES = 64 * 1024;

/**
 * The tail of `seen` used as the search key. Long enough to be unique in a
 * replay (a bare `$ ` would match anywhere), short enough that a reconnect whose
 * gap output has pushed the ring forward can still find it — the anchor only has
 * to survive inside the replay window, while everything behind it merely has to
 * corroborate.
 */
export const MAX_ANCHOR_BYTES = 8 * 1024;

/**
 * How many un-emitted replay bytes the caller may hold while looking for the
 * boundary. Bounds the memory one attach can pin.
 */
export const MAX_PENDING_BYTES = 256 * 1024;

/**
 * The shortest overlap worth trusting when the anchor was never found whole (see
 * `flushReplay`). Long enough that matching it by chance is not a realistic
 * concern — a lone `\n`, or a bare `$ ` prompt, would otherwise "overlap" with
 * almost any replay and trim real bytes off its front.
 */
const MIN_TRUSTED_OVERLAP = 64;

export type ReplayState = {
  /** Replayed bytes received in THIS attach that we can't yet classify. */
  pending: Buffer;
  /**
   * The boundary has been decided (found, or given up on) — from here to the end
   * of this attach every byte is live output and passes straight through.
   */
  resolved: boolean;
};

/** A new attach starts with nothing buffered and nothing decided. */
export const freshReplayState = (): ReplayState => ({ pending: EMPTY, resolved: false });

/**
 * The rolling tail of what the client has actually been given. Reset to empty
 * whenever a FRESH session replaces the shell: that session shares no history
 * with the one the client saw, so it has nothing to dedupe against and every byte
 * of it is new.
 */
export function trackForwarded(seen: Buffer, emitted: Buffer): Buffer {
  // Always a COPY, never a view: `emitted` is typically a subarray of the pending
  // buffer (up to MAX_PENDING_BYTES) or of Node's chunk pool, and a view would
  // pin that whole parent allocation for the life of the shell.
  const tail = seen.length === 0 ? Buffer.from(emitted) : Buffer.concat([seen, emitted]);
  if (tail.length <= MAX_SEEN_BYTES) return tail;
  return Buffer.from(tail.subarray(tail.length - MAX_SEEN_BYTES));
}

const anchorOf = (seen: Buffer): Buffer =>
  seen.length <= MAX_ANCHOR_BYTES ? seen : seen.subarray(seen.length - MAX_ANCHOR_BYTES);

/**
 * Is the anchor match at `at` really the replay's boundary, and not the same
 * bytes recurring in live output? Check what sits IN FRONT of it: in a replay
 * that is the stream's own history, so it must equal the history we hold in front
 * of our anchor. A repaint reproduces the anchor, not the unrelated kilobytes
 * before it.
 *
 * `at === 0` needs no corroboration and can get none: the replay window opens
 * exactly at the anchor, so there is nothing in front of it to compare. That is
 * only reachable for a genuine replay anyway — the scrollback is sent first, so
 * the first byte of an attach is a replayed byte, never a live repaint.
 */
function corroborated({ seen, pending, at, anchorLength }: {
  seen: Buffer;
  pending: Buffer;
  at: number;
  anchorLength: number;
}): boolean {
  const history = seen.subarray(0, seen.length - anchorLength);
  const depth = Math.min(at, history.length);
  if (depth === 0) return true;
  return pending.subarray(at - depth, at).equals(history.subarray(history.length - depth));
}

/**
 * Decide what of an inbound chunk the client should actually see.
 *
 * - Nothing seen yet (fresh session / fresh viewer) → nothing to dedupe: pass
 *   through, delivering the full scrollback exactly once. This is what preserves
 *   the cold-attach UX.
 * - A corroborated anchor match → the client already has everything up to and
 *   including it; emit only the tail that follows. Covers the full overlap (an
 *   idle reconnect → emit nothing) and the partial one (replayed bytes plus
 *   genuinely new output → emit just the new part).
 * - Otherwise → buffer. Emitting now would print a duplicate; the chunk that
 *   completes the anchor resolves it, and if none ever does, `flushReplay` closes
 *   the window.
 */
export function planReplayEmission({
  seen,
  chunk,
  state,
}: {
  seen: Buffer;
  chunk: Buffer;
  state: ReplayState;
}): { emit: Buffer; state: ReplayState } {
  if (state.resolved || seen.length === 0) {
    // `pending` is empty on every path that reaches here today (`seen` is frozen
    // for the life of an attach). Emitting it rather than assuming that keeps a
    // future caller who DOES recompute it from silently dropping buffered output.
    return { emit: concat(state.pending, chunk), state: { pending: EMPTY, resolved: true } };
  }

  const pending = concat(state.pending, chunk);
  const anchor = anchorOf(seen);

  // Take the first match that corroborates. An uncorroborated one is not the
  // boundary — keep looking past it rather than trusting it.
  for (let at = pending.indexOf(anchor); at !== -1; at = pending.indexOf(anchor, at + 1)) {
    if (!corroborated({ seen, pending, at, anchorLength: anchor.length })) continue;
    return { emit: pending.subarray(at + anchor.length), state: { pending: EMPTY, resolved: true } };
  }

  // Unalignable so far. Keep buffering until the bound — then take the safe loss
  // (duplication) rather than the unsafe one (swallowed output).
  if (pending.length > MAX_PENDING_BYTES) {
    return { emit: pending, state: { pending: EMPTY, resolved: true } };
  }
  return { emit: EMPTY, state: { pending, resolved: false } };
}

/**
 * The bytes at the head of `pending` that the client already has, for a replay
 * whose window opens PART-WAY INTO what we have seen — the case the anchor search
 * cannot see. The server's scrollback is a buffer of unknown size: if it reaches
 * back less far than our anchor, the anchor never appears in the replay whole, and
 * the already-seen prefix of that replay is whatever SUFFIX of `seen` the buffer
 * still reaches. So: the longest suffix of `seen` that is a prefix of the replay.
 *
 * Only meaningful once the replay is complete, which is why it lives in the flush
 * and not the per-chunk path — mid-replay, a longer overlap may still be one chunk
 * away.
 */
function seenPrefixLength(seen: Buffer, pending: Buffer): number {
  for (let k = Math.min(seen.length, pending.length); k >= MIN_TRUSTED_OVERLAP; k -= 1) {
    if (seen.subarray(seen.length - k).equals(pending.subarray(0, k))) return k;
  }
  return 0;
}

/**
 * Close the replay window: release whatever is still buffered, minus any head of
 * it the client provably already has. The caller arms this on the first quiet gap,
 * at a hard deadline, and on exit — so a replay we cannot fully align costs at
 * worst a partial redraw, never the output itself.
 */
export function flushReplay(seen: Buffer, state: ReplayState): { emit: Buffer; state: ReplayState } {
  if (state.resolved) return { emit: EMPTY, state };
  const alreadySeen = seenPrefixLength(seen, state.pending);
  return { emit: state.pending.subarray(alreadySeen), state: { pending: EMPTY, resolved: true } };
}
