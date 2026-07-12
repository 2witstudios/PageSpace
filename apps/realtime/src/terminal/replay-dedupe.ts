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
 * ## The rule: never suppress a byte we cannot prove the client has seen
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
 *
 * What that leaves, honestly: the proof is a byte comparison, so it cannot tell a
 * replay from an EXACT reproduction of one. Loss therefore remains possible in one
 * corner — the server's ring must have evicted the true anchor (so there is nothing
 * genuine to match) AND the stream must then contain a >= 12 KiB contiguous replica
 * of `seen`'s tail (8 KiB anchor + 4 KiB corroboration) inside the replay window.
 * Realistically that means violently periodic output — a `while true` loop printing
 * the same kilobytes — where the dropped bytes are indistinguishable from their
 * neighbours anyway. It is bounded and understood, not a guarantee we are quietly
 * assuming away.
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
 * boundary. Bounds the memory one attach can pin (transient, and only while a
 * replay is unresolved).
 *
 * The anchor sits at the END of a replay, so the boundary can only be found if the
 * whole replayed scrollback fits in here. Sized to be comfortably larger than any
 * plausible server-side scrollback ring, precisely because that ring's size is not
 * documented (see the module header): if the replay overflows this, we give up and
 * emit it verbatim — which is safe, but reprints the scrollback, i.e. the bug this
 * module exists to fix. Erring large costs transient memory; erring small costs the
 * feature.
 */
export const MAX_PENDING_BYTES = 1024 * 1024;

/**
 * `aligned` is the difference between "these bytes continue the stream" and "we gave up
 * and re-emitted bytes the history may already hold".
 *
 * It exists because `seen` must stay a CONTIGUOUS RUN of the session's stream — that is
 * the whole basis of the anchor. An unaligned emission is a replay we could not place, so
 * appending it to the history splices a duplicate of the past into it, and the run breaks.
 * For an idle terminal — where `seen` is smaller than the anchor bound, so the anchor IS
 * the whole history, which is the exact shape the 45s watchdog cycles on — a broken run can
 * never match any future replay, and the banner reprints on every cycle from then on. One
 * transient blip would permanently restore the bug this module exists to remove.
 *
 * So an unaligned emission does not extend the history: it REPLACES it (see the caller).
 * The bytes of a replay are themselves a contiguous run of the session's stream, so taking
 * them as the new history restores the invariant instead of corrupting it.
 */
export type ReplayEmission = {
  emit: Buffer;
  state: ReplayState;
  aligned: boolean;
};

export type ReplayState = {
  /** Replayed bytes received in THIS attach that we can't yet classify. */
  pending: Buffer;
  /**
   * How far into `pending` the anchor search has already looked. Every start
   * position below this was tested and rejected, permanently — see the search in
   * `planReplayEmission`.
   */
  scanned: number;
  /**
   * The boundary has been decided (found, or given up on) — from here to the end
   * of this attach every byte is live output and passes straight through.
   */
  resolved: boolean;
};

/** A new attach starts with nothing buffered and nothing decided. */
export const freshReplayState = (): ReplayState => ({ pending: EMPTY, scanned: 0, resolved: false });

/** Nothing left to classify: every later byte of this attach passes straight through. */
const RESOLVED: ReplayState = { pending: EMPTY, scanned: 0, resolved: true };

/**
 * The bytes of the REPLAYABLE stream (stdout) delivered to this client — what a
 * future replay can be matched against. stderr is deliberately absent: the server
 * replays stdout, so recording stderr would splice bytes into the history that no
 * replay contains, and the anchor would stop matching.
 *
 * Held in blocks rather than one growing buffer, and materialized once per attach.
 * Appending to a single 64 KiB buffer would copy all of it on every delivered
 * chunk; keeping every chunk separately trades that for an O(block-count) rebuild
 * per chunk, which is WORSE for an interactive shell (a keystroke echo is one byte,
 * and the count would run to tens of thousands). So small deliveries coalesce into
 * the tail block: the count stays in the low tens, and both regimes stay cheap.
 */
export type SeenTail = { readonly chunks: readonly Buffer[]; readonly bytes: number };

export const EMPTY_SEEN: SeenTail = { chunks: [], bytes: 0 };

/**
 * The size a tail block may reach by coalescing before a new block is started.
 * Caps both the copy a small delivery pays (it rewrites at most this much) and the
 * number of blocks the history can hold (MAX_SEEN_BYTES / this).
 */
const COALESCE_BLOCK_BYTES = 4 * 1024;

/**
 * Record bytes just delivered to the client, dropping history past the bound.
 *
 * Trims TO the bound, never below it. Evicting whole blocks and stopping as soon as
 * the total fits would do exactly that: one block bigger than the bound — and this
 * module produces them itself, since the give-up flush emits a single buffer of up
 * to MAX_PENDING_BYTES, and a cold attach can deliver an entire scrollback in one
 * frame — evicts everything before it, and then the next byte evicts THAT, leaving
 * the history equal to one prompt. The anchor would collapse with it, no replay
 * would ever align again, and the banner would reprint on every watchdog cycle: the
 * very bug this module exists to fix, resurrected by an input it produced. So an
 * oversized head block is SLICED, not dropped.
 */
export function rememberDelivered(seen: SeenTail, emitted: Buffer): SeenTail {
  if (emitted.length === 0) return seen;
  const chunks = seen.chunks.slice();
  const tail = chunks[chunks.length - 1];
  if (tail !== undefined && tail.length + emitted.length <= COALESCE_BLOCK_BYTES) {
    // Small delivery (a keystroke echo, a prompt): fold it into the tail block
    // rather than minting another one.
    chunks[chunks.length - 1] = Buffer.concat([tail, emitted]);
  } else {
    // Copy: `emitted` is typically a view into the pending buffer or Node's chunk
    // pool, and keeping the view would pin that whole parent allocation.
    chunks.push(Buffer.from(emitted));
  }
  let bytes = seen.bytes + emitted.length;
  while (bytes > MAX_SEEN_BYTES) {
    const head = chunks[0];
    const excess = bytes - MAX_SEEN_BYTES;
    if (head.length <= excess) {
      chunks.shift();
      bytes -= head.length;
      continue;
    }
    chunks[0] = Buffer.from(head.subarray(excess));
    bytes -= excess;
  }
  return { chunks, bytes };
}

/** The retained history as one buffer — call once per attach, not per chunk. */
export function materializeSeen(seen: SeenTail): Buffer {
  if (seen.chunks.length === 0) return EMPTY;
  if (seen.chunks.length === 1) return seen.chunks[0];
  return Buffer.concat(seen.chunks);
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
}): ReplayEmission {
  if (state.resolved || seen.length === 0) {
    // `pending` is empty on every path that reaches here today (`seen` is frozen
    // for the life of an attach). Emitting it rather than assuming that keeps a
    // future caller who DOES recompute it from silently dropping buffered output.
    return { emit: concat(state.pending, chunk), state: RESOLVED, aligned: true };
  }

  const pending = concat(state.pending, chunk);
  const anchor = anchorOf(seen);

  // Search only where a match could newly START. Everything before `state.scanned`
  // was tested against a strictly smaller buffer and rejected — and rejection is
  // permanent, because corroboration only ever looks BACKWARD from the match while
  // pending only ever grows forward, so no later byte can rehabilitate an earlier
  // candidate. Rescanning from zero on every chunk is what made this quadratic: a
  // shell emitting 1 MiB in 256-byte chunks across an unalignable reconnect cost
  // ~570ms of solid event loop, on the process every terminal shares, driven by
  // bytes the sandbox chose. Bounding the candidate count without bounding the scan
  // left the same door open one line down.
  const from = state.scanned;
  let at = pending.indexOf(anchor, from);
  for (let tried = 0; at !== -1 && tried < MAX_MATCH_CANDIDATES; tried += 1) {
    if (corroborated({ seen, pending, at, anchorLength: anchor.length })) {
      return { emit: pending.subarray(at + anchor.length), state: RESOLVED, aligned: true };
    }
    // Not the boundary — the anchor's bytes merely recur here. Keep looking past it.
    at = pending.indexOf(anchor, at + 1);
  }

  // Unalignable. Hold the bytes until the caller closes the window — and if they
  // overflow first, emit them: duplication is survivable, losing them is not.
  if (pending.length > MAX_PENDING_BYTES) {
    return { emit: pending, state: RESOLVED, aligned: false };
  }
  // A match can still begin in the last `anchor.length - 1` bytes: those are the only
  // start positions the next chunk could complete.
  const scanned = Math.max(0, pending.length - anchor.length + 1);
  return { emit: EMPTY, state: { pending, scanned, resolved: false }, aligned: true };
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
export function flushReplay(state: ReplayState): ReplayEmission {
  if (state.resolved) return { emit: EMPTY, state, aligned: true };
  return { emit: state.pending, state: RESOLVED, aligned: false };
}
