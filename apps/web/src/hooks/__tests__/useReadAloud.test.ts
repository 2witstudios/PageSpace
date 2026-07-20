import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import { useReadAloud } from '../useReadAloud';
import { startReadAloud, stopReadAloud, isReadAloudPlaying } from '@/lib/voice/readAloudPlayer';

class FakeAudioBufferSourceNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect(): void {}
  start(): void {}
  stop(): void {}
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

describe('useReadAloud — unmount lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  afterEach(() => {
    stopReadAloud();
    vi.unstubAllGlobals();
  });

  it('stops playback when the only mounted consumer unmounts', () => {
    const { unmount } = renderHook(() => useReadAloud());
    startReadAloud(['hello there']);
    expect(isReadAloudPlaying()).toBe(true);

    unmount();

    expect(isReadAloudPlaying()).toBe(false);
  });

  it('does not stop playback when one of several mounted consumers unmounts, only when the last one does', () => {
    // Simulates the sidebar chat and main chat both being mounted at once.
    const first = renderHook(() => useReadAloud());
    const second = renderHook(() => useReadAloud());
    startReadAloud(['hello there']);
    expect(isReadAloudPlaying()).toBe(true);

    first.unmount();
    expect(isReadAloudPlaying()).toBe(true);

    second.unmount();
    expect(isReadAloudPlaying()).toBe(false);
  });
});
