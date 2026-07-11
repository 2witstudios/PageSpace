import { describe, it, expect } from 'vitest';
import {
  EMPTY_SEEN,
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
const plan = (args: { anchor: string; chunk: string; pending?: string; resolved?: boolean }) => {
  const result = planReplayEmission({
    seen: buf(args.anchor),
    chunk: buf(args.chunk),
    state: { pending: buf(args.pending ?? ''), resolved: args.resolved ?? false },
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

  it('given more buffered bytes than the scan bound, should give up and emit them (duplication is survivable; losing output is not)', () => {
    const anchor = buf(BANNER);
    const chunk = Buffer.alloc(MAX_PENDING_BYTES + 1, 0x61); // no anchor anywhere in it
    const { emit, state } = planReplayEmission({ seen: anchor, chunk, state: freshReplayState() });

    expect(emit.length).toBe(chunk.length);
    expect(state.resolved).toBe(true);
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
    const anchor = seen.subarray(seen.length - 8 * 1024);
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

  it('given self-similar output that puts the anchor at thousands of offsets, should give up rather than scan them all', () => {
    // The sandbox chooses these bytes and this runs on the shared realtime event
    // loop, so an unbounded candidate scan — each candidate costing a multi-KiB
    // compare — is a DoS surface. Every match here is uncorroborated (the padding
    // is not preceded by our history), so the search must bail, not grind.
    const padded = deliver(lines('history', 1000), Buffer.alloc(16 * 1024, 0x20));
    const chunk = Buffer.concat([buf('unseen output\r\n'), Buffer.alloc(200 * 1024, 0x20)]);

    const start = process.hrtime.bigint();
    const { emit, state } = planReplayEmission({ seen: padded, chunk, state: freshReplayState() });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(emit.length).toBe(0);
    expect(state.resolved).toBe(false); // unprovable → held, then flushed verbatim
    expect(elapsedMs).toBeLessThan(250);
  });
});

describe('flushReplay (pure)', () => {
  assert({
    given: 'buffered bytes the search could never align',
    should: 'emit them all — never hold real output hostage',
    actual: (() => {
      const { emit, state } = flushReplay({ pending: buf('unaligned output\r\n'), resolved: false });
      return { emit: emit.toString('utf8'), resolved: state.resolved };
    })(),
    expected: { emit: 'unaligned output\r\n', resolved: true },
  });

  assert({
    given: 'an already-resolved state',
    should: 'emit nothing',
    actual: (() => {
      const { emit } = flushReplay({ pending: Buffer.alloc(0), resolved: true });
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
    const { emit } = flushReplay({ pending: buf(heartbeat), resolved: false });

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

    expect(tail.bytes).toBeLessThanOrEqual(MAX_SEEN_BYTES + 3);
    expect(seen.subarray(seen.length - 3).toString('utf8')).toBe('END');
  });

  it('given many small chunks, should not re-copy the whole history for each one', () => {
    // A 64 KiB memcpy per delivered chunk is a real cost for a shell that writes in
    // small bursts: the history is kept as chunks and joined once per attach.
    let tail = EMPTY_SEEN;
    const start = process.hrtime.bigint();
    for (let i = 0; i < 20_000; i += 1) tail = rememberDelivered(tail, buf('x'.repeat(100)));
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(tail.bytes).toBeLessThanOrEqual(MAX_SEEN_BYTES + 100);
    expect(elapsedMs).toBeLessThan(500);
  });
});
