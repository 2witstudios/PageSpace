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
 * inputs are `seen` — a rolling tail of the REPLAYABLE stream (the bound session's
 * stdout) this client has been shown — and the replayed chunks. Its job is to find
 * where `seen` ENDS inside the replay and emit only what follows.
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
 * The window is bounded from two sides. The CALLER bounds it in time — a quiet gap and a
 * wall-clock deadline — and closes it with `flushReplay`. THIS MODULE bounds it in bytes,
 * at MAX_PENDING_BYTES, and that give-up resolves the state right here without the caller's
 * close ever running. That split is why BOTH give-ups must be reported by the caller: the
 * byte-cap one never reaches `flushReplay`, so a report written only there would leave the
 * one failure that never heals as the only silent one. Once the window is closed, every
 * later byte passes through unsearched.
 *
 * What that leaves, honestly: the proof is a byte comparison, so it cannot tell a replay
 * from an EXACT reproduction of one. Two numbers describe the risk, and they are NOT the
 * same number. Both are derived below rather than asserted, because the difference between
 * them is the whole safety argument.
 *
 * A match at offset `at` SUPPRESSES `at + anchorLen` bytes. `corroborated` PROVES only
 * `depth = min(at, history)` of them. So:
 *
 *   - What the stream must contain for a false match to be accepted (the precondition):
 *         anchorLen + depth,  which is at most `seen.length` — 64 KiB.
 *     At `at = 0` nothing precedes the match, `corroborated` compares zero bytes (it cannot
 *     compare what is not there), and a replica of the anchor ALONE — 8 KiB — is accepted at
 *     a replay's head. That is the weakest point: a full-screen TUI repaint landing exactly on
 *     the ring's boundary can produce one. And when `seen` is shorter than the anchor bound
 *     the anchor IS the whole history, so it collapses to `seen.length` — which for a young
 *     terminal is a few hundred bytes.
 *
 *   - What such a match can COST (the magnitude): everything in front of it that was never
 *     proven — `at - depth` bytes — goes with it. That is bounded by the replay window, not by
 *     the anchor: up to MAX_PENDING_BYTES. A single false match can therefore swallow far more
 *     than it reproduced. The suppression exceeds the proof, deliberately: in a GENUINE replay
 *     everything before the anchor is older stream content the client has already watched, and
 *     refusing to suppress it would mean refusing to dedupe any ring that reaches back further
 *     than our 64 KiB of history — i.e. giving up the feature to guard a corner case.
 *
 * Realistically it takes violently periodic output — a `while true` loop printing the same
 * kilobytes, a repainting TUI — where the dropped bytes are indistinguishable from their
 * neighbours anyway. Fuzzing over non-periodic output finds no loss at all. It is bounded
 * and understood, not a guarantee quietly assumed away.
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
 * How deep the corroboration must reach when it cannot cover the WHOLE suppressed prefix
 * (see `corroborated`). It is a FLOOR on a partial proof, not a tax on every match: a match
 * whose entire prefix is proven (`depth === at`) is accepted however short that prefix is.
 * So this binds only where `at` runs past the history we still hold — and there a false match
 * would have to reproduce the anchor AND 4 KiB of unrelated history in front of it,
 * contiguously and byte for byte, which no screen repaint does.
 */
export const MIN_CORROBORATION_BYTES = 4 * 1024;

/**
 * How many anchor occurrences we will test before declaring the replay
 * unalignable. Self-similar output (a screenful of padding) can put the anchor at
 * thousands of offsets; without a bound, each one would cost a corroboration
 * compare, on the realtime process's event loop, driven by bytes the sandbox
 * chose. Giving up early is safe — it emits verbatim.
 *
 * It bounds the CORROBORATION work — 8 candidates, each a compare of at most `seen`. It does
 * NOT bound the SEARCH, and that distinction was worth ~600ms of blocked event loop: see
 * HASH_BASE.
 */
export const MAX_MATCH_CANDIDATES = 8;

/**
 * The rolling-hash base. Any odd multiplier works; this one is conventional.
 *
 * `pending.indexOf(anchor)` — the obvious search — is O(region x anchor) on input engineered
 * to NEAR-miss: at every offset it compares almost the whole 8 KiB anchor before failing. A
 * TUI repainting runs of blank padding just under the anchor's length does exactly that, and
 * it cost **588ms inside a single 'data' handler**, on the process every terminal shares. Not
 * a throughput cost — a stall, and the sandbox picks the bytes. It is the third quadratic this
 * module has had to close (the others: rescanning from zero, and re-copying `pending`).
 *
 * A short probe would be cheap but IMPRECISE: inside a run of identical bytes it hits at every
 * offset, burning the candidate budget on positions the anchor cannot start at. Rabin-Karp is
 * both. Hashing is O(1) per position, so the scan is O(region); a hash match is only a
 * candidate, verified with one `equals` (a memcmp that quits on the first differing byte)
 * before corroboration runs. Candidates stay charged to MAX_MATCH_CANDIDATES, so a collision
 * attack can still cost us a suppression — never a byte, and never the event loop.
 *
 * The honest cost of the trade: `indexOf` is native (a SIMD memmem) and this is a JS byte loop,
 * so the BENIGN unalignable case got SLOWER. Two harnesses measured that penalty as 3-4x and as
 * ~11x, so take the ratio as "single digits to low double digits" and not as a figure — it moves
 * with machine and framing, and an earlier version of this comment stated one to three digits of
 * precision it had not earned.
 *
 * The shape is what matters, and the shape is stable: the loss is THROUGHPUT, spread thin. A 4 MiB
 * replay costs single-digit milliseconds more in total, across ~16k handlers, and the worst SINGLE
 * handler stays about a millisecond either way (measured ~0.8ms with `indexOf`, ~1.0ms here) — no
 * frame becomes a stall. What it buys is the removal of one: 588ms of solid event loop inside a
 * single 'data' handler, on bytes an adversary picks. Trading a little throughput everywhere for a
 * stall nowhere is the right trade on a shared process, but it IS a cost, not a free win.
 */
const HASH_BASE = 131;

/**
 * Byte-folds performed, for tests only.
 *
 * The memo below and the rolling chain carried in `ReplayState.hash` are PURE PERFORMANCE: delete
 * either and every behavioural test still passes while per-chunk work silently returns to
 * O(anchor) — the quadratic this search exists to close. Work done is invisible in the emitted
 * bytes, so a counter is the only seam a test can hold those two guards by. Both of the O(anchor)
 * loops they eliminate fold, and nothing on the steady-state path does; a warm chunk folds ZERO.
 */
let folds = 0;
export const foldCount = (): number => folds;
export const resetFoldCount = (): void => {
  folds = 0;
};

/** One step of the fold, pinned to int32 so two paths to the same value always compare equal. */
const fold = (hash: number, byte: number): number => {
  folds += 1;
  return (Math.imul(hash, HASH_BASE) + byte) | 0;
};

type AnchorHash = { anchor: Buffer; target: number; pow: number };

/**
 * The anchor and its hash, computed ONCE per attach.
 *
 * `seen` is frozen for the life of an attach and arrives as the same Buffer on every chunk, so
 * it keys the memo. Recomputing the hash per chunk would cost O(anchor) each time — 8 KiB of
 * work per 256-byte frame, which is its own quadratic and exactly the trap this search exists
 * to avoid.
 */
const anchorHashes = new WeakMap<Buffer, AnchorHash>();
function anchorHashOf(seen: Buffer): AnchorHash {
  const memo = anchorHashes.get(seen);
  if (memo !== undefined) return memo;

  const anchor = anchorOf(seen);
  let target = 0;
  for (let i = 0; i < anchor.length; i += 1) target = fold(target, anchor[i]);
  // `pow` = HASH_BASE^(n-1): the weight of the byte rolling OUT of the window.
  let pow = 1;
  for (let i = 1; i < anchor.length; i += 1) pow = Math.imul(pow, HASH_BASE);

  const fresh = { anchor, target, pow };
  anchorHashes.set(seen, fresh);
  return fresh;
}

/**
 * How many un-emitted replay bytes the caller may hold while looking for the boundary.
 * Bounds the memory one attach can pin (transient — only while a replay is unresolved).
 *
 * THIS CAP MUST EXCEED THE SERVER'S SCROLLBACK RING. The anchor sits at the END of a replay,
 * so if the ring is bigger than this, the anchor arrives after we have already given up: the
 * search never reaches it, the replay is emitted verbatim, and it happens again on the NEXT
 * reconnect, and the next. That is not a degradation that heals — it is the original bug,
 * reprinting the whole scrollback every 45 seconds, for any terminal whose ring exceeds this
 * number. (Fuzzing a 1.5 MiB ring against a 1 MiB cap reproduces exactly that: the whole
 * ring — 1.5 MiB, the reprint is the ring, exactly — on every idle cycle, indefinitely.)
 *
 * So this errs large, deliberately. Erring large costs transient memory during a reconnect;
 * erring small costs the entire feature for the terminals that need it most — the ones with
 * a lot of scrollback. The shell reports EVERY give-up (`reportUnaligned`), this one with
 * `cause: 'pending-cap'`, so a ring that outgrows the cap says so in the logs instead of
 * quietly reverting to the bug.
 */
export const MAX_PENDING_BYTES = 4 * 1024 * 1024;

/** Why a replay could not be placed. Both are reported by the caller; see `history`. */
export type GiveUpCause =
  /** The held bytes outgrew MAX_PENDING_BYTES before the anchor arrived. Decided here. */
  | 'pending-cap'
  /** The caller's window shut with the anchor still unseen. Decided by `flushReplay`. */
  | 'window-closed';

export type ReplayEmission = {
  emit: Buffer;
  state: ReplayState;
  /**
   * What the caller must do with its history — and the reason this type is not just a
   * buffer. `seen` must stay a CONTIGUOUS RUN of the session's stream; that is the whole
   * basis of the anchor. A give-up re-emits bytes the history may already hold, so
   * APPENDING those splices a duplicate of the past into the run and breaks it. For an idle
   * terminal — where `seen` is smaller than the anchor bound, so the anchor IS the whole
   * history, the exact shape the 45s watchdog cycles on — a broken run matches no future
   * replay, and the banner reprints on every cycle from then on. One transient blip would
   * permanently restore the bug this module exists to remove.
   *
   * So a give-up REPLACES the history instead of extending it. A replay's bytes are
   * themselves a contiguous run of the stream, so taking them as the new history restores
   * the invariant rather than corrupting it.
   */
  history: 'append' | 'restart';
  /**
   * Present exactly when this emission is a give-up (and so exactly when `history` is
   * 'restart'). The module knows WHY it gave up; the caller would otherwise have to infer
   * it from the one branch that produces it today, and would silently mislabel the next.
   */
  giveUp?: GiveUpCause;
};

/**
 * The allocation `pending` is being grown inside. Mutable, and deliberately so: it is
 * how appending a chunk stays O(chunk) instead of O(pending) — see `appendPending`.
 *
 * `used` is the guard that keeps that safe. It is the arena's high-water mark, so a
 * state whose `pending` ends short of it is a STALE fork of the run (someone reused an
 * older state), and appending to it in place would overwrite bytes another state's
 * `pending` still spans. Appending copies out to a fresh arena in that case.
 */
type PendingArena = { buf: Buffer; used: number };

export type ReplayState = {
  /** Replayed bytes received in THIS attach that we can't yet classify. */
  pending: Buffer;
  /**
   * Where `pending` lives, when it has room to grow into. Absent on a state nobody has
   * appended to yet, and on one a caller synthesized from bytes of its own — an arena is
   * an optimization this module hands itself, never something a caller has to supply.
   */
  arena?: PendingArena;
  /**
   * How far into `pending` the anchor search has already looked, and will not look again.
   * Not quite "tested and rejected": once MAX_MATCH_CANDIDATES trips, the positions past the
   * last candidate are skipped UNTESTED. That only ever loses a suppression (the replay goes
   * out verbatim), never a byte — see the search in `planReplayEmission`.
   */
  scanned: number;
  /**
   * The rolling hash of the anchor-sized window ending at `pending`'s end — the chain the next
   * chunk's search resumes from, so it never has to rebuild the window from scratch. Absent
   * when there is no whole window yet, or when a candidate budget cut the scan short.
   */
  hash?: number;
  /**
   * The boundary has been decided (found, or given up on) — from here to the end
   * of this attach every byte is live output and passes straight through.
   */
  resolved: boolean;
};

/** A new attach starts with nothing buffered and nothing decided. */
export const freshReplayState = (): ReplayState => ({ pending: EMPTY, scanned: 0, resolved: false });

/** Nothing left to classify: every later byte of this attach passes straight through. */
// Frozen: one object is the resolved state of every attach on a process that hosts every
// terminal, so a stray write would corrupt all of them at once.
const RESOLVED: ReplayState = Object.freeze({ pending: EMPTY, scanned: 0, resolved: true });

/** The smallest arena worth allocating — a few WS frames' worth of headroom. */
const MIN_ARENA_BYTES = 16 * 1024;

/**
 * `pending` with `chunk` appended, without re-copying `pending` to do it.
 *
 * `Buffer.concat(pending, chunk)` copies the whole buffer per chunk, which is quadratic
 * in BYTES even though the SCAN is bounded — and the two are independent. A sandbox that
 * emits MAX_PENDING_BYTES in 256-byte frames across an unalignable reconnect turns 4 MiB
 * of its own output into tens of GB of memcpy on the process every terminal shares: an
 * amplification the sandbox picks the size of. So `pending` grows like a vector instead —
 * allocate with headroom, write into the headroom, double when it runs out — and the total
 * copying over an attach is O(bytes).
 *
 * Writing past `pending.length` is only safe because the arena says those bytes are ours.
 * A Buffer straight off Node's chunk pool is a VIEW into an 8 KiB arena shared with
 * unrelated buffers; writing past its end would corrupt them.
 */
function appendPending(state: ReplayState, chunk: Buffer): Pick<ReplayState, 'pending' | 'arena'> {
  const { pending, arena } = state;
  const fits =
    arena !== undefined &&
    arena.used === pending.length &&
    chunk.length <= arena.buf.length - arena.used;
  if (fits) {
    chunk.copy(arena.buf, arena.used);
    arena.used += chunk.length;
    return { pending: arena.buf.subarray(0, arena.used), arena };
  }
  const length = pending.length + chunk.length;
  const buf = Buffer.allocUnsafe(Math.max(length * 2, MIN_ARENA_BYTES));
  pending.copy(buf, 0);
  chunk.copy(buf, pending.length);
  return { pending: buf.subarray(0, length), arena: { buf, used: length } };
}

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
 *
 * Caps both the copy a small delivery pays (it rewrites at most this much) and the number
 * of blocks the history can hold. That block bound is 2 × MAX_SEEN_BYTES / this — 32, not
 * the 16 that dividing the two would suggest. Individual blocks CAN be tiny (alternate a
 * 1-byte delivery with a 4 KiB one and every other block is a single byte), but they cannot
 * be tiny in a row: a block is closed only because the next delivery would overflow it, so
 * a closed block plus the delivery that closed it exceed this together. Consecutive blocks
 * sum past the block size, and pairing them bounds the count at twice the naive figure.
 * Either way it is the low tens the materialize-per-attach cost is priced against.
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
 * - `at === 0`: nothing precedes the match, so nothing can corroborate it — the compare
 *   below would run over zero bytes and pass. Stated explicitly rather than left to
 *   emerge from the arithmetic, because it is this scheme's weakest point and a reader
 *   deserves to see it plainly: a replica of the anchor alone, at a replay's head, IS
 *   accepted (see the module header's bound). Nothing is suppressed here but the anchor
 *   itself, which matched.
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
    return { emit: concat(state.pending, chunk), state: RESOLVED, history: 'append' };
  }

  const { pending, arena } = appendPending(state, chunk);
  const { anchor, target, pow } = anchorHashOf(seen);

  // Search only where a match could newly START. Everything before `state.scanned` has been
  // looked at already: rejected against a strictly smaller buffer (and rejection is permanent,
  // because corroboration only ever looks BACKWARD from the match while pending only grows
  // forward, so no later byte can rehabilitate an earlier candidate) — or skipped, when the
  // candidate bound below cut the scan short. Skipping costs a suppression, never a byte: the
  // replay simply goes out verbatim.
  //
  // Rescanning from zero on every chunk is one of the two ways this went quadratic in the
  // bytes a sandbox chose to emit — restoring it costs ~100ms of solid event loop for a 1 MiB
  // unalignable replay in 256-byte frames, and ~1650ms for a 4 MiB one (it is quadratic, so
  // the cap is where it hurts), on the process every terminal shares. `appendPending` closes
  // the other way (the per-chunk re-copy). Bounding the candidate count without bounding the
  // scan would have left this one open, one line down.
  const from = state.scanned;
  const n = anchor.length;
  const lastStart = pending.length - n; // the last position a whole anchor could start at
  // The hash of the window at `from`, carried forward from the previous chunk when we can:
  // that chunk rolled as far as its own last window, which sits exactly one byte behind this
  // one. Rebuilding it from scratch is O(anchor), and paying that per 256-byte frame is the
  // very cost this search exists to avoid — so it is only paid when the chain is broken.
  let rolling: number | undefined;
  if (from <= lastStart) {
    const prev = from - 1;
    if (state.hash !== undefined && prev >= 0 && prev + n < pending.length) {
      rolling = (Math.imul(state.hash - Math.imul(pending[prev], pow), HASH_BASE) + pending[prev + n]) | 0;
    } else {
      rolling = 0;
      for (let i = from; i < from + n; i += 1) rolling = fold(rolling, pending[i]);
    }
  }

  let hash: number | undefined;
  let tried = 0;
  for (let at = from; rolling !== undefined && at <= lastStart; at += 1) {
    // A hash match is not a match: verify the bytes. `equals` is a memcmp that quits on the
    // first differing byte, so a collision costs almost nothing.
    if (rolling === target && pending.subarray(at, at + n).equals(anchor)) {
      if (corroborated({ seen, pending, at, anchorLength: n })) {
        return { emit: pending.subarray(at + n), state: RESOLVED, history: 'append' };
      }
      // Not the boundary — the anchor's bytes merely recur here. Keep looking past it.
      tried += 1;
      if (tried >= MAX_MATCH_CANDIDATES) break;
    }
    if (at === lastStart) {
      hash = rolling; // the chain the next chunk resumes from
      break;
    }
    // Roll one byte forward: drop `pending[at]`, take `pending[at + n]`.
    rolling = (Math.imul(rolling - Math.imul(pending[at], pow), HASH_BASE) + pending[at + n]) | 0;
  }

  // Unalignable. Hold the bytes until the caller closes the window — and if they
  // overflow first, emit them: duplication is survivable, losing them is not.
  if (pending.length > MAX_PENDING_BYTES) {
    return { emit: pending, state: RESOLVED, history: 'restart', giveUp: 'pending-cap' };
  }
  // A match can still begin in the last `anchor.length - 1` bytes: those are the only
  // start positions the next chunk could complete.
  const scanned = Math.max(0, pending.length - anchor.length + 1);
  return { emit: EMPTY, state: { pending, arena, scanned, hash, resolved: false }, history: 'append' };
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
/**
 * Where a `wire()`'d command's replay comes from — the axis `resolveGiveUpAction` decides on.
 *
 * - `'transparent-attach'`: an in-place RECONNECT's attach to the session the client was
 *   already watching (an idle-shell keepalive drop, an optimistic reattach when `listSessions`
 *   is unavailable). The viewer never left — every byte a replay on this attach could carry has
 *   already been shown, live, so a give-up here is pure duplication.
 * - `'fresh'`: everything else. A shell's very FIRST `wire()` (a fresh viewer opening the
 *   terminal, or a caller reattaching after ITS OWN restart) and a reconnect that CREATES a
 *   new session (the old one is gone; nothing of its output is on the client's screen) both
 *   want a give-up's bytes shown — there is no continuously-watching viewer to have already
 *   seen them.
 */
export type AttachKind = 'transparent-attach' | 'fresh';

/**
 * A give-up's TERMINAL ACTION: show the unaligned bytes (today's baseline — see the give-up
 * doc above, "duplication is survivable"), or drop them.
 *
 * That baseline is right for a fresh session and wrong for a transparent reconnect: an idle
 * AGENT terminal (a repainting TUI status line, a `SIGWINCH`-triggered redraw off
 * `attachSession`'s own `{cols,rows}`) violates byte-equality on almost every ~45s keepalive
 * cycle, so "reprint rather than risk losing a byte" becomes "repaint on top of itself every
 * 45s" for exactly the terminals that need the dedupe most. On THAT reconnect the viewer has
 * been continuously attached, so nothing is actually at risk: the replay is redundant, not
 * unverifiable, and can be dropped outright.
 *
 * Detection is unchanged — `planReplayEmission`/`flushReplay` still decide alignment purely
 * from bytes, with no notion of where the attach came from. This is the decision layered on
 * top of a give-up they already produced, so the caller can still record the bytes as history
 * (a give-up is itself a contiguous run of the stream — see `deliver`'s `restart` doc) without
 * being forced to also show them.
 */
export function resolveGiveUpAction({ attachKind }: { attachKind: AttachKind }): 'emit' | 'discard' {
  return attachKind === 'transparent-attach' ? 'discard' : 'emit';
}

export function flushReplay(state: ReplayState): ReplayEmission {
  // Nothing held is not a give-up. A window can close over an attach that never received a
  // byte — a socket that died before it opened — and calling THAT a give-up would report a
  // reprint that never happened and hand the caller a 'restart' with nothing to restart FROM.
  // Today's caller absorbs that (`deliver` refuses zero-length bytes before it wipes), so the
  // damage would be a false alarm rather than a lost anchor — but a contract that says "replace
  // your history with these zero bytes" is a trap laid for the next one. Nothing was given up
  // on; say so.
  if (state.resolved || state.pending.length === 0) {
    return { emit: EMPTY, state: RESOLVED, history: 'append' };
  }
  return { emit: state.pending, state: RESOLVED, history: 'restart', giveUp: 'window-closed' };
}
