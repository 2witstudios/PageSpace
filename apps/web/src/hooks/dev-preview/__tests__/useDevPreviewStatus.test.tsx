/**
 * The poll discipline: the pure interval rule, and the hook actually
 * stopping after four idle answers and re-arming on an `active` toggle —
 * against the real SWR with real (short) timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';

const mockFetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args) }));

import {
  IDLE_ANSWERS_BEFORE_PAUSE,
  devPreviewRefreshInterval,
  isIdleDevPreviewAnswer,
  useDevPreviewStatus,
  type DevPreviewStatusDTO,
} from '../useDevPreviewStatus';

function preview(over: Partial<DevPreviewStatusDTO> = {}): DevPreviewStatusDTO {
  return {
    holder: { kind: 'env', id: 'e' },
    canManage: false,
    sandbox: 'attached',
    state: { status: 'none', message: 'nothing' },
    slot: { known: false },
    openPath: '/o',
    canOpen: false,
    canStop: false,
    canResume: false,
    detectedAt: null,
    ...over,
  };
}

describe('devPreviewRefreshInterval — pure', () => {
  it('no timer while inactive, while the pane owns the poll, or after the idle budget; the interval otherwise', () => {
    expect(devPreviewRefreshInterval({ active: false, paneOwnsPoll: false, pauseWhenIdle: true, idleStreak: 0, intervalMs: 15_000 })).toBe(0);
    expect(devPreviewRefreshInterval({ active: true, paneOwnsPoll: true, pauseWhenIdle: true, idleStreak: 0, intervalMs: 15_000 })).toBe(0);
    expect(devPreviewRefreshInterval({ active: true, paneOwnsPoll: false, pauseWhenIdle: true, idleStreak: IDLE_ANSWERS_BEFORE_PAUSE, intervalMs: 15_000 })).toBe(0);
    expect(devPreviewRefreshInterval({ active: true, paneOwnsPoll: false, pauseWhenIdle: true, idleStreak: IDLE_ANSWERS_BEFORE_PAUSE - 1, intervalMs: 15_000 })).toBe(15_000);
    expect(devPreviewRefreshInterval({ active: true, paneOwnsPoll: false, pauseWhenIdle: true, idleStreak: 0, intervalMs: 5_000 })).toBe(5_000);
    // A per-viewer surface never idle-pauses.
    expect(devPreviewRefreshInterval({ active: true, paneOwnsPoll: false, pauseWhenIdle: false, idleStreak: 99, intervalMs: 5_000 })).toBe(5_000);
  });

  it('an idle answer is "none" or an absent sandbox; anything with a dev server is not', () => {
    expect(isIdleDevPreviewAnswer(undefined)).toBe(false);
    expect(isIdleDevPreviewAnswer(preview())).toBe(true);
    expect(isIdleDevPreviewAnswer(preview({ sandbox: 'absent', state: { status: 'instance-unknown', message: '' } }))).toBe(true);
    expect(isIdleDevPreviewAnswer(preview({ state: { status: 'live', targetPort: 1, via: 'relay', message: '' } }))).toBe(false);
    expect(isIdleDevPreviewAnswer(preview({ state: { status: 'stopped', targetPort: 1, stoppedAt: 'x', message: '' } }))).toBe(false);
  });
});

describe('useDevPreviewStatus — the hook against real SWR', () => {
  let answer: DevPreviewStatusDTO;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );

  beforeEach(() => {
    answer = preview();
    mockFetchWithAuth.mockImplementation(async () => ({ ok: true, json: async () => ({ preview: answer }) }));
  });
  afterEach(() => vi.clearAllMocks());

  it('STOPS after four idle answers (initial + 3 refreshes), and RE-ARMS when `active` toggles', async () => {
    const { result, rerender } = renderHook(({ active }: { active: boolean }) => useDevPreviewStatus('/p', { active, intervalMs: 15 }), {
      wrapper,
      initialProps: { active: true },
    });
    await waitFor(() => expect(result.current.preview).toBeDefined());
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(IDLE_ANSWERS_BEFORE_PAUSE));
    await new Promise((r) => setTimeout(r, 120));
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(IDLE_ANSWERS_BEFORE_PAUSE);

    // Collapse then expand: the streak resets and polling resumes.
    rerender({ active: false });
    await new Promise((r) => setTimeout(r, 60));
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(IDLE_ANSWERS_BEFORE_PAUSE);
    rerender({ active: true });
    await waitFor(() => expect(mockFetchWithAuth.mock.calls.length).toBeGreaterThan(IDLE_ANSWERS_BEFORE_PAUSE));
  });

  it('keeps polling while there is a dev server to watch', async () => {
    answer = preview({ state: { status: 'live', targetPort: 5173, via: 'relay', message: '' }, canOpen: true });
    renderHook(() => useDevPreviewStatus('/p', { intervalMs: 15 }), { wrapper });
    await waitFor(() => expect(mockFetchWithAuth.mock.calls.length).toBeGreaterThan(IDLE_ANSWERS_BEFORE_PAUSE + 2));
  });

  it('a FAILED poll does not freeze the status: it retries at the disciplined interval and recovers', async () => {
    let calls = 0;
    mockFetchWithAuth.mockImplementation(async () => {
      calls += 1;
      if (calls <= 2) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ preview: preview({ state: { status: 'live', targetPort: 1, via: 'relay', message: '' }, canOpen: true }) }) };
    });
    const { result } = renderHook(() => useDevPreviewStatus('/p', { intervalMs: 120 }), { wrapper });
    // The error is surfaced (the pane's 404 auto-close depends on that)...
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.preview).toBeUndefined();
    // ...and the retry at the disciplined interval recovers without a key change.
    await waitFor(() => expect(result.current.preview?.state.status).toBe('live'), { timeout: 3000 });
    expect(result.current.error).toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('with pauseWhenIdle: false an idle holder keeps being polled (the console header / pane case)', async () => {
    renderHook(() => useDevPreviewStatus('/p', { intervalMs: 15, pauseWhenIdle: false }), { wrapper });
    await waitFor(() => expect(mockFetchWithAuth.mock.calls.length).toBeGreaterThan(IDLE_ANSWERS_BEFORE_PAUSE + 2));
  });

  it('runs no timer when the pane owns the poll, when disabled, or with no path — but a disabled/no-path hook fetches nothing at all', async () => {
    renderHook(() => useDevPreviewStatus('/p', { intervalMs: 15, paneOwnsPoll: true }), { wrapper });
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 80));
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    mockFetchWithAuth.mockClear();
    renderHook(() => useDevPreviewStatus('/p', { enabled: false, intervalMs: 15 }), { wrapper });
    renderHook(() => useDevPreviewStatus(null, { intervalMs: 15 }), { wrapper });
    await new Promise((r) => setTimeout(r, 60));
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });
});
