import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const consumeStreamJoin = vi.fn();
const startStreamJoinPollFallback = vi.fn();

vi.mock('@/lib/ai/core/stream-join-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai/core/stream-join-client')>(
    '@/lib/ai/core/stream-join-client',
  );
  return {
    ...actual,
    consumeStreamJoin: (...args: unknown[]) => consumeStreamJoin(...args),
  };
});

vi.mock('@/lib/ai/core/stream-join-poll-fallback', () => ({
  startStreamJoinPollFallback: (...args: unknown[]) => startStreamJoinPollFallback(...args),
}));

import { StreamJoinError } from '@/lib/ai/core/stream-join-client';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import {
  openStreamSession,
  completeStreamSession,
  closeChannelSessions,
  reconcileChannelSessions,
  onStreamSessionEnd,
  resetStreamSessionRegistry,
  type StreamSessionEnd,
} from '../streamSessionRegistry';

const descriptor = (overrides: Partial<Parameters<typeof openStreamSession>[0]> = {}) => ({
  messageId: 'msg-1',
  conversationId: 'conv-1',
  channelId: 'page-1',
  triggeredBy: { userId: 'user-1', displayName: 'Ada' },
  isOwn: true,
  startedAt: new Date().toISOString(),
  ...overrides,
});

/** Let the join promise's continuation run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

const store = () => usePendingStreamsStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  resetStreamSessionRegistry();
  usePendingStreamsStore.setState({ streams: new Map() });
  // Default: a join that never resolves, i.e. a stream still generating.
  consumeStreamJoin.mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  resetStreamSessionRegistry();
  vi.useRealTimers();
});

describe('openStreamSession', () => {
  it('opens the store entry BEFORE the join, so the bubble exists for the whole TTFB window', () => {
    openStreamSession(descriptor());

    const entry = store().streams.get('msg-1');
    expect(entry).toBeDefined();
    expect(entry!.conversationId).toBe('conv-1');
    expect(entry!.pageId).toBe('page-1');
    expect(entry!.isOwn).toBe(true);
  });

  it('is idempotent per messageId — one subscription however many announcers arrive', () => {
    // A send's admission envelope, a `chat:stream_start`, and an `/active-streams` bootstrap row
    // can all name the same generation. Two joins would render every token twice — the exact
    // double-render `consumingChannels` used to prevent with bookkeeping.
    openStreamSession(descriptor());
    openStreamSession(descriptor());
    openStreamSession(descriptor());

    expect(consumeStreamJoin).toHaveBeenCalledTimes(1);
  });

  it('seeds a persisted snapshot verbatim so a rejoining client is not blank', () => {
    const seedParts = [{ type: 'text' as const, text: 'restored' }];
    openStreamSession(descriptor({ seedParts }));

    expect(store().streams.get('msg-1')!.parts).toEqual(seedParts);
  });

  it('writes folded parts with a monotonic seq as the join delivers them', async () => {
    let deliver: ((parts: unknown[], seq: number) => void) | undefined;
    consumeStreamJoin.mockImplementation(
      (_id: string, _signal: AbortSignal, onParts: (p: unknown[], s: number) => void) => {
        deliver = onParts;
        return new Promise(() => {});
      },
    );

    openStreamSession(descriptor());
    deliver!([{ type: 'text', text: 'hel' }], 0);
    deliver!([{ type: 'text', text: 'hello' }], 1);

    expect(store().streams.get('msg-1')!.parts).toEqual([{ type: 'text', text: 'hello' }]);
  });
});

describe('a surface unmounting must not touch the stream', () => {
  it('keeps the store entry and the subscription alive when no component is watching', async () => {
    // "Send a message and leave." There is no `release()` at all — a component unmounting is not
    // evidence about whether a generation is still running, and the registry deliberately offers
    // no way for a mount count to close a session.
    openStreamSession(descriptor());
    const registry = await import('../streamSessionRegistry');

    expect(Object.keys(registry)).not.toContain('release');
    expect(Object.keys(registry)).not.toContain('releaseStreamSession');
    expect(store().streams.has('msg-1')).toBe(true);
  });
});

describe('resumeFromSeq is a RESEED, never a completion', () => {
  it('does not report a completion, and does not drop the entry, when the cursor ages out', async () => {
    // This bug already shipped once: reporting `resumeFromSeq` as a finished stream fired the
    // completion path, dropped the store entry, and the user watched the reply vanish while the
    // server was still generating.
    consumeStreamJoin.mockResolvedValue({ aborted: false, resumeFromSeq: 42 });
    startStreamJoinPollFallback.mockImplementation(() => {});
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));

    openStreamSession(descriptor());
    await settle();

    expect(ends, 'a reseed is not an end').toEqual([]);
    expect(store().streams.has('msg-1'), 'the bubble must stay on screen').toBe(true);
    // It falls back to the DB checkpoint for a near-live view rather than re-joining from the
    // resume point: the frames before it are gone, and a fold starting mid-stream renders a
    // reply missing its beginning.
    expect(startStreamJoinPollFallback).toHaveBeenCalled();
  });
});

describe('endings', () => {
  it('notifies listeners while the store entry is STILL PRESENT', async () => {
    // The ordering is the whole point. Consumers commit the finished reply from the entry they
    // are being told about (`getActiveStreamById` -> `synthesizeAssistantMessage`). Drop it
    // first and every completion falls through to a reload-from-DB, so the finished reply
    // blinks out and comes back with a loading flip on every single turn.
    consumeStreamJoin.mockResolvedValue({ aborted: false });
    const seen: boolean[] = [];
    onStreamSessionEnd((end) => {
      seen.push(store().streams.has(end.messageId));
    });

    openStreamSession(descriptor());
    await settle();

    expect(seen).toEqual([true]);
    expect(store().streams.has('msg-1'), 'and dropped immediately after').toBe(false);
  });

  it('carries the channelId so a per-channel listener can tell its own endings apart', async () => {
    consumeStreamJoin.mockResolvedValue({ aborted: false });
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));

    openStreamSession(descriptor());
    await settle();

    expect(ends[0]?.channelId).toBe('page-1');
    expect(ends[0]?.joinFailed).toBe(false);
  });

  it('given a completion for a stream we never watched, reports joinFailed so the consumer reloads', () => {
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));

    completeStreamSession({
      messageId: 'msg-elsewhere',
      conversationId: 'conv-9',
      channelId: 'page-1',
      aborted: false,
    });

    // We certainly hold no authoritative copy of a stream we never read.
    expect(ends[0]?.joinFailed).toBe(true);
  });

  it('prefers the SESSION\'s conversationId over the wire\'s, which is optional', async () => {
    consumeStreamJoin.mockReturnValue(new Promise(() => {}));
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));
    openStreamSession(descriptor());

    // An originator on the previous build emits `chat:stream_complete` without it.
    completeStreamSession({ messageId: 'msg-1', channelId: 'page-1', aborted: true });

    expect(ends[0]?.conversationId).toBe('conv-1');
    expect(ends[0]?.aborted).toBe(true);
  });

  it('given a join that failed with a 404, polls rather than declaring the stream over', async () => {
    // The benign cross-instance case: the stream lives on another web instance whose in-process
    // channel registry this one cannot reach. The generation is fine; we just cannot watch it.
    consumeStreamJoin.mockRejectedValue(new StreamJoinError('nope', 404));
    startStreamJoinPollFallback.mockImplementation(() => {});
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));

    openStreamSession(descriptor());
    await settle();

    expect(startStreamJoinPollFallback).toHaveBeenCalled();
    expect(ends).toEqual([]);
  });

  it('given a join denied 403, does NOT poll — a denial is not a liveness gap', async () => {
    // Polling through a denial would re-request it every second for the length of the run.
    consumeStreamJoin.mockRejectedValue(new StreamJoinError('forbidden', 403));
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));

    openStreamSession(descriptor());
    await settle();

    expect(startStreamJoinPollFallback).not.toHaveBeenCalled();
    expect(ends[0]?.joinFailed).toBe(true);
  });

  it('given a POLLABLE failure over a SEEDED snapshot, keeps the snapshot rendered', async () => {
    // The snapshot is the only surviving copy of the partial reply while polling catches up
    // (the originator's process died, so its channel 404s). Removing it here would undo the
    // restore that just happened — and unlike the non-pollable case below, something IS
    // coming, so the entry is not stranded.
    consumeStreamJoin.mockRejectedValue(new StreamJoinError('cross-instance', 404));
    startStreamJoinPollFallback.mockImplementation(() => {});

    openStreamSession(descriptor({ seedParts: [{ type: 'text', text: 'partial' }] }));
    await settle();

    expect(startStreamJoinPollFallback).toHaveBeenCalled();
    expect(store().streams.get('msg-1')?.parts).toEqual([{ type: 'text', text: 'partial' }]);
  });
});

describe('reconcile and revoke', () => {
  it('drops a session the server no longer reports as live, and tells consumers to reload', () => {
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));
    openStreamSession(descriptor());

    reconcileChannelSessions('page-1', new Set());

    expect(store().streams.has('msg-1')).toBe(false);
    expect(ends[0]?.joinFailed).toBe(true);
  });

  it('leaves a session the server still reports as live alone', () => {
    openStreamSession(descriptor());
    reconcileChannelSessions('page-1', new Set(['msg-1']));
    expect(store().streams.has('msg-1')).toBe(true);
  });

  it('given access revoked, tears down WITHOUT reporting completions', () => {
    // Nothing finished. Telling consumers otherwise would have them reload messages the user is
    // no longer permitted to read.
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));
    openStreamSession(descriptor());

    closeChannelSessions('page-1');

    expect(store().streams.has('msg-1')).toBe(false);
    expect(ends).toEqual([]);
  });

  it('only touches the named channel', () => {
    openStreamSession(descriptor());
    openStreamSession(descriptor({ messageId: 'msg-2', channelId: 'page-2' }));

    closeChannelSessions('page-1');

    expect(store().streams.has('msg-1')).toBe(false);
    expect(store().streams.has('msg-2')).toBe(true);
  });
});

describe('the expiry sweep — the failure mode this design introduces', () => {
  it('drops an entry older than the stream horizon, so a lost event cannot suppress SWR forever', async () => {
    // `deriveStreamingRegistrations` derives the editing-store streaming registration from this
    // store, and that registration suppresses SWR revalidation AND auth-token refresh APP-WIDE.
    // Under the old mount-scoped design a stranded entry self-healed on the next unmount; under
    // this one it would freeze data refresh across the whole app for the rest of the session.
    vi.useFakeTimers();
    const { STREAM_MAX_LIFETIME_MS } = await import('@/lib/ai/core/stream-horizons');

    openStreamSession(
      descriptor({ startedAt: new Date(Date.now() - STREAM_MAX_LIFETIME_MS - 1000).toISOString() }),
    );
    expect(store().streams.has('msg-1')).toBe(true);

    await vi.advanceTimersByTimeAsync(61_000);

    expect(store().streams.has('msg-1')).toBe(false);
  });

  it('does NOT expire an entry inside the horizon', async () => {
    vi.useFakeTimers();
    openStreamSession(descriptor({ startedAt: new Date().toISOString() }));

    await vi.advanceTimersByTimeAsync(61_000);

    expect(store().streams.has('msg-1')).toBe(true);
  });

  it('expires WITHOUT firing the end listeners — it is not a completion', async () => {
    // It does not know whether the stream completed; that is the point, it is here precisely
    // because nobody told us. Reporting a completion would badge an unknown outcome as finished.
    vi.useFakeTimers();
    const { STREAM_MAX_LIFETIME_MS } = await import('@/lib/ai/core/stream-horizons');
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));

    openStreamSession(
      descriptor({ startedAt: new Date(Date.now() - STREAM_MAX_LIFETIME_MS - 1000).toISOString() }),
    );
    await vi.advanceTimersByTimeAsync(61_000);

    expect(ends).toEqual([]);
  });

  it('given an unparseable startedAt, still ages out rather than becoming immortal', async () => {
    vi.useFakeTimers();
    const { STREAM_MAX_LIFETIME_MS } = await import('@/lib/ai/core/stream-horizons');

    openStreamSession(descriptor({ startedAt: 'not-a-date' }));
    // Treated as "starting now", so it gets a full horizon — and is then swept like any other.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(store().streams.has('msg-1')).toBe(true);

    await vi.advanceTimersByTimeAsync(STREAM_MAX_LIFETIME_MS + 61_000);
    expect(store().streams.has('msg-1')).toBe(false);
  });
});

describe('the poll fallback — the near-live view when the channel cannot serve us', () => {
  /** Grab the two callbacks `startStreamJoinPollFallback` was handed. */
  const pollCallbacks = (call = 0) => {
    const args = startStreamJoinPollFallback.mock.calls[call];
    return { onParts: args[3] as (p: unknown[]) => void, onGone: args[4] as () => void };
  };

  beforeEach(() => {
    consumeStreamJoin.mockRejectedValue(new StreamJoinError('cross-instance', 404));
    startStreamJoinPollFallback.mockImplementation(() => {});
  });

  it('writes polled parts with a seq that keeps rising', async () => {
    openStreamSession(descriptor());
    await settle();

    const { onParts } = pollCallbacks();
    onParts([{ type: 'text', text: 'first' }]);
    onParts([{ type: 'text', text: 'second' }]);

    // `applySetStreamParts` drops any write whose seq is not strictly greater than the stored
    // one, so a counter that stalled would silently swallow the second write.
    expect(store().streams.get('msg-1')!.parts).toEqual([{ type: 'text', text: 'second' }]);
  });

  it('given the row vanishes from /active-streams, ends the session and tells consumers to reload', async () => {
    // That broadcast is best-effort, so when `chat:stream_complete` never arrives this poll
    // noticing the row disappear is the ONLY remaining signal. Without an end notification the
    // synthesized bubble would vanish with nothing replacing it — strictly worse than the
    // frozen-but-visible snapshot that preceded the fallback.
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));
    openStreamSession(descriptor());
    await settle();

    pollCallbacks().onGone();

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ messageId: 'msg-1', conversationId: 'conv-1', channelId: 'page-1', joinFailed: true });
    expect(store().streams.has('msg-1')).toBe(false);
  });
});

describe('the seq watermark is shared by BOTH writers', () => {
  it('given the join delivered frames and THEN hands over to the poll fallback, the first poll write still lands', async () => {
    // coderabbitai on PR #2410. The poll counter used to start at 0 while the live join had
    // already pushed the store watermark to N — so the fallback emitted 1, 2, 3…, every one
    // was dropped by `applySetStreamParts`, and the bubble sat frozen on the last live frame
    // until the poll count climbed past N.
    let deliver!: (parts: unknown[], seq: number) => void;
    let resolveJoin!: (r: { aborted: boolean; resumeFromSeq?: number }) => void;
    consumeStreamJoin.mockImplementation(
      (_id: string, _sig: AbortSignal, onParts: (p: unknown[], s: number) => void) => {
        deliver = onParts;
        return new Promise((res) => { resolveJoin = res; });
      },
    );
    startStreamJoinPollFallback.mockImplementation(() => {});

    openStreamSession(descriptor());
    // The live join lands several frames first.
    deliver([{ type: 'text', text: 'live 1' }], 40);
    deliver([{ type: 'text', text: 'live 2' }], 41);
    const liveSeq = store().streams.get('msg-1')!.lastSeq!;
    expect(liveSeq).toBe(42);

    // Then the cursor ages out and the fallback takes over.
    resolveJoin({ aborted: false, resumeFromSeq: 99 });
    await settle();

    const onParts = startStreamJoinPollFallback.mock.calls[0][3] as (p: unknown[]) => void;
    onParts([{ type: 'text', text: 'polled' }]);

    expect(
      store().streams.get('msg-1')!.parts,
      'the first polled write must not be swallowed under the live watermark',
    ).toEqual([{ type: 'text', text: 'polled' }]);
    expect(store().streams.get('msg-1')!.lastSeq).toBeGreaterThan(liveSeq);
  });
});

describe('a join failure that cannot be polled must still END the session', () => {
  it('given a 500 AFTER frames were delivered, ends it rather than stranding the entry', async () => {
    // coderabbitai on PR #2410. This used to end only when nothing had been seeded or
    // delivered, on the theory that a partial bubble was worth preserving. But a session that
    // never ends is a store entry that never ends, and `deriveStreamingRegistrations` turns
    // those into an editing-store registration that suppresses SWR revalidation AND auth-token
    // refresh APP-WIDE — so one truncated bubble froze data refresh across the whole app until
    // the hour-long sweep, which drops it WITHOUT notifying anyone.
    let deliver!: (parts: unknown[], seq: number) => void;
    let rejectJoin!: (e: unknown) => void;
    consumeStreamJoin.mockImplementation(
      (_id: string, _sig: AbortSignal, onParts: (p: unknown[], s: number) => void) => {
        deliver = onParts;
        return new Promise((_res, rej) => { rejectJoin = rej; });
      },
    );
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    openStreamSession(descriptor());
    deliver([{ type: 'text', text: 'partial' }], 0);
    rejectJoin(new StreamJoinError('server error', 500));
    await settle();

    expect(startStreamJoinPollFallback, 'a 500 is not a liveness gap').not.toHaveBeenCalled();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ messageId: 'msg-1', joinFailed: true });
    expect(
      store().streams.has('msg-1'),
      'the entry must go, or it suppresses SWR app-wide forever',
    ).toBe(false);
    errorSpy.mockRestore();
  });

  it('REPORTS the failure — the log used to sit after the teardown, where it was unreachable', async () => {
    // `endSession` aborts the session's controller, so an `if (!controller.signal.aborted)`
    // guard placed after it can never be true. The error was silently swallowed on exactly the
    // path where a developer most needs to see it.
    consumeStreamJoin.mockRejectedValue(new StreamJoinError('server error', 500));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    openStreamSession(descriptor());
    await settle();

    expect(errorSpy).toHaveBeenCalledWith(
      '[streamSessionRegistry] stream join error',
      expect.any(StreamJoinError),
    );
    errorSpy.mockRestore();
  });

  it('given a 403 over a SEEDED snapshot, still ends it', async () => {
    // Same reasoning: the seeded snapshot is not worth an app-wide refresh freeze, and
    // `joinFailed: true` tells consumers to reload the durably-persisted message anyway.
    consumeStreamJoin.mockRejectedValue(new StreamJoinError('forbidden', 403));
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    openStreamSession(descriptor({ seedParts: [{ type: 'text', text: 'restored' }] }));
    await settle();

    expect(ends).toHaveLength(1);
    expect(ends[0]?.joinFailed).toBe(true);
    expect(store().streams.has('msg-1')).toBe(false);
    errorSpy.mockRestore();
  });
});

describe('late continuations after the session is already gone', () => {
  it('given the join RESOLVES after a teardown, does nothing', async () => {
    // A `chat:stream_complete` can land while the join promise is still settling. The session
    // is gone by then, and re-notifying would fire a second completion for one stream.
    let resolveJoin!: (r: { aborted: boolean }) => void;
    consumeStreamJoin.mockImplementation(() => new Promise((res) => { resolveJoin = res; }));
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));

    openStreamSession(descriptor());
    closeChannelSessions('page-1');
    resolveJoin({ aborted: false });
    await settle();

    expect(ends, 'a revocation is not a completion, and the late resolve must not invent one').toEqual([]);
  });

  it('given the join REJECTS after a teardown, does nothing', async () => {
    let rejectJoin!: (e: unknown) => void;
    consumeStreamJoin.mockImplementation(() => new Promise((_res, rej) => { rejectJoin = rej; }));
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));

    openStreamSession(descriptor());
    closeChannelSessions('page-1');
    rejectJoin(new StreamJoinError('gone', 404));
    await settle();

    expect(ends).toEqual([]);
    expect(startStreamJoinPollFallback, 'nothing left to poll for').not.toHaveBeenCalled();
  });
});

describe('a snapshot cannot speak about what started after it', () => {
  it('given a session opened DURING the bootstrap round trip, reconcile leaves it alone', async () => {
    // Review finding. `/active-streams` answers about the world as it was when the query ran.
    // A send landing mid-round-trip was reported as already-finished by the answer to a
    // question asked before it started: join aborted, entry dropped, reply dead mid-generation.
    // `bootstrapGeneration` does not cover this — it orders bootstrap responses against each
    // other, not against sessions opened in between.
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));

    const snapshotTakenAt = Date.now();
    // The user sends AFTER the query was issued.
    await new Promise((r) => setTimeout(r, 2));
    openStreamSession(descriptor({ messageId: 'msg-late' }));

    // ...and the stale snapshot (which of course does not list it) comes back.
    reconcileChannelSessions('page-1', new Set(), { snapshotTakenAt });

    expect(store().streams.has('msg-late'), 'the snapshot predates it').toBe(true);
    expect(ends).toEqual([]);
  });

  it('given a session opened BEFORE the snapshot and absent from it, still reconciles it away', async () => {
    // The guard must bound reconciliation, not disable it.
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));

    openStreamSession(descriptor({ messageId: 'msg-early' }));
    await new Promise((r) => setTimeout(r, 2));
    const snapshotTakenAt = Date.now();

    reconcileChannelSessions('page-1', new Set(), { snapshotTakenAt });

    expect(store().streams.has('msg-early')).toBe(false);
    expect(ends.map((e) => e.messageId)).toEqual(['msg-early']);
  });
});

describe('a stale join continuation must not end a RE-OPENED session', () => {
  it('given the messageId was torn down and re-opened, the old continuation is ignored', async () => {
    // Review finding. `consumeStreamJoin` RESOLVES on abort rather than rejecting, so an old
    // continuation still settles after a teardown. Guarding on `sessions.has(messageId)` — key
    // presence — let it end the NEW session for the same id: fresh join aborted, entry dropped,
    // and consumers told the stream COMPLETED with an authoritative copy that was just deleted.
    // The guard is now on session IDENTITY.
    const resolvers: ((r: { aborted: boolean }) => void)[] = [];
    consumeStreamJoin.mockImplementation(
      () => new Promise((res) => { resolvers.push(res as (r: { aborted: boolean }) => void); }),
    );
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));

    openStreamSession(descriptor());          // session #1
    closeChannelSessions('page-1');           // torn down; #1's promise still pending
    openStreamSession(descriptor());          // session #2, SAME messageId
    expect(consumeStreamJoin).toHaveBeenCalledTimes(2);

    // #1's continuation finally settles.
    resolvers[0]({ aborted: false });
    await settle();

    expect(ends, 'the stale continuation must not report a completion').toEqual([]);
    expect(store().streams.has('msg-1'), 'session #2 is untouched').toBe(true);
  });

  it('given the same for a REJECTED continuation, it is also ignored', async () => {
    const rejecters: ((e: unknown) => void)[] = [];
    consumeStreamJoin.mockImplementation(
      () => new Promise((_res, rej) => { rejecters.push(rej); }),
    );
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));

    openStreamSession(descriptor());
    closeChannelSessions('page-1');
    openStreamSession(descriptor());

    rejecters[0](new StreamJoinError('stale', 500));
    await settle();

    expect(ends).toEqual([]);
    expect(store().streams.has('msg-1')).toBe(true);
  });
});

describe('listener hygiene', () => {
  it('given one listener throws, still delivers to the others', async () => {
    // A consumer throwing must never strand the others, or the session's own teardown.
    consumeStreamJoin.mockResolvedValue({ aborted: false });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const delivered: string[] = [];
    onStreamSessionEnd(() => { throw new Error('consumer blew up'); });
    onStreamSessionEnd((end) => delivered.push(end.messageId));

    openStreamSession(descriptor());
    await settle();

    expect(delivered).toEqual(['msg-1']);
    expect(errorSpy).toHaveBeenCalled();
    // And the teardown itself still completed.
    expect(store().streams.has('msg-1')).toBe(false);
    errorSpy.mockRestore();
  });

  it('unsubscribing actually stops delivery', async () => {
    consumeStreamJoin.mockResolvedValue({ aborted: false });
    const ends: StreamSessionEnd[] = [];
    const unsubscribe = onStreamSessionEnd((end) => ends.push(end));
    unsubscribe();

    openStreamSession(descriptor());
    await settle();

    expect(ends).toEqual([]);
  });
});

describe('completeStreamSession — the old-build wire shape', () => {
  it('given NO conversationId and no session to supply one, stays silent', async () => {
    // An old-build completion for a stream this tab never watched. There is no conversation to
    // name, so a consumer could not act on it — and inventing an empty id would send every
    // conversation-keyed listener looking for a row under `''`.
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));

    completeStreamSession({ messageId: 'msg-unknown', channelId: 'page-1' });

    expect(ends).toEqual([]);
  });
});

describe('reconcileChannelSessions — scoped to the question that was asked', () => {
  it('given a CONVERSATION-SCOPED snapshot, leaves sibling conversations on the same channel alone', async () => {
    // codex P1 on PR #2410. `/active-streams` accepts a conversationId narrowing, and every
    // agent-pane subscription sends one — so a scoped response lists ONE conversation's
    // streams. Reconciling channel-wide against it read every sibling as finished: two
    // conversations generating under one agent, and merely mounting conversation A tore down
    // conversation B mid-generation.
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));
    openStreamSession(descriptor({ messageId: 'msg-A', conversationId: 'conv-A' }));
    openStreamSession(descriptor({ messageId: 'msg-B', conversationId: 'conv-B' }));

    // Conversation A's pane bootstraps: the server answers with A's stream only.
    reconcileChannelSessions('page-1', new Set(['msg-A']), { conversationId: 'conv-A' });

    expect(store().streams.has('msg-A'), 'A is live and listed').toBe(true);
    expect(
      store().streams.has('msg-B'),
      'B was never asked about, so its absence proves nothing about it',
    ).toBe(true);
    expect(ends).toEqual([]);
  });

  it('given a scoped snapshot, still drops a stale session WITHIN that conversation', () => {
    // The narrowing must not disable reconciliation, only bound it.
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));
    openStreamSession(descriptor({ messageId: 'msg-A', conversationId: 'conv-A' }));
    openStreamSession(descriptor({ messageId: 'msg-B', conversationId: 'conv-B' }));

    reconcileChannelSessions('page-1', new Set(), { conversationId: 'conv-A' });

    expect(store().streams.has('msg-A')).toBe(false);
    expect(store().streams.has('msg-B')).toBe(true);
    expect(ends.map((e) => e.messageId)).toEqual(['msg-A']);
  });

  it('given an UNSCOPED snapshot, still reconciles the whole channel', () => {
    // The channel-wide provider subscription sends no narrowing, so its answer IS authoritative
    // for the channel.
    openStreamSession(descriptor({ messageId: 'msg-A', conversationId: 'conv-A' }));
    openStreamSession(descriptor({ messageId: 'msg-B', conversationId: 'conv-B' }));

    reconcileChannelSessions('page-1', new Set(['msg-A']));

    expect(store().streams.has('msg-A')).toBe(true);
    expect(store().streams.has('msg-B')).toBe(false);
  });
});

describe('reconcileChannelSessions — scoped to its own channel', () => {
  it('leaves a session on ANOTHER channel alone, however empty the live set', async () => {
    // Bootstrap answers for one channel at a time. A reconcile that ignored the channel would
    // tear down every other pane's streams on every bootstrap.
    const ends: StreamSessionEnd[] = [];
    onStreamSessionEnd((end) => ends.push(end));
    openStreamSession(descriptor({ messageId: 'msg-other', channelId: 'page-2' }));

    reconcileChannelSessions('page-1', new Set());

    expect(store().streams.has('msg-other')).toBe(true);
    expect(ends).toEqual([]);
  });
});
