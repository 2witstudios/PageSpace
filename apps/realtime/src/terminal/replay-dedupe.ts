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
 * place). Its job: given the tail of what we already handed the client, find
 * where that content ENDS inside the replayed stream and emit only what follows.
 *
 * ## Why an anchor, and not a byte counter
 *
 * The obvious implementation is a counter: remember how many bytes we forwarded,
 * skip that many off the front of the replay. It is correct only if the replay
 * always starts at stream offset 0 — i.e. if the server's scrollback buffer is
 * unbounded. Neither the docs nor the SDK say that, and a bounded ring is the
 * normal shape for a scrollback. If the ring has trimmed its head, the replay
 * starts MID-stream, the counter's skip runs long, and it swallows the session's
 * LIVE output — a permanently frozen terminal, which is a far worse bug than the
 * duplicate banner. Matching on content cannot make that mistake: every byte we
 * suppress is a byte we can prove the client already has.
 *
 * The failure mode we accept instead is duplication, never loss: if the anchor
 * can't be found (the ring trimmed past it, or the boundary is genuinely
 * ambiguous) the buffered bytes are emitted verbatim — today's behaviour.
 */

const EMPTY = Buffer.alloc(0);

/**
 * How much of the forwarded stream we keep as the anchor. It has to be long
 * enough to be unique in the replay (a bare `$ ` would match anywhere) and small
 * enough to hold per live terminal. 8 KiB is far past the point where a shell's
 * output repeats itself byte-for-byte, and a whole idle session's output — the
 * case this leaf exists for — fits inside it entirely.
 */
export const MAX_ANCHOR_BYTES = 8 * 1024;

/**
 * How many un-emitted replay bytes we will hold while looking for the anchor.
 * Bounds the memory a single attach can pin, and bounds how long an UNALIGNABLE
 * replay (see the module doc) is withheld before we give up and emit it.
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
 * The rolling tail of what the client has actually been given — the anchor the
 * next in-place reconnect matches its replay against. Reset to empty whenever a
 * FRESH session replaces the shell: that session shares no history with the one
 * the client saw, so it has nothing to dedupe against and every byte is new.
 */
export function trackForwarded(anchor: Buffer, emitted: Buffer): Buffer {
  const tail = anchor.length === 0 ? emitted : Buffer.concat([anchor, emitted]);
  return tail.length <= MAX_ANCHOR_BYTES ? tail : tail.subarray(tail.length - MAX_ANCHOR_BYTES);
}

/**
 * Decide what of an inbound chunk the client should actually see.
 *
 * - No anchor (fresh session / fresh viewer) → nothing to dedupe: pass through,
 *   and deliver the full scrollback exactly once. This is what preserves the
 *   fresh-attach UX.
 * - Anchor found in the (accumulated) replay → the client already has everything
 *   up to and including it; emit only the tail that follows. Covers both the full
 *   overlap (idle reconnect → emit nothing) and the partial one (replayed bytes
 *   plus genuinely new output → emit just the new part).
 * - Anchor not found yet → buffer. Emitting now would print a duplicate; the
 *   chunk that completes the anchor resolves it.
 *
 * The first match is taken deliberately. A later one would be the more "recent"
 * boundary, but if the anchor's bytes recur, choosing the later occurrence
 * suppresses everything between them — real output. The earlier boundary can only
 * ever err the other way, toward re-printing something the client had.
 */
export function planReplayEmission({
  anchor,
  chunk,
  state,
}: {
  anchor: Buffer;
  chunk: Buffer;
  state: ReplayState;
}): { emit: Buffer; state: ReplayState } {
  if (state.resolved || anchor.length === 0) {
    return { emit: chunk, state: { pending: EMPTY, resolved: true } };
  }

  const pending = state.pending.length === 0 ? chunk : Buffer.concat([state.pending, chunk]);

  const at = pending.indexOf(anchor);
  if (at !== -1) {
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
 * The shortest overlap worth trusting when the anchor was never found whole (see
 * `flushReplay`). Long enough that matching it by chance is not a realistic
 * concern — a lone `\n`, or a bare `$ ` prompt, would otherwise "overlap" with
 * almost any replay and trim real bytes off its front.
 */
const MIN_TRUSTED_OVERLAP = 64;

/**
 * The bytes at the head of `pending` that the client already has, for a replay
 * whose window opens PART-WAY INTO the anchor — the case `planReplayEmission`
 * cannot see. The server's scrollback is a buffer of unknown size: if it holds
 * less than the anchor (or trimmed to somewhere inside it), the anchor never
 * appears in the replay whole, and the already-seen prefix of that replay is
 * whatever SUFFIX of the anchor the buffer still reaches back to. So: the longest
 * suffix of the anchor that is a prefix of the replay.
 *
 * Only meaningful once the replay is complete, which is why it lives in the flush
 * and not in the per-chunk path — mid-replay, a longer overlap may still be one
 * chunk away.
 */
function seenPrefixLength(anchor: Buffer, pending: Buffer): number {
  for (let k = Math.min(anchor.length, pending.length); k >= MIN_TRUSTED_OVERLAP; k -= 1) {
    if (anchor.subarray(anchor.length - k).equals(pending.subarray(0, k))) return k;
  }
  return 0;
}

/**
 * Release whatever is still buffered, minus any head of it the client provably
 * already has. The caller arms this when a replay goes quiet without the anchor
 * ever turning up (and on exit), so a replay we cannot fully align costs at worst
 * a partial redraw — never the output itself.
 */
export function flushReplay(anchor: Buffer, state: ReplayState): { emit: Buffer; state: ReplayState } {
  if (state.resolved) return { emit: EMPTY, state };
  const seen = seenPrefixLength(anchor, state.pending);
  return { emit: state.pending.subarray(seen), state: { pending: EMPTY, resolved: true } };
}
