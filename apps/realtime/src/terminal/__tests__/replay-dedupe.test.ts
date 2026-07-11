import { describe, it, expect } from 'vitest';
import {
  MAX_ANCHOR_BYTES,
  MAX_PENDING_BYTES,
  flushReplay,
  freshReplayState,
  planReplayEmission,
  trackForwarded,
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
    anchor: buf(args.anchor),
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
    const { emit, state } = planReplayEmission({ anchor, chunk, state: freshReplayState() });

    expect(emit.length).toBe(chunk.length);
    expect(state.resolved).toBe(true);
  });

  // The anchor is matched on BYTES, not JS string indices: a UTF-8 code point is
  // 1-4 bytes, so any length arithmetic done on a decoded string cuts the tail in
  // the wrong place and either duplicates a fragment or eats a real character.
  it('given a multi-byte UTF-8 anchor, should cut the tail on the byte boundary (not the string-length one)', () => {
    const anchor = buf('✓ done → '); // 9 chars, 13 bytes
    const chunk = buf('✓ done → 🚀 next');
    const { emit } = planReplayEmission({ anchor, chunk, state: freshReplayState() });

    expect(emit.toString('utf8')).toBe('🚀 next');
    // Byte-exact: the emitted tail is the chunk's bytes past the anchor's BYTE length.
    expect(emit.equals(chunk.subarray(anchor.length))).toBe(true);
    expect(anchor.length).not.toBe('✓ done → '.length); // the trap this guards
  });
});

describe('flushReplay (pure)', () => {
  assert({
    given: 'buffered bytes whose replay boundary was never found (the replay ended without the anchor)',
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
});

describe('trackForwarded (pure)', () => {
  assert({
    given: 'bytes delivered to the client',
    should: 'append them to the anchor tail',
    actual: trackForwarded(buf('abc'), buf('def')).toString('utf8'),
    expected: 'abcdef',
  });

  assert({
    given: 'a fresh session (the anchor is reset to empty)',
    should: 'start the tail from the new output',
    actual: trackForwarded(Buffer.alloc(0), buf('new shell\r\n')).toString('utf8'),
    expected: 'new shell\r\n',
  });

  it('given more forwarded bytes than the anchor bound, should keep only the most recent ones (bounded memory)', () => {
    const tail = trackForwarded(Buffer.alloc(MAX_ANCHOR_BYTES, 0x61), buf('END'));

    expect(tail.length).toBe(MAX_ANCHOR_BYTES);
    expect(tail.subarray(tail.length - 3).toString('utf8')).toBe('END');
  });
});
