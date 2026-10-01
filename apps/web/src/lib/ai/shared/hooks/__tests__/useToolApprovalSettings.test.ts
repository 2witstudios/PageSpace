import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { SWRConfig } from 'swr';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useToolApprovalSettings } from '../useToolApprovalSettings';

const mockFetchWithAuth = fetchWithAuth as unknown as ReturnType<typeof vi.fn>;

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const grant = (id: string) => ({ id, toolName: 'trash_page', conversationId: null, createdAt: '2026-09-01T00:00:00.000Z' });

/** GETs answer from the given state; writes answer with `writeStatus`. */
const serve = (state: { mode: 'ask' | 'auto'; grants: ReturnType<typeof grant>[] }, writeStatus = 200) => {
  mockFetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') return json({ error: 'nope' }, writeStatus);
    if (url.endsWith('/tool-grants')) return json({ grants: state.grants });
    return json({ config: { toolApprovalMode: state.mode } });
  });
};

describe('useToolApprovalSettings', () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    toastError.mockClear();
  });

  it('given a failed mode save, rolls back and shows an error toast instead of failing silently', async () => {
    serve({ mode: 'ask', grants: [] }, 500);
    const { result } = renderHook(() => useToolApprovalSettings(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.setMode('auto');
    });

    expect(result.current.mode).toBe('ask');
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('given a failed revoke, restores the grant and shows an error toast', async () => {
    serve({ mode: 'ask', grants: [grant('g1')] }, 500);
    const { result } = renderHook(() => useToolApprovalSettings(), { wrapper });
    await waitFor(() => expect(result.current.grants).toHaveLength(1));

    await act(async () => {
      await result.current.revokeGrant('g1');
    });

    expect(result.current.grants.map((g) => g.id)).toEqual(['g1']);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('refreshGrants picks up a grant created elsewhere (an "Always allow" click in the chat)', async () => {
    const state = { mode: 'ask' as const, grants: [] as ReturnType<typeof grant>[] };
    serve(state);
    const { result } = renderHook(() => useToolApprovalSettings(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    state.grants = [grant('g-new')];
    await act(async () => {
      await result.current.refreshGrants();
    });

    expect(result.current.grants.map((g) => g.id)).toEqual(['g-new']);
  });
});
