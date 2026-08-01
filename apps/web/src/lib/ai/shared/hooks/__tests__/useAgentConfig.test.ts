import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { useAgentConfig } from '../useAgentConfig';
import type { AgentConfig } from '../../chat-types';

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

  // review finding — chatgpt-codex-connector on PR #2299, round 23: two
  // sibling surfaces PATCHing the SAME field race not just on which save
  // STARTS first, but on which HTTP RESPONSE arrives first — that need not
  // match DB-write order. Merging optimistic updates alone can't tell the
  // two apart; revalidate() lets the cache reconcile to server ground
  // truth.
  it('revalidate() re-fetches and replaces the cache with the server response', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ systemPrompt: 'original', enabledTools: [], availableTools: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ systemPrompt: 'ground-truth-from-server', enabledTools: [], availableTools: [] }),
      });

    const { result } = renderHook(() => useAgentConfig('agent-1'), { wrapper });
    await waitFor(() => expect(result.current.config?.systemPrompt).toBe('original'));

    // An optimistic update that (in the real bug) could be wrong relative
    // to a sibling's out-of-order response.
    act(() => {
      result.current.setConfig({ systemPrompt: 'optimistic-guess', enabledTools: [], availableTools: [] });
    });
    expect(result.current.config?.systemPrompt).toBe('optimistic-guess');

    await act(async () => {
      result.current.revalidate();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.config?.systemPrompt).toBe('ground-truth-from-server'));
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
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

  // review finding — chatgpt-codex-connector on PR #2299, round 22:
  // PageAgentSettingsTab's onSubmit used to build its cache update from a
  // `config` value closed over when the save STARTED — two sibling saves
  // for different fields could each publish a snapshot missing the
  // other's meanwhile-arrived change. setConfig now also accepts an
  // updater, applied against whatever the cache actually holds when SWR's
  // own mutate runs it, not a stale closure.
  it('setConfig accepts an updater function that merges against the LIVE cache value, not a stale closure', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ systemPrompt: 'original', enabledTools: [], availableTools: [], aiProvider: 'openai' }),
    });

    const { result } = renderHook(() => useAgentConfig('agent-1'), { wrapper });
    await waitFor(() => expect(result.current.config).not.toBeNull());

    // Simulates two "sibling saves" of DIFFERENT fields, each an updater
    // over whatever is live at apply time rather than a value closed over
    // from before either save started.
    act(() => {
      result.current.setConfig((current) => ({ ...current, systemPrompt: 'saved-by-a' }) as AgentConfig);
    });
    act(() => {
      result.current.setConfig((current) => ({ ...current, aiProvider: 'anthropic' }) as AgentConfig);
    });

    // Both merges applied — the second updater saw the first's change via
    // the live cache, not a stale closure that would have reverted it.
    expect(result.current.config).toEqual({
      systemPrompt: 'saved-by-a',
      enabledTools: [],
      availableTools: [],
      aiProvider: 'anthropic',
    });
  });

  // The global assistant has no page — a pane hosting it must still be able
  // to call this hook unconditionally (stable hook order across an agent
  // switch within the same pane instance) without issuing a request.
  it('given pageId: null (the global assistant), never fetches and config stays null', async () => {
    const { result } = renderHook(() => useAgentConfig(null), { wrapper });

    expect(mockFetchWithAuth).not.toHaveBeenCalled();
    expect(result.current.config).toBeNull();
  });
});
