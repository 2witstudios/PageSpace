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

  it('given a failed join over a SEEDED snapshot, keeps the snapshot rendered', async () => {
    // The snapshot is usually the only surviving copy of the partial reply (the originator's
    // process died, so its channel 404s). Removing it would undo the restore that just happened.
    consumeStreamJoin.mockRejectedValue(new StreamJoinError('gone', 500));

    openStreamSession(descriptor({ seedParts: [{ type: 'text', text: 'partial' }] }));
    await settle();

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
