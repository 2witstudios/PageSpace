import { describe, it, expect, vi } from 'vitest';

// Kept in its own file, separate from readAloudPlayer.test.ts: the module's
// AudioContext is a lazy singleton, created once and never recreated — a
// prior test in the same file that successfully starts playback leaves it
// cached, so a throwing AudioContext stub registered in a LATER test would
// never actually get invoked. A fresh file gives Vitest a fresh module
// registry, guaranteeing this is the first (and only) call to
// getAudioContext() in this environment.

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }));
vi.mock('sonner', () => ({
  toast: { error: toastErrorMock, success: vi.fn() },
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { startReadAloud, isReadAloudPlaying } from '../readAloudPlayer';

describe('readAloudPlayer — AudioContext construction failure', () => {
  it('surfaces an error and stops the run when creating the AudioContext itself fails', async () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('Web Audio unavailable');
        }
      }
    );

    startReadAloud(['hello there']);

    await vi.waitFor(() => expect(isReadAloudPlaying()).toBe(false));
    expect(toastErrorMock).toHaveBeenCalledWith('Could not read this reply aloud. Please try again.');
    // Never even reached the network call — failed before fetchWithAuth.
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
