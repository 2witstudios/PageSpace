/**
 * The poll discipline: the pure interval rule, and the hook actually
 * stopping after four idle answers and re-arming on an `active` toggle —
 * against the real SWR with real (short) timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';

// `fetchJSON` is what the hook uses (it throws the real `ApiRequestError` on
// a non-2xx — the plain authenticated fetch never throws). The mock models
// exactly that: resolve with the body, or throw with a status.
const mockFetchJSON = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/auth-fetch')>();
  return { ...actual, fetchJSON: (...args: unknown[]) => mockFetchJSON(...args) };
});

import { ApiRequestError } from '@/lib/auth/auth-fetch';
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
    detection: 'watching',
    state: { status: 'none', message: 'nothing' },
    slot: { known: false },
    openPath: '/o',
    canOpen: false,
    canStop: false,
    canResume: false,
    canApprove: false,
    spriteInstanceId: null,
    detectedAt: null,
    ...over,
  };
}

describe('devPreviewRefreshInterval — pure', () => {
  it('no timer while inactive, while the pane owns the poll, or after the idle budget; the interval otherwise', () => {
    expect(devPreviewRefreshInterval({ polling: false, pauseWhenIdle: true, idleStreak: 0, intervalMs: 15_000 })).toBe(0);
    expect(devPreviewRefreshInterval({ polling: true, pauseWhenIdle: true, idleStreak: IDLE_ANSWERS_BEFORE_PAUSE, intervalMs: 15_000 })).toBe(0);
    expect(devPreviewRefreshInterval({ polling: true, pauseWhenIdle: true, idleStreak: IDLE_ANSWERS_BEFORE_PAUSE - 1, intervalMs: 15_000 })).toBe(15_000);
    expect(devPreviewRefreshInterval({ polling: true, pauseWhenIdle: true, idleStreak: 0, intervalMs: 5_000 })).toBe(5_000);
    // A per-viewer surface never idle-pauses.
    expect(devPreviewRefreshInterval({ polling: true, pauseWhenIdle: false, idleStreak: 99, intervalMs: 5_000 })).toBe(5_000);
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
    mockFetchJSON.mockImplementation(async () => ({ preview: answer }));
  });
  afterEach(() => vi.clearAllMocks());

  it('STOPS after four idle answers (initial + 3 refreshes), and RE-ARMS when `polling` flips back on (expand, or the pane closing)', async () => {
    const { result, rerender } = renderHook(({ polling }: { polling: boolean }) => useDevPreviewStatus('/p', { polling, intervalMs: 15 }), {
      wrapper,
      initialProps: { polling: true },
    });
    await waitFor(() => expect(result.current.preview).toBeDefined());
    await waitFor(() => expect(mockFetchJSON).toHaveBeenCalledTimes(IDLE_ANSWERS_BEFORE_PAUSE));
    await new Promise((r) => setTimeout(r, 120));
    expect(mockFetchJSON).toHaveBeenCalledTimes(IDLE_ANSWERS_BEFORE_PAUSE);

    // Collapse then expand: the streak resets and polling resumes.
    rerender({ polling: false });
    await new Promise((r) => setTimeout(r, 60));
    expect(mockFetchJSON).toHaveBeenCalledTimes(IDLE_ANSWERS_BEFORE_PAUSE);
    rerender({ polling: true });
    await waitFor(() => expect(mockFetchJSON.mock.calls.length).toBeGreaterThan(IDLE_ANSWERS_BEFORE_PAUSE));
  });

  it('keeps polling while there is a dev server to watch', async () => {
    answer = preview({ state: { status: 'live', targetPort: 5173, via: 'relay', message: '' }, canOpen: true });
    renderHook(() => useDevPreviewStatus('/p', { intervalMs: 15 }), { wrapper });
    await waitFor(() => expect(mockFetchJSON.mock.calls.length).toBeGreaterThan(IDLE_ANSWERS_BEFORE_PAUSE + 2));
  });

  it('a FAILED poll does not freeze the status: it retries at the disciplined interval and recovers', async () => {
    let calls = 0;
    mockFetchJSON.mockImplementation(async () => {
      calls += 1;
      if (calls <= 2) throw new ApiRequestError('boom', 500);
      return { preview: preview({ state: { status: 'live', targetPort: 1, via: 'relay', message: '' }, canOpen: true }) };
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

  it('a retry that comes due while the tab is HIDDEN is re-armed, not dropped: the status recovers on return without a mutate or a remount', async () => {
    // The freeze this guards: SWR skips its interval while an error is
    // cached and `revalidateOnFocus` is off, so the retry timer is the only
    // thing that can un-freeze the status. Dropping it because the tab
    // happened to be hidden at fire time froze the pane at its last good
    // answer until the user remounted it.
    let hidden = true;
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (hidden ? 'hidden' : 'visible'));
    try {
      let calls = 0;
      let failing = true;
      mockFetchJSON.mockImplementation(async () => {
        calls += 1;
        if (failing) throw new ApiRequestError('boom', 500);
        return { preview: preview({ state: { status: 'live', targetPort: 1, via: 'relay', message: '' }, canOpen: true }) };
      });
      const { result } = renderHook(() => useDevPreviewStatus('/p', { intervalMs: 30 }), { wrapper });
      await waitFor(() => expect(result.current.error).toBeDefined());
      const afterFirstError = calls;

      // Many retry windows pass while hidden: NOTHING is requested (the
      // `refreshWhenHidden: false` property this must not break)...
      await new Promise((r) => setTimeout(r, 250));
      expect(calls).toBe(afterFirstError);

      // ...and coming back recovers on the very next window, with no mutate.
      failing = false;
      hidden = false;
      await waitFor(() => expect(result.current.preview?.state.status).toBe('live'), { timeout: 3000 });
      expect(result.current.error).toBeUndefined();
    } finally {
      visibility.mockRestore();
    }
  });

  it('with pauseWhenIdle: false an idle holder keeps being polled (the console header / pane case)', async () => {
    renderHook(() => useDevPreviewStatus('/p', { intervalMs: 15, pauseWhenIdle: false }), { wrapper });
    await waitFor(() => expect(mockFetchJSON.mock.calls.length).toBeGreaterThan(IDLE_ANSWERS_BEFORE_PAUSE + 2));
  });

  it('runs no timer when not polling, and a disabled/no-path hook fetches nothing at all', async () => {
    renderHook(() => useDevPreviewStatus('/p', { intervalMs: 15, polling: false }), { wrapper });
    await waitFor(() => expect(mockFetchJSON).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 80));
    expect(mockFetchJSON).toHaveBeenCalledTimes(1);

    mockFetchJSON.mockClear();
    renderHook(() => useDevPreviewStatus('/p', { enabled: false, intervalMs: 15 }), { wrapper });
    renderHook(() => useDevPreviewStatus(null, { intervalMs: 15 }), { wrapper });
    await new Promise((r) => setTimeout(r, 60));
    expect(mockFetchJSON).not.toHaveBeenCalled();
  });
});
