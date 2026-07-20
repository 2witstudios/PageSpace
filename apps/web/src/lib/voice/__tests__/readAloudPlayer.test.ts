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
  start(): void {}
  stop = vi.fn();
}

class FakeAudioContext {
  state = 'running';
  destination = {};
  createBufferSource(): FakeAudioBufferSourceNode {
    return new FakeAudioBufferSourceNode();
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
});
