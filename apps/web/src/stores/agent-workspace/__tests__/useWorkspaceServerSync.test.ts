/**
 * `useWorkspaceServerSync` — debounced save + race-guarded hydration. What
 * matters here: it never fires a PUT per transition (only after activity
 * settles), it force-flushes on unmount, and hydration never clobbers a
 * local change that happened while the GET was still in flight.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { PaneScope } from '@pagespace/lib/agent-sessions/contract';
import { useWorkspaceServerSync, __resetHydratedSessionsForTests } from '../useWorkspaceServerSync';
import { useAgentWorkspaceStore } from '../useAgentWorkspaceStore';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));
vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: {
    getState: vi.fn(() => ({
      startEditing: vi.fn(),
      endEditing: vi.fn(),
    })),
  },
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
const mockFetch = fetchWithAuth as ReturnType<typeof vi.fn>;

const scope = (targetId = 'conv-1'): PaneScope => ({ kind: 'chat', name: 'Conversation', targetId, agentPageId: null });
const store = () => useAgentWorkspaceStore.getState();
const grid = (id = 'ses-1') => store().workspaces[id];

const notSaved = { ok: true, json: () => Promise.resolve({ workspace: null }) };

beforeEach(() => {
  vi.clearAllMocks();
  useAgentWorkspaceStore.setState({ workspaces: {} });
  mockFetch.mockResolvedValue(notSaved);
  // The "hydrated this session already" tracking is module-level (survives
  // real remounts on purpose — see the hook's own comment) — tests share
  // that module scope across the whole file, so it must be reset per test.
  __resetHydratedSessionsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('disabled', () => {
  it('never fetches or schedules a save', async () => {
    store().ensureWorkspace('ses-1', scope());
    renderHook(() => useWorkspaceServerSync('ses-1', { enabled: false }));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('hydration', () => {
  it('seeds the grid from the server when nothing local has changed since the fetch began', async () => {
    store().ensureWorkspace('ses-1', scope());
    const saved = {
      id: 'ses-1',
      columns: [{ id: 'col-x', panes: [{ id: 'pane-x', scope: scope('conv-saved'), tabs: [scope('conv-saved')] }] }],
      activePaneId: 'pane-x',
      pendingPickerPaneId: null,
    };
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ workspace: saved }) });

    renderHook(() => useWorkspaceServerSync('ses-1'));

    await waitFor(() => {
      expect(grid()).toEqual(saved);
    });
  });

  it('hydrates even when a local mutation happened before the fetch resolved — server wins on first load', async () => {
    store().ensureWorkspace('ses-1', scope());
    let resolveFetch!: (value: unknown) => void;
    mockFetch.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));

    renderHook(() => useWorkspaceServerSync('ses-1'));

    // A local change races ahead of the GET — e.g. the mount-time
    // `openConversation` seed effect (or, here, a stand-in split) runs in
    // the same commit as the fetch is kicked off, before it resolves. A
    // reference-equality guard against this would see it as "something
    // moved on" and skip hydration on effectively every real mount — the
    // bug this test used to (wrongly) lock in (review finding).
    const paneIdBeforeSplit = grid().activePaneId;
    act(() => {
      store().splitRight('ses-1', paneIdBeforeSplit);
    });

    const saved = {
      id: 'ses-1',
      columns: [{ id: 'col-x', panes: [{ id: 'pane-x', scope: scope('conv-saved'), tabs: [scope('conv-saved')] }] }],
      activePaneId: 'pane-x',
      pendingPickerPaneId: null,
    };
    await act(async () => {
      resolveFetch({ ok: true, json: () => Promise.resolve({ workspace: saved }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The server's saved grid wins, overwriting the local split.
    expect(grid()).toEqual(saved);
  });

  it('given no saved workspace, leaves the local grid untouched', async () => {
    store().ensureWorkspace('ses-1', scope());
    const before = grid();
    renderHook(() => useWorkspaceServerSync('ses-1'));
    await new Promise((r) => setTimeout(r, 0));
    expect(grid()).toEqual(before);
  });

  // GET-only count — `mockFetch` also backs the debounced-save PUT, which
  // the mount-time `ensureWorkspace` seed can itself trigger; a plain call
  // count would conflate the two.
  const getCalls = () => mockFetch.mock.calls.filter((c) => c[1] === undefined);

  it('does not re-fetch on a REMOUNT for a session already hydrated this page load', async () => {
    // `AgentPanes` is rendered `key={selectedSessionId}` — switching to
    // another session and back is a fresh mount of this hook every time.
    // Re-hydrating on every one of those would reopen the server-wins
    // clobber window against the debounced save on every session switch,
    // not just once per page load (review finding).
    store().ensureWorkspace('ses-1', scope());
    const { unmount } = renderHook(() => useWorkspaceServerSync('ses-1'));
    await waitFor(() => expect(getCalls()).toHaveLength(1));

    unmount();
    renderHook(() => useWorkspaceServerSync('ses-1'));
    await new Promise((r) => setTimeout(r, 0));

    expect(getCalls()).toHaveLength(1);
  });

  it('given a DIFFERENT session, still hydrates on its own first mount', async () => {
    store().ensureWorkspace('ses-1', scope());
    renderHook(() => useWorkspaceServerSync('ses-1'));
    await waitFor(() => expect(getCalls()).toHaveLength(1));

    store().ensureWorkspace('ses-2', scope());
    renderHook(() => useWorkspaceServerSync('ses-2'));
    await waitFor(() => expect(getCalls()).toHaveLength(2));
  });

  it('a hydration cancelled by unmount before it resolves is retried on the next mount', async () => {
    store().ensureWorkspace('ses-1', scope());
    let resolveFetch!: (value: unknown) => void;
    mockFetch.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));

    const { unmount } = renderHook(() => useWorkspaceServerSync('ses-1'));
    unmount();
    // The first fetch's `.then` fires with `cancelled: true` — must not mark
    // the session hydrated, or a genuinely-never-hydrated session would be
    // stuck that way for the rest of the page's life.
    resolveFetch({ ok: true, json: () => Promise.resolve({ workspace: null }) });
    await new Promise((r) => setTimeout(r, 0));

    mockFetch.mockResolvedValue(notSaved);
    renderHook(() => useWorkspaceServerSync('ses-1'));
    await waitFor(() => expect(getCalls()).toHaveLength(2));
  });
});

describe('debounced save', () => {
  it('does not save on every transition — only once, after activity settles', async () => {
    vi.useFakeTimers();
    store().ensureWorkspace('ses-1', scope());
    renderHook(() => useWorkspaceServerSync('ses-1', { debounceMs: 1000 }));

    const paneId = grid().activePaneId;
    act(() => {
      store().splitRight('ses-1', paneId);
    });
    act(() => {
      store().splitDown('ses-1', paneId);
    });

    // Neither transition alone should have fired a PUT yet.
    const putCallsBeforeSettle = mockFetch.mock.calls.filter((c) => c[1]?.method === 'PUT').length;
    expect(putCallsBeforeSettle).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    const putCalls = mockFetch.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(putCalls).toHaveLength(1);
    const [, init] = putCalls[0];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.workspace).toEqual(grid());
  });

  it('keeps a save pending after a non-2xx response, instead of treating it as delivered', async () => {
    vi.useFakeTimers();
    store().ensureWorkspace('ses-1', scope());
    mockFetch.mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve({}) });

    const { unmount } = renderHook(() => useWorkspaceServerSync('ses-1', { debounceMs: 1000 }));

    const paneId = grid().activePaneId;
    act(() => {
      store().splitRight('ses-1', paneId);
    });

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(mockFetch.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(1);

    // The rejected save left `pendingRef` populated — unmount must still
    // flush it (a silently "cleared" pending ref would skip this retry).
    unmount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockFetch.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(2);
  });

  it('does not redundantly PUT the value hydration itself just wrote', async () => {
    vi.useFakeTimers();
    store().ensureWorkspace('ses-1', scope());
    const saved = {
      id: 'ses-1',
      columns: [{ id: 'col-x', panes: [{ id: 'pane-x', scope: scope('conv-saved'), tabs: [scope('conv-saved')] }] }],
      activePaneId: 'pane-x',
      pendingPickerPaneId: null,
    };
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ workspace: saved }) });

    renderHook(() => useWorkspaceServerSync('ses-1', { debounceMs: 1000 }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(grid()).toEqual(saved);

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    const putCalls = mockFetch.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });
});

describe('unmount', () => {
  it('force-flushes a pending save rather than dropping it', async () => {
    store().ensureWorkspace('ses-1', scope());
    const { unmount } = renderHook(() => useWorkspaceServerSync('ses-1', { debounceMs: 60_000 }));

    const paneId = grid().activePaneId;
    act(() => {
      store().splitRight('ses-1', paneId);
    });
    const latest = grid();

    unmount();
    await new Promise((r) => setTimeout(r, 0));

    const putCalls = mockFetch.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(putCalls).toHaveLength(1);
    expect(JSON.parse(putCalls[0][1].body as string).workspace).toEqual(latest);
  });

  it('given nothing pending (the last save already settled), does not PUT again on unmount', async () => {
    vi.useFakeTimers();
    store().ensureWorkspace('ses-1', scope());
    const { unmount } = renderHook(() => useWorkspaceServerSync('ses-1', { debounceMs: 1000 }));

    // Let the initial mount's own scheduled save actually fire and clear
    // `pendingRef` — only THEN is "nothing pending" a true premise.
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    mockFetch.mockClear();

    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetch.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(0);
  });

  it('flushes a pending save when disabled mid-session, not only on unmount', async () => {
    store().ensureWorkspace('ses-1', scope());
    const { rerender } = renderHook(({ enabled }: { enabled: boolean }) => useWorkspaceServerSync('ses-1', { debounceMs: 60_000, enabled }), {
      initialProps: { enabled: true },
    });

    const paneId = grid().activePaneId;
    act(() => {
      store().splitRight('ses-1', paneId);
    });
    const latest = grid();

    rerender({ enabled: false });
    await new Promise((r) => setTimeout(r, 0));

    const putCalls = mockFetch.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(putCalls).toHaveLength(1);
    expect(JSON.parse(putCalls[0][1].body as string).workspace).toEqual(latest);
  });
});
