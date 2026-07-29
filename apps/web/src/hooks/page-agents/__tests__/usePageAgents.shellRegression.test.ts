/**
 * Regression test for the shell/SWR-pause bug (Phase 6, agents rebuild).
 *
 * The old Development surface never showed the agents list beside a live
 * terminal; the new Agents console ALWAYS does (sidebar + AgentView side by
 * side), so a shell session registering with the WRONG editing-store type
 * would freeze `usePageAgents`'s SWR revalidation for as long as any shell
 * anywhere stayed open — the sidebar would never again reflect a renamed or
 * newly-created agent.
 *
 * Unlike `usePageAgents.test.ts` (which mocks `useEditingStore` outright to
 * unit-test the hasLoadedRef guard), this suite uses the REAL store so the
 * actual `'shell'` session type is exercised end to end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SWRResponse } from 'swr';

vi.mock('swr', () => ({
  default: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/stores/page-agents', () => ({
  type: {} as Record<string, unknown>,
}));

import useSWR from 'swr';
import { useEditingStore } from '@/stores/useEditingStore';
import { usePageAgents } from '../usePageAgents';

function mockSwrReturn() {
  vi.mocked(useSWR).mockReturnValue({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
    isValidating: false,
  } as SWRResponse);
}

function currentIsPaused(): () => boolean {
  const call = vi.mocked(useSWR).mock.calls.at(-1)!;
  const config = call[2] as { isPaused?: () => boolean; onSuccess?: () => void };
  config.onSuccess?.();
  return config.isPaused!;
}

describe('usePageAgents — shell sessions must not pause SWR revalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditingStore.getState().clearAllSessions();
  });

  it('stays revalidating while a shell (PTY) session is open', () => {
    useEditingStore.getState().startEditing('shell-1', 'shell', { componentName: 'shell' });
    mockSwrReturn();

    const { unmount } = renderHook(() => usePageAgents());

    expect(currentIsPaused()()).toBe(false);

    unmount();
    useEditingStore.getState().endEditing('shell-1');
  });

  it('still pauses for a genuine document/form edit, alongside an open shell', () => {
    useEditingStore.getState().startEditing('shell-1', 'shell', { componentName: 'shell' });
    useEditingStore.getState().startEditing('doc-1', 'document');
    mockSwrReturn();

    const { unmount } = renderHook(() => usePageAgents());

    expect(currentIsPaused()()).toBe(true);

    unmount();
    useEditingStore.getState().endEditing('shell-1');
    useEditingStore.getState().endEditing('doc-1');
  });

  it('an ai-streaming session alone does not pause it either', () => {
    useEditingStore.getState().startStreaming('stream-1');
    mockSwrReturn();

    const { unmount } = renderHook(() => usePageAgents());

    expect(currentIsPaused()()).toBe(false);

    unmount();
    useEditingStore.getState().endStreaming('stream-1');
  });
});
