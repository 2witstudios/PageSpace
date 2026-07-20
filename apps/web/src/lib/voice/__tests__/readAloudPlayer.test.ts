import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import {
  startReadAloud,
  stopReadAloud,
  isReadAloudPlaying,
  subscribeReadAloud,
} from '../readAloudPlayer';

class FakeAudioBufferSourceNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect(): void {}
  start = vi.fn();
  stop = vi.fn();
}

const createdSources: FakeAudioBufferSourceNode[] = [];

class FakeAudioContext {
  state = 'running';
  destination = {};
  createBufferSource(): FakeAudioBufferSourceNode {
    const node = new FakeAudioBufferSourceNode();
    createdSources.push(node);
    return node;
  }
  decodeAudioData(): Promise<unknown> {
    return Promise.resolve({});
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

describe('readAloudPlayer', () => {
  beforeEach(() => {
    createdSources.length = 0;
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as Response);
  });

  afterEach(() => {
    stopReadAloud();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is not playing before anything starts', () => {
    expect(isReadAloudPlaying()).toBe(false);
  });

  it('flips to playing synchronously when starting, before synthesis resolves', () => {
    startReadAloud(['hello there']);
    expect(isReadAloudPlaying()).toBe(true);
  });

  it('given no chunks, does not start playing', () => {
    startReadAloud([]);
    expect(isReadAloudPlaying()).toBe(false);
  });

  it('stop clears the playing state immediately', () => {
    startReadAloud(['hello there']);
    stopReadAloud();
    expect(isReadAloudPlaying()).toBe(false);
  });

  it('notifies subscribers on start and stop, regardless of which call site triggers it', () => {
    // Simulates two independent useReadAloud() call sites (e.g. sidebar +
    // main content) both observing the one shared player.
    const surfaceA = vi.fn();
    const surfaceB = vi.fn();
    const unsubscribeA = subscribeReadAloud(surfaceA);
    const unsubscribeB = subscribeReadAloud(surfaceB);

    startReadAloud(['hello there']);
    expect(surfaceA).toHaveBeenCalledTimes(1);
    expect(surfaceB).toHaveBeenCalledTimes(1);

    // A stop triggered from "surface B" must be observable by "surface A" —
    // this is the cross-surface ownership guarantee the singleton provides.
    stopReadAloud();
    expect(surfaceA).toHaveBeenCalledTimes(2);
    expect(surfaceB).toHaveBeenCalledTimes(2);
    expect(isReadAloudPlaying()).toBe(false);

    unsubscribeA();
    unsubscribeB();
  });

  it('unsubscribing stops further notifications', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeReadAloud(listener);
    unsubscribe();

    startReadAloud(['hello there']);
    expect(listener).not.toHaveBeenCalled();
  });

  it('starting a new read-aloud while one is in flight replaces the previous queue', () => {
    startReadAloud(['first attempt', 'more of the first']);
    startReadAloud(['second attempt']);
    expect(isReadAloudPlaying()).toBe(true);
  });

  it('stopping when nothing is playing is a no-op that does not throw', () => {
    expect(() => stopReadAloud()).not.toThrow();
    expect(isReadAloudPlaying()).toBe(false);
  });

  it('synthesizes and starts playback of a single chunk, then finishes naturally when it ends', async () => {
    startReadAloud(['only chunk']);
    await vi.waitFor(() => expect(createdSources).toHaveLength(1));
    expect(createdSources[0].start).toHaveBeenCalledTimes(1);
    expect(isReadAloudPlaying()).toBe(true);

    // Simulate the browser firing onended once the clip finishes.
    createdSources[0].onended?.();
    await vi.waitFor(() => expect(isReadAloudPlaying()).toBe(false));
  });

  it('plays multiple queued chunks back to back in order', async () => {
    startReadAloud(['first', 'second']);
    await vi.waitFor(() => expect(createdSources).toHaveLength(1));

    createdSources[0].onended?.();
    await vi.waitFor(() => expect(createdSources).toHaveLength(2));
    expect(isReadAloudPlaying()).toBe(true);

    createdSources[1].onended?.();
    await vi.waitFor(() => expect(isReadAloudPlaying()).toBe(false));
  });

  it('skips a chunk that fails to synthesize and continues with the rest', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      } as Response);

    startReadAloud(['broken chunk', 'good chunk']);
    // The first chunk's failed synthesis is skipped without ever creating a
    // source; only the second, successful chunk should end up playing.
    await vi.waitFor(() => expect(createdSources).toHaveLength(1));
    expect(isReadAloudPlaying()).toBe(true);

    createdSources[0].onended?.();
    await vi.waitFor(() => expect(isReadAloudPlaying()).toBe(false));
  });

  it('discards a chunk that finishes synthesizing after stop was already called', async () => {
    startReadAloud(['only chunk']);
    stopReadAloud();
    // Let the in-flight synthesis resolve; it must not resurrect playback.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(createdSources).toHaveLength(0);
    expect(isReadAloudPlaying()).toBe(false);
  });

  it('given a stop-then-restart while the stopped run is still synthesizing, only the new run ever plays', async () => {
    // Two independently-resolvable synthesis calls, so the first run's
    // fetch can be made to resolve AFTER a second run has already started —
    // reproducing the exact race the generation token guards against.
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = () => resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      } as Response);
    });
    const secondResponse = new Promise<Response>((resolve) => {
      resolveSecond = () => resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      } as Response);
    });
    vi.mocked(fetchWithAuth)
      .mockReturnValueOnce(firstResponse)
      .mockReturnValueOnce(secondResponse);

    startReadAloud(['stale chunk']); // run A: fetch is now pending
    stopReadAloud(); // stopped before run A's fetch ever resolved
    startReadAloud(['fresh chunk']); // run B: a second, independent fetch is pending

    // Resolve the STALE run's fetch first, after the fresh run has already
    // begun — without the generation guard this would create and start a
    // second, overlapping AudioBufferSourceNode.
    resolveFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(createdSources).toHaveLength(0);

    resolveSecond?.();
    await vi.waitFor(() => expect(createdSources).toHaveLength(1));
    expect(isReadAloudPlaying()).toBe(true);
  });
});
