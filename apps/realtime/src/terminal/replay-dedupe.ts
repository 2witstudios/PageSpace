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
 * bytes, so arithmetic on decoded-string lengths cuts in the wrong place). Its
 * inputs are `seen` — a rolling tail of what the client has actually been shown —
 * and the replayed chunks. Its job is to find where `seen` ENDS inside the replay
 * and emit only what follows.
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
 * ## The one invariant: never suppress a byte the client has not seen
 *
 * Duplication is survivable — it costs a redraw. Loss is not: it is a terminal
 * that silently ate your build output. So suppression happens ONLY where the
 * bytes being dropped are proven, byte for byte, against the history we hold:
 *
 * - A match must be CORROBORATED. Finding the anchor is not enough: once a replay
 *   is unalignable, the caller's buffer keeps filling with LIVE output, and a TUI
 *   repainting the anchor's bytes would match past the true boundary and drop
 *   output nobody has seen. So the bytes IN FRONT of a match must also be the
 *   bytes that precede the anchor in `seen` — either all of them (`at` bytes deep,
 *   which proves the whole suppressed prefix outright), or at least
 *   MIN_CORROBORATION_BYTES of them. A repaint reproduces the anchor; it does not
 *   reproduce kilobytes of unrelated history in front of it.
 * - When nothing can be proven, the bytes are emitted verbatim. There is
 *   deliberately no "probably the replay" heuristic on the give-up path: output
 *   repeats itself (progress bars, `watch`, heartbeat lines), so a suffix that
 *   happens to match `seen`'s tail is exactly as likely to be a NEW identical line
 *   as a replayed one — and guessing wrong there deletes it.
 *
 * The caller is responsible for bounding the replay window (quiet gap, wall-clock
 * deadline, MAX_PENDING_BYTES) and calling `flushReplay` to close it; after that
 * every byte passes through unsearched.
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
 * app-side scrollback bound (`MAX_SCROLLBACK_BYTES` in terminal-session-map) —
 * the same order as the history the client is holding anyway.
 */
export const MAX_SEEN_BYTES = 64 * 1024;

/**
 * The tail of `seen` used as the search key. Long enough to be unique in a replay
 * (a bare `$ ` would match anywhere), short enough to leave room in front of it
 * for the corroboration that makes a match provable.
 */
export const MAX_ANCHOR_BYTES = 8 * 1024;

/**
 * How deep the corroboration must reach when it cannot cover the WHOLE suppressed
 * prefix (see `corroborated`). A false match would have to reproduce the 8 KiB
 * anchor AND the 4 KiB of unrelated history in front of it, contiguously and byte
 * for byte — which no screen repaint does.
 */
export const MIN_CORROBORATION_BYTES = 4 * 1024;

/**
 * How many anchor occurrences we will test before declaring the replay
 * unalignable. Self-similar output (a screenful of padding) can put the anchor at
 * thousands of offsets; without a bound, each one would cost a corroboration
 * compare, on the realtime process's event loop, driven by bytes the sandbox
 * chose. Giving up early is safe — it emits verbatim.
 */
export const MAX_MATCH_CANDIDATES = 8;

/**
 * How many un-emitted replay bytes the caller may hold while looking for the
 * boundary. Bounds the memory one attach can pin.
 */
export const MAX_PENDING_BYTES = 256 * 1024;

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
 * The bytes the client has been shown, kept as the chunks they were delivered in
 * rather than one growing buffer: appending to a 64 KiB Buffer copies all of it,
 * per chunk, forever, and a shell that writes in small bursts would spend most of
 * its time memcpying its own history. Materialized once per attach instead.
 */
export type SeenTail = { readonly chunks: readonly Buffer[]; readonly bytes: number };

export const EMPTY_SEEN: SeenTail = { chunks: [], bytes: 0 };

/**
 * Record bytes just delivered to the client, dropping history past the bound.
 * Whole chunks are dropped, so the tail may carry slightly more than
 * MAX_SEEN_BYTES — bounded, and cheaper than re-slicing.
 */
export function rememberDelivered(seen: SeenTail, emitted: Buffer): SeenTail {
  if (emitted.length === 0) return seen;
  // Copy: `emitted` is typically a view into the pending buffer or Node's chunk
  // pool, and keeping the view would pin that whole parent allocation.
  const chunks = [...seen.chunks, Buffer.from(emitted)];
  let bytes = seen.bytes + emitted.length;
  while (bytes > MAX_SEEN_BYTES && chunks.length > 1) {
    bytes -= chunks[0].length;
    chunks.shift();
  }
  return { chunks, bytes };
}

/** The retained history as one buffer — call once per attach, not per chunk. */
export function materializeSeen(seen: SeenTail): Buffer {
  if (seen.chunks.length === 0) return EMPTY;
  if (seen.chunks.length === 1) return seen.chunks[0];
  return Buffer.concat([...seen.chunks]);
}

const anchorOf = (seen: Buffer): Buffer =>
  seen.length <= MAX_ANCHOR_BYTES ? seen : seen.subarray(seen.length - MAX_ANCHOR_BYTES);

/**
 * Is the anchor match at `at` really the replay's boundary, and not the same bytes
 * recurring in live output? Everything in front of a genuine match is the stream's
 * own history, so it must equal the history we hold in front of our anchor.
 *
 * - `at === 0`: nothing is being suppressed except the anchor itself, which
 *   matched. Sound, and the only judgement available — there is nothing in front
 *   of it to compare.
 * - Otherwise the `at` bytes in front of the match are about to be dropped, so they
 *   must be PROVEN: either every one of them matches the history (`depth === at`),
 *   or at least MIN_CORROBORATION_BYTES of them do. A shorter proof is no proof —
 *   note that when `seen` is smaller than the anchor bound the history is EMPTY, so
 *   any match at `at > 0` is unprovable and must be refused, not waved through.
 */
function corroborated({ seen, pending, at, anchorLength }: {
  seen: Buffer;
  pending: Buffer;
  at: number;
  anchorLength: number;
}): boolean {
  if (at === 0) return true;
  const history = seen.subarray(0, seen.length - anchorLength);
  const depth = Math.min(at, history.length);
  if (depth < at && depth < MIN_CORROBORATION_BYTES) return false;
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
 *   the window and the bytes go out verbatim.
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

  let at = pending.indexOf(anchor);
  for (let tried = 0; at !== -1 && tried < MAX_MATCH_CANDIDATES; tried += 1) {
    if (corroborated({ seen, pending, at, anchorLength: anchor.length })) {
      return { emit: pending.subarray(at + anchor.length), state: { pending: EMPTY, resolved: true } };
    }
    // Not the boundary — the anchor's bytes merely recur here. Keep looking past it.
    at = pending.indexOf(anchor, at + 1);
  }

  // Unalignable. Hold the bytes until the caller closes the window — and if they
  // overflow first, emit them: duplication is survivable, losing them is not.
  if (pending.length > MAX_PENDING_BYTES) {
    return { emit: pending, state: { pending: EMPTY, resolved: true } };
  }
  return { emit: EMPTY, state: { pending, resolved: false } };
}

/**
 * Close the replay window, releasing whatever is still buffered. The caller arms
 * this on each quiet gap, at a hard deadline, on a socket error (where no reattach
 * is guaranteed to replay the bytes) and on exit.
 *
 * The bytes go out VERBATIM. It is tempting to trim a head of them that matches
 * `seen`'s tail — but a terminal repeats itself (progress bars, `watch`, heartbeat
 * lines), so a matching suffix is as likely to be a new identical line as a
 * replayed one, and trimming it would delete output the client never saw. An
 * unalignable replay costs a redraw. That is the whole trade.
 */
export function flushReplay(state: ReplayState): { emit: Buffer; state: ReplayState } {
  if (state.resolved) return { emit: EMPTY, state };
  return { emit: state.pending, state: { pending: EMPTY, resolved: true } };
}
