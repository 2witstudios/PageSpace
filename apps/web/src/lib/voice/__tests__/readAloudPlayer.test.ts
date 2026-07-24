import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }));
vi.mock('sonner', () => ({
  toast: { error: toastErrorMock, success: vi.fn() },
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useVoiceModeStore } from '@/stores/useVoiceModeStore';
import { useDictationActivityStore } from '@/hooks/useSpeechRecognition';
import {
  startReadAloud,
  stopReadAloud,
  isReadAloudPlaying,
  useReadAloudPlayerStore,
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
    toastErrorMock.mockClear();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as Response);
  });

  afterEach(() => {
    stopReadAloud();
    useVoiceModeStore.getState().disable();
    useDictationActivityStore.setState({ activeCount: 0 });
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
    const unsubscribeA = useReadAloudPlayerStore.subscribe(surfaceA);
    const unsubscribeB = useReadAloudPlayerStore.subscribe(surfaceB);

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
    const unsubscribe = useReadAloudPlayerStore.subscribe(listener);
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

  it('stops playback the moment Voice Mode is enabled, regardless of how it was enabled', () => {
    // Enforced at the module level (subscribed to useVoiceModeStore) rather
    // than by any specific UI call site — so calling the store's enable()
    // action directly, bypassing every view's own handleVoiceModeToggle,
    // must still stop read-aloud.
    startReadAloud(['hello there']);
    expect(isReadAloudPlaying()).toBe(true);

    useVoiceModeStore.getState().enable('ai-page');

    expect(isReadAloudPlaying()).toBe(false);
  });

  it('aborts the in-flight synthesis fetch when stopped, instead of only discarding its result', () => {
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(fetchWithAuth).mockImplementation((_url, options) => {
      capturedSignal = (options as RequestInit | undefined)?.signal ?? undefined;
      return new Promise(() => {}); // never resolves — only the signal matters here
    });

    startReadAloud(['only chunk']);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    stopReadAloud();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('stops playback the moment mic dictation becomes active anywhere, regardless of which ChatInput instance started it', () => {
    // Dictation is per-ChatInput-instance local state (useSpeechRecognition),
    // unlike Voice Mode's single global store — this simulates a DIFFERENT
    // mounted surface's mic starting, via the shared activeCount it feeds.
    startReadAloud(['hello there']);
    expect(isReadAloudPlaying()).toBe(true);

    useDictationActivityStore.setState({ activeCount: 1 });

    expect(isReadAloudPlaying()).toBe(false);
  });

  it('reloads persisted voice settings on every start, not just once', () => {
    const loadSettingsSpy = vi.spyOn(useVoiceModeStore.getState(), 'loadSettings');

    startReadAloud(['first']);
    stopReadAloud();
    startReadAloud(['second']);

    expect(loadSettingsSpy).toHaveBeenCalledTimes(2);
  });

  it('refuses to start when Voice Mode is already enabled at call time, even with no prior transition to observe', () => {
    // Not a "stop while playing" case — Voice Mode was ALREADY on before
    // startReadAloud() ever ran, so the subscription (which only fires on a
    // future inactive-to-active transition) never gets a chance to fire.
    useVoiceModeStore.getState().enable('ai-page');

    startReadAloud(['hello there']);

    expect(isReadAloudPlaying()).toBe(false);
    expect(createdSources).toHaveLength(0);
  });

  it('refuses to start when dictation is already active at call time, even with no prior transition to observe', () => {
    useDictationActivityStore.setState({ activeCount: 1 });

    startReadAloud(['hello there']);

    expect(isReadAloudPlaying()).toBe(false);
    expect(createdSources).toHaveLength(0);
  });

  it('surfaces a systemic synthesis failure and stops the run instead of retry-skipping every remaining chunk', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ message: 'Voice synthesis is not configured on this deployment.' }),
    } as Response);

    startReadAloud(['first chunk', 'second chunk']);

    await vi.waitFor(() => expect(isReadAloudPlaying()).toBe(false));
    expect(createdSources).toHaveLength(0);
    expect(toastErrorMock).toHaveBeenCalledWith('Voice synthesis is not configured on this deployment.');
    // Stopped after the first failure — never even attempted the second chunk.
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('does not surface an error toast when synthesis is cancelled by an intentional stop', async () => {
    // Mirrors a real fetch()'s behavior on abort: rejects with an AbortError,
    // either immediately (if already aborted) or once the signal fires.
    vi.mocked(fetchWithAuth).mockImplementation((_url, options) => {
      const signal = (options as RequestInit | undefined)?.signal;
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort);
      });
    });

    startReadAloud(['only chunk']);
    stopReadAloud();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('surfaces an error toast and stops the run when synthesis throws for a reason other than an intentional stop', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(new Error('network blip'));

    startReadAloud(['first chunk', 'second chunk']);

    await vi.waitFor(() => expect(isReadAloudPlaying()).toBe(false));
    expect(toastErrorMock).toHaveBeenCalledWith('Could not read this reply aloud. Please try again.');
    // Stopped after the first failure — never even attempted the second chunk.
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('does not surface a toast for a stale, already-superseded run that fails on its own after a restart', async () => {
    let rejectFirst: ((err: Error) => void) | undefined;
    const firstResponse = new Promise<Response>((_resolve, reject) => {
      rejectFirst = reject;
    });
    vi.mocked(fetchWithAuth)
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      } as Response);

    startReadAloud(['stale chunk']); // run A: fetch pending
    stopReadAloud(); // stopped before run A's fetch ever resolved
    startReadAloud(['fresh chunk']); // run B: a fresh, successful fetch

    // Run A's fetch fails for its own, unrelated reason — AFTER run B has
    // already begun. The user already moved on; this shouldn't surface a
    // confusing error about a read they're no longer waiting on.
    rejectFirst?.(new Error('unrelated network blip'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(isReadAloudPlaying()).toBe(true);
  });
});
