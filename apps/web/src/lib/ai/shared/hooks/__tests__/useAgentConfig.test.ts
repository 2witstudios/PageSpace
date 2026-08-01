import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { useAgentConfig } from '../useAgentConfig';

vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';

const mockFetchWithAuth = fetchWithAuth as unknown as ReturnType<typeof vi.fn>;

// A fresh cache per test (`provider: () => new Map()`) — the module-scope SWR
// cache is otherwise shared across tests and would let one test's config leak
// into the next's assertions for the same pageId.
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

describe('useAgentConfig', () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
  });

  it('fetches from /api/pages/{pageId}/agent-config, keyed by pageId', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ systemPrompt: 'be helpful', enabledTools: [], availableTools: [] }),
    });

    const { result } = renderHook(() => useAgentConfig('agent-1'), { wrapper });

    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/pages/agent-1/agent-config');
    await waitFor(() => expect(result.current.config).not.toBeNull());
    expect(result.current.config).toEqual({ systemPrompt: 'be helpful', enabledTools: [], availableTools: [] });
  });

  it('starts with config: null before the fetch resolves', () => {
    mockFetchWithAuth.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useAgentConfig('agent-1'), { wrapper });

    expect(result.current.config).toBeNull();
  });

  // The whole point of this hook: two consumers of the SAME pageId share ONE
  // cache entry. A save from one instance's setConfig must be visible in the
  // other WITHOUT a second fetch — that's what makes Settings a single
  // source of truth across N panes showing the same agent.
  it('setConfig writes through the SHARED cache — a second hook instance for the same pageId sees the update with no additional fetch', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ systemPrompt: 'original', enabledTools: [], availableTools: [] }),
    });

    const cache = new Map();
    const sharedWrapper = ({ children }: { children: ReactNode }) =>
      createElement(SWRConfig, { value: { provider: () => cache } }, children);

    const first = renderHook(() => useAgentConfig('agent-1'), { wrapper: sharedWrapper });
    await waitFor(() => expect(first.result.current.config?.systemPrompt).toBe('original'));

    act(() => {
      first.result.current.setConfig({ systemPrompt: 'saved', enabledTools: [], availableTools: [] });
    });
    expect(first.result.current.config?.systemPrompt).toBe('saved');

    const fetchCallsBeforeSecondMount = mockFetchWithAuth.mock.calls.length;
    const second = renderHook(() => useAgentConfig('agent-1'), { wrapper: sharedWrapper });

    expect(second.result.current.config?.systemPrompt).toBe('saved');
    expect(mockFetchWithAuth.mock.calls.length).toBe(fetchCallsBeforeSecondMount);
  });

  it('setConfig does not trigger a revalidating refetch (the caller already has the server-fresh value)', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ systemPrompt: 'original', enabledTools: [], availableTools: [] }),
    });

    const { result } = renderHook(() => useAgentConfig('agent-1'), { wrapper });
    await waitFor(() => expect(result.current.config).not.toBeNull());
    const callsAfterInitialLoad = mockFetchWithAuth.mock.calls.length;

    act(() => {
      result.current.setConfig({ systemPrompt: 'saved', enabledTools: [], availableTools: [] });
    });

    expect(mockFetchWithAuth.mock.calls.length).toBe(callsAfterInitialLoad);
  });

  it('two different pageIds are independent cache entries', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => ({
        systemPrompt: url.includes('agent-1') ? 'config-for-1' : 'config-for-2',
        enabledTools: [],
        availableTools: [],
      }),
    }));

    const { result: r1 } = renderHook(() => useAgentConfig('agent-1'), { wrapper });
    const { result: r2 } = renderHook(() => useAgentConfig('agent-2'), { wrapper });

    await waitFor(() => expect(r1.current.config?.systemPrompt).toBe('config-for-1'));
    await waitFor(() => expect(r2.current.config?.systemPrompt).toBe('config-for-2'));
  });
});
