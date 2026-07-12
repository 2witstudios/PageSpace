import { describe, it, expect } from 'vitest';
import {
  EMPTY_SEEN,
  MAX_ANCHOR_BYTES,
  MAX_MATCH_CANDIDATES,
  MAX_PENDING_BYTES,
  MAX_SEEN_BYTES,
  flushReplay,
  freshReplayState,
  materializeSeen,
  planReplayEmission,
  rememberDelivered,
} from '../replay-dedupe';

// riteway-style assertion (given/should/actual/expected) on top of vitest — the
// repo doesn't vendor riteway and bun-only rules forbid adding a dependency for
// a handful of pure-function cases, so keep the contract, drop the package.
function assert<T>({ given, should, actual, expected }: { given: string; should: string; actual: T; expected: T }): void {
  it(`given ${given}, should ${should}`, () => {
    expect(actual).toEqual(expected);
  });
}

const buf = (s: string) => Buffer.from(s, 'utf8');

/** What a caller actually cares about: the text emitted, and whether dedupe is done. */
const plan = (args: { anchor: string; chunk: string; pending?: string; scanned?: number; resolved?: boolean }) => {
  const result = planReplayEmission({
    seen: buf(args.anchor),
    chunk: buf(args.chunk),
    state: {
      pending: buf(args.pending ?? ''),
      scanned: args.scanned ?? 0,
      resolved: args.resolved ?? false,
    },
  });
  return {
    emit: result.emit.toString('utf8'),
    pending: result.state.pending.toString('utf8'),
    resolved: result.state.resolved,
  };
};

const BANNER = 'Welcome to PageSpace\r\nsandbox:~$ ';

describe('planReplayEmission (pure)', () => {
  assert({
    given: 'a replay that is exactly the bytes already forwarded (the idle-watchdog repro)',
    should: 'emit nothing — the client keeps the banner it already has',
    actual: plan({ anchor: BANNER, chunk: BANNER }),
    expected: { emit: '', pending: '', resolved: true },
  });

  assert({
    given: 'a replay of the forwarded bytes followed by genuinely new output in ONE chunk',
    should: 'emit exactly the new tail',
    actual: plan({ anchor: BANNER, chunk: `${BANNER}ls\r\nREADME.md\r\n` }),
    expected: { emit: 'ls\r\nREADME.md\r\n', pending: '', resolved: true },
  });

  assert({
    given: 'a fresh session (nothing forwarded yet, so no anchor)',
    should: 'pass the chunk through unchanged and stop deduping',
    actual: plan({ anchor: '', chunk: BANNER }),
    expected: { emit: BANNER, pending: '', resolved: true },
  });

  assert({
    given: 'an already-resolved state (the replay boundary was found earlier in this attach)',
    should: 'pass live output straight through',
    actual: plan({ anchor: BANNER, chunk: 'live\r\n', resolved: true }),
    expected: { emit: 'live\r\n', pending: '', resolved: true },
  });

  assert({
    given: 'a replay whose first chunk is only PART of the anchor (boundary not yet decidable)',
    should: 'emit nothing and buffer it — emitting now would duplicate the banner',
    actual: plan({ anchor: BANNER, chunk: 'Welcome to PageSpace\r\n' }),
    expected: { emit: '', pending: 'Welcome to PageSpace\r\n', resolved: false },
  });

  assert({
    given: 'the rest of the anchor plus new output, arriving as a SECOND chunk',
    should: 'resolve against the buffered bytes and emit only the new tail',
    actual: plan({ anchor: BANNER, pending: 'Welcome to PageSpace\r\n', chunk: 'sandbox:~$ echo hi\r\n' }),
    expected: { emit: 'echo hi\r\n', pending: '', resolved: true },
  });

  assert({
    given: 'a session whose output the client has never seen (anchor absent from the replay window)',
    should: 'buffer rather than emit — see flushReplay for how that buffer is released',
    actual: plan({ anchor: BANNER, chunk: 'totally different scrollback\r\n' }),
    expected: { emit: '', pending: 'totally different scrollback\r\n', resolved: false },
  });

  it('given more buffered bytes than the scan bound, should give up and emit them UNALIGNED', () => {
    // `aligned: false` is the whole contract of a give-up: it tells the caller these bytes may
    // duplicate history it already holds, so they must RESTART the history rather than extend
    // it. Appending them is what latched the original bug permanently. (The flag happens to be
    // unobservable on THIS producer — an emission this large evicts the history either way —
    // which is exactly why it has to be asserted here rather than through the shell.)
    const anchor = buf(BANNER);
    const chunk = Buffer.alloc(MAX_PENDING_BYTES + 1, 0x61); // no anchor anywhere in it
    const { emit, state, aligned } = planReplayEmission({ seen: anchor, chunk, state: freshReplayState() });

    expect(emit.length).toBe(chunk.length);
    expect(state.resolved).toBe(true);
    expect(aligned).toBe(false);
  });

  // The anchor is matched on BYTES, not JS string indices: a UTF-8 code point is
  // 1-4 bytes, so any length arithmetic done on a decoded string cuts the tail in
  // the wrong place and either duplicates a fragment or eats a real character.
  it('given a multi-byte UTF-8 anchor, should cut the tail on the byte boundary (not the string-length one)', () => {
    const anchor = buf('✓ done → '); // 9 chars, 13 bytes
    const chunk = buf('✓ done → 🚀 next');
    const { emit } = planReplayEmission({ seen: anchor, chunk, state: freshReplayState() });

    expect(emit.toString('utf8')).toBe('🚀 next');
    // Byte-exact: the emitted tail is the chunk's bytes past the anchor's BYTE length.
    expect(emit.equals(chunk.subarray(anchor.length))).toBe(true);
    expect(anchor.length).not.toBe('✓ done → '.length); // the trap this guards
  });
});

/**
 * A match is only the replay's boundary if what sits IN FRONT of it is the
 * stream's own history. These cases are the difference between "we suppress bytes
 * the client has" and "we suppress bytes that merely look like them".
 */
describe('planReplayEmission corroboration (pure)', () => {
  const lines = (prefix: string, n: number) =>
    Buffer.from(Array.from({ length: n }, (_, i) => `${prefix} ${i}\r\n`).join(''), 'utf8');

  const deliver = (...parts: Buffer[]) =>
    materializeSeen(parts.reduce((tail, part) => rememberDelivered(tail, part), EMPTY_SEEN));

  const history = lines('history', 3000);
  const recent = lines('recent', 800);
  const seen = deliver(history, recent);

  it('given a genuine replay (history, then the anchor, then new output), should emit only the new output', () => {
    const replay = Buffer.concat([seen.subarray(1000), buf('brand new line\r\n')]);

    const { emit, state } = planReplayEmission({ seen, chunk: replay, state: freshReplayState() });

    expect(emit.toString('utf8')).toBe('brand new line\r\n');
    expect(state.resolved).toBe(true);
  });

  it('given an UNALIGNABLE replay in which the anchor RECURS in live output, should suppress nothing', () => {
    // The loss path: a repainting TUI reproduces the anchor's bytes verbatim. An
    // unanchored search matches there — PAST the true boundary — and everything in
    // front of it, including output the client has never seen, is dropped. What
    // sits in front of the recurrence is the gap output, not the history that
    // precedes the anchor in the real stream, so the match must be refused.
    const anchor = seen.subarray(seen.length - MAX_ANCHOR_BYTES);
    const neverSeen = lines('output the client never saw', 40);
    const replay = Buffer.concat([neverSeen, anchor, buf('after repaint\r\n')]);

    const { emit, state } = planReplayEmission({ seen, chunk: replay, state: freshReplayState() });

    // Nothing emitted YET (the boundary is genuinely unknown) — but nothing thrown
    // away either: it is all still pending, and flushReplay will release it.
    expect(emit.length).toBe(0);
    expect(state.resolved).toBe(false);
    expect(state.pending.includes(neverSeen)).toBe(true);
  });

  it('given a SHORT history (smaller than the anchor bound) and a recurring match, should still suppress nothing', () => {
    // The same loss, in the shape where there is no history to corroborate WITH:
    // when `seen` is smaller than the anchor bound, the anchor IS the whole of
    // `seen`. A depth-zero "corroboration" would wave every match through — so an
    // unprovable match must be refused, not trusted by default.
    const shortSeen = deliver(buf('$ npm run build\r\nBuilding...\r\n'));
    const neverSeen = buf('ERROR: out of memory\r\n');
    const replay = Buffer.concat([neverSeen, shortSeen, buf('after repaint\r\n')]);

    const { emit, state } = planReplayEmission({ seen: shortSeen, chunk: replay, state: freshReplayState() });

    expect(emit.length).toBe(0);
    expect(state.resolved).toBe(false);
    expect(state.pending.includes(neverSeen)).toBe(true);
  });

  it('given a short history and a replay that STARTS with it, should still dedupe (the common idle case)', () => {
    // The flip side of the case above: a match at offset 0 suppresses nothing but
    // the anchor itself, which matched — so it needs no corroboration, and refusing
    // it would reprint the banner on every watchdog cycle. This is the bug the PR
    // exists to fix, and it must survive the guard that fixes the loss path.
    const shortSeen = deliver(buf('$ npm run build\r\nBuilding...\r\n'));
    const replay = Buffer.concat([shortSeen, buf('done in 3s\r\n')]);

    const { emit, state } = planReplayEmission({ seen: shortSeen, chunk: replay, state: freshReplayState() });

    expect(emit.toString('utf8')).toBe('done in 3s\r\n');
    expect(state.resolved).toBe(true);
  });

  it('given more uncorroborated anchor recurrences than the candidate bound, should give up rather than scan on', () => {
    // The candidate scan is work the SANDBOX chooses: self-similar output can put
    // the anchor at thousands of offsets, each costing a multi-KiB compare, on the
    // shared realtime event loop. The bound is what stops that — and giving up is
    // safe (the bytes go out verbatim), so the observable proof of the bound is that
    // a TRUE match sitting beyond it is NOT found.
    const anchor = seen.subarray(seen.length - MAX_ANCHOR_BYTES);
    const decoy = Buffer.concat([buf('decoy\r\n'), anchor]); // uncorroborated: junk in front
    const decoys = Buffer.concat(Array.from({ length: MAX_MATCH_CANDIDATES + 2 }, () => decoy));
    const genuine = Buffer.concat([seen, buf('the real tail\r\n')]); // would corroborate
    const chunk = Buffer.concat([decoys, genuine]);

    const { emit, state } = planReplayEmission({ seen, chunk, state: freshReplayState() });

    // The bound was hit before the genuine match: nothing suppressed, nothing lost.
    expect(emit.length).toBe(0);
    expect(state.resolved).toBe(false);
    expect(state.pending.length).toBe(chunk.length);
  });
});

/**
 * The search resumes from `scanned` instead of rescanning the whole buffer on every
 * chunk (which was quadratic). What it must never do is skip a GENUINE match.
 */
describe('planReplayEmission corroboration bounds (pure)', () => {
  const lines = (prefix: string, n: number) =>
    Buffer.from(Array.from({ length: n }, (_, i) => `${prefix} ${i}\r\n`).join(''), 'utf8');
  const deliver = (...parts: Buffer[]) =>
    materializeSeen(parts.reduce((tail, part) => rememberDelivered(tail, part), EMPTY_SEEN));
  const seen = deliver(lines('history', 3000), lines('recent', 800));
  const anchor = seen.subarray(seen.length - MAX_ANCHOR_BYTES);

  it('given a SHALLOW but COMPLETE proof, should accept it (a ring barely larger than the anchor)', () => {
    // The `depth === at` acceptance. When the server's ring reaches back only a little past
    // our anchor, a genuine match sits at a small `at` — and every one of those bytes can be
    // proven. Demanding MIN_CORROBORATION_BYTES there would refuse a match we have COMPLETE
    // evidence for, and reprint the scrollback on a terminal that was deduping fine.
    const at = 64; // far below MIN_CORROBORATION_BYTES
    const replay = Buffer.concat([
      seen.subarray(seen.length - MAX_ANCHOR_BYTES - at), // the ring opens `at` bytes early
      buf('brand new\r\n'),
    ]);

    const { emit, state } = planReplayEmission({ seen, chunk: replay, state: freshReplayState() });

    expect(emit.toString('utf8')).toBe('brand new\r\n');
    expect(state.resolved).toBe(true);
  });

  it('given a partial proof SHALLOWER than the floor, should refuse it', () => {
    // The floor binds where `at` runs past the history we hold: the proof can only ever be
    // partial there, so it must at least be deep. A shallow partial proof is no proof.
    const shortSeen = deliver(lines('recent', 700)); // < MAX_ANCHOR_BYTES: the anchor IS the history
    const neverSeen = lines('unseen', 40);
    const replay = Buffer.concat([neverSeen, shortSeen, buf('after\r\n')]);

    const { emit, state } = planReplayEmission({ seen: shortSeen, chunk: replay, state: freshReplayState() });

    expect(emit.length).toBe(0); // refused: held, not suppressed
    expect(state.resolved).toBe(false);
  });

  it('given FEWER recurrences than the bound, should still find the genuine boundary behind them', () => {
    // The bound has to be generous enough to see past a handful of decoys — a repainting TUI
    // can easily reproduce the anchor two or three times. Set it to 1 and a genuine, fully
    // corroborated boundary sitting behind even one recurrence is missed, and the scrollback
    // reprints on a terminal that was deduping fine.
    const decoy = Buffer.concat([buf('decoy\r\n'), anchor]); // uncorroborated: junk in front
    const decoys = Buffer.concat(Array.from({ length: 4 }, () => decoy)); // well under the bound
    const genuine = Buffer.concat([seen, buf('the real tail\r\n')]);

    const { emit, state } = planReplayEmission({
      seen,
      chunk: Buffer.concat([decoys, genuine]),
      state: freshReplayState(),
    });

    expect(emit.toString('utf8')).toBe('the real tail\r\n');
    expect(state.resolved).toBe(true);
  });

  it('given more anchor recurrences than the candidate bound, should stop searching (a suppression lost, never a byte)', () => {
    // MAX_MATCH_CANDIDATES bounds work the SANDBOX chooses on the shared event loop. Past it
    // the search gives up — even on a genuine boundary sitting behind the decoys — and the
    // replay goes out verbatim. That costs a reprint; it can never cost a byte.
    const decoy = Buffer.concat([buf('decoy\r\n'), anchor]); // uncorroborated: junk in front
    const decoys = Buffer.concat(Array.from({ length: MAX_MATCH_CANDIDATES + 1 }, () => decoy));
    const genuine = Buffer.concat([seen, buf('the real tail\r\n')]);

    const { emit, state } = planReplayEmission({
      seen,
      chunk: Buffer.concat([decoys, genuine]),
      state: freshReplayState(),
    });

    expect(emit.length).toBe(0);
    expect(state.resolved).toBe(false); // gave up rather than grind through every decoy
  });
});

describe('planReplayEmission incremental scan (pure)', () => {
  const lines = (prefix: string, n: number) =>
    Buffer.from(Array.from({ length: n }, (_, i) => `${prefix} ${i}\r\n`).join(''), 'utf8');
  const deliver = (...parts: Buffer[]) =>
    materializeSeen(parts.reduce((tail, part) => rememberDelivered(tail, part), EMPTY_SEEN));
  const seen = deliver(lines('history', 3000), lines('recent', 800));

  it('given a genuine replay fed in MANY small chunks, should still find the boundary', () => {
    // The anchor is 8 KiB and the chunks are 512 B, so the match spans ~16 of them: if
    // the resumed scan skipped a start position, the boundary would be missed and the
    // whole scrollback would reprint.
    const replay = Buffer.concat([seen, buf('the new tail\r\n')]);
    let state = freshReplayState();
    const emitted: Buffer[] = [];
    for (let off = 0; off < replay.length; off += 512) {
      const result = planReplayEmission({ seen, chunk: replay.subarray(off, off + 512), state });
      state = result.state;
      emitted.push(result.emit);
    }

    expect(Buffer.concat(emitted).toString('utf8')).toBe('the new tail\r\n');
    expect(state.resolved).toBe(true);
  });

  it('given a buffer longer than the anchor with no match, should not rescan what it already rejected', () => {
    // A match can still BEGIN in the last (anchor - 1) bytes — the next chunk could
    // complete it — so exactly those positions stay in the search region.
    const first = Buffer.alloc(20 * 1024, 0x2e); // no anchor in it
    const { state } = planReplayEmission({ seen, chunk: first, state: freshReplayState() });

    expect(state.resolved).toBe(false);
    expect(state.scanned).toBe(first.length - MAX_ANCHOR_BYTES + 1);
  });
});

describe('empty inputs (pure)', () => {
  assert({
    given: 'an empty delivery (a chunk that carried no bytes)',
    should: 'leave the history untouched',
    actual: (() => {
      const before = rememberDelivered(EMPTY_SEEN, buf('output'));
      const after = rememberDelivered(before, Buffer.alloc(0));
      return { same: after === before, text: materializeSeen(after).toString('utf8') };
    })(),
    expected: { same: true, text: 'output' },
  });

  assert({
    given: 'an empty chunk on a resolved window',
    should: 'emit nothing and stay resolved',
    actual: plan({ anchor: BANNER, chunk: '', resolved: true }),
    expected: { emit: '', pending: '', resolved: true },
  });

  assert({
    given: 'an empty chunk while bytes are being held',
    should: 'keep holding them, unchanged',
    actual: plan({ anchor: BANNER, pending: 'half a replay', chunk: '' }),
    expected: { emit: '', pending: 'half a replay', resolved: false },
  });
});

describe('flushReplay (pure)', () => {
  assert({
    given: 'buffered bytes the search could never align',
    should: 'emit them all, UNALIGNED — never hold output hostage, and never extend the history with it',
    actual: (() => {
      const { emit, state, aligned } = flushReplay({ pending: buf('unaligned output\r\n'), scanned: 0, resolved: false });
      return { emit: emit.toString('utf8'), resolved: state.resolved, aligned };
    })(),
    expected: { emit: 'unaligned output\r\n', resolved: true, aligned: false },
  });

  assert({
    given: 'an already-resolved state',
    should: 'emit nothing',
    actual: (() => {
      const { emit } = flushReplay({ pending: Buffer.alloc(0), scanned: 0, resolved: true });
      return emit.toString('utf8');
    })(),
    expected: '',
  });

  it('given output that REPEATS what the client last saw, should emit it rather than mistake it for a replay', () => {
    // A heartbeat line, a progress bar, a `watch` loop: the new bytes are identical
    // to the tail of what we forwarded. Trimming a matching head off the flush
    // would delete a line the client never saw — indistinguishable, from content
    // alone, from the replay it looks like. Duplication is survivable; this is not.
    const heartbeat = '########## build heartbeat ##########\r\n';
    const { emit } = flushReplay({ pending: buf(heartbeat), scanned: 0, resolved: false });

    expect(emit.toString('utf8')).toBe(heartbeat);
  });
});

describe('rememberDelivered (pure)', () => {
  assert({
    given: 'bytes delivered to the client',
    should: 'append them to the retained history',
    actual: materializeSeen(rememberDelivered(rememberDelivered(EMPTY_SEEN, buf('abc')), buf('def'))).toString('utf8'),
    expected: 'abcdef',
  });

  assert({
    given: 'a fresh session (the history is reset to empty)',
    should: 'start the history from the new output',
    actual: materializeSeen(rememberDelivered(EMPTY_SEEN, buf('new shell\r\n'))).toString('utf8'),
    expected: 'new shell\r\n',
  });

  it('given more forwarded bytes than the retention bound, should keep only the most recent ones (bounded memory)', () => {
    let tail = rememberDelivered(EMPTY_SEEN, Buffer.alloc(MAX_SEEN_BYTES, 0x61));
    tail = rememberDelivered(tail, buf('END'));
    const seen = materializeSeen(tail);

    expect(tail.bytes).toBe(MAX_SEEN_BYTES);
    expect(seen.subarray(seen.length - 3).toString('utf8')).toBe('END');
  });

  it('given a single chunk BIGGER than the bound, then a small one, should keep a full history (not collapse to the prompt)', () => {
    // The trim must never take the history BELOW the bound. Evicting whole chunks
    // and stopping once the total fits does exactly that: the oversized chunk evicts
    // everything, and the next byte evicts IT — leaving a 3-byte history. The anchor
    // collapses with it, no replay can align again, and the banner reprints on every
    // watchdog cycle. This module produces oversized chunks itself: the give-up flush
    // emits one buffer of up to MAX_PENDING_BYTES, and a cold attach can deliver a
    // whole scrollback in a single frame.
    const hugeFlush = Buffer.alloc(100 * 1024, 0x61); // > MAX_SEEN_BYTES, as a flush emits
    let tail = rememberDelivered(EMPTY_SEEN, hugeFlush);
    tail = rememberDelivered(tail, buf('$ ')); // ...then an ordinary prompt

    expect(tail.bytes).toBe(MAX_SEEN_BYTES); // NOT 2
    expect(materializeSeen(tail).length).toBe(MAX_SEEN_BYTES);
  });

  it('given a keystroke-sized delivery, should coalesce rather than mint a block per byte', () => {
    // Both naive designs lose here. One growing 64 KiB buffer re-copies all of it per
    // delivered chunk. A block per chunk is WORSE for an interactive shell — a
    // keystroke echo is one byte, so the block count runs to tens of thousands and
    // every append walks it. Small deliveries coalesce into the tail block, so the
    // count stays in the low tens whatever the shell does, and both regimes are cheap.
    let tail = EMPTY_SEEN;
    for (let i = 0; i < 80_000; i += 1) tail = rememberDelivered(tail, buf('x')); // past the bound

    expect(tail.bytes).toBe(MAX_SEEN_BYTES);
    expect(tail.chunks.length).toBeLessThanOrEqual(MAX_SEEN_BYTES / 4096 + 2);
    expect(materializeSeen(tail).length).toBe(MAX_SEEN_BYTES);
  });

  it('given large deliveries, should keep them as separate blocks (no needless re-copy)', () => {
    let tail = EMPTY_SEEN;
    for (let i = 0; i < 8; i += 1) tail = rememberDelivered(tail, Buffer.alloc(8 * 1024, 0x61));

    expect(tail.bytes).toBe(MAX_SEEN_BYTES);
    expect(tail.chunks.length).toBe(8); // untouched, not merged
  });
});
