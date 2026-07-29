/**
 * The Agents surface's selection store.
 *
 * Three properties, and every test here is one of them:
 *
 * 1. **Selection never navigates.** Every transition mirrors to the URL with
 *    `history.pushState` and NOTHING else — no `router.push`, no route change,
 *    so no remount. This is the whole reason the Development surface's
 *    keep-alive host has no successor: a live PTY or a streaming chat cannot be
 *    torn down by clicking a sidebar row if clicking a sidebar row doesn't
 *    navigate.
 * 2. **The URL is the state.** A deep link, a refresh, and a Back button all
 *    reach identical state through the same `hydrateFromSearch` — there is no
 *    in-memory selection the URL can't reconstruct.
 * 3. **Selecting closes the mobile sheet.** Selection used to navigate, and
 *    navigation closed the sheet for free; now nothing does unless this does.
 */
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { useAgentSurfaceStore } from '../useAgentSurfaceStore';
import { useLayoutStore } from '@/stores/useLayoutStore';

const resetStore = () => {
  useAgentSurfaceStore.setState({ driveId: null, selectedAgentId: null, selectedConversationId: null });
};

const setLocation = (url: string) => {
  window.history.replaceState({}, '', url);
};

/** The last URL `pushState` was asked to write. */
const lastPushedUrl = (spy: ReturnType<typeof vi.spyOn>): string | undefined => {
  const calls = spy.mock.calls;
  return calls.length ? (calls[calls.length - 1][2] as string) : undefined;
};

let pushSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetStore();
  setLocation('/dashboard/agents');
  useLayoutStore.setState({ leftSheetOpen: true });
  pushSpy = vi.spyOn(window.history, 'pushState');
  // Desktop by default; the sheet-breakpoint tests opt in.
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hydrateFromSearch', () => {
  test('a deep link becomes the selection', () => {
    setLocation('/dashboard/agents?agent=agent-1&c=conv-1');
    useAgentSurfaceStore.getState().hydrateFromSearch();
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
  });

  test('reads the live location when given no explicit search', () => {
    // What the `popstate` handler does: the browser has already changed the URL
    // by the time the event fires, so the store reads it rather than being told.
    setLocation('/dashboard/agents?agent=agent-2');
    useAgentSurfaceStore.getState().hydrateFromSearch();
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-2');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBeNull();
  });

  test('accepts an explicit search string', () => {
    useAgentSurfaceStore.getState().hydrateFromSearch({ search: '?agent=agent-3&c=conv-3' });
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-3');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-3');
  });

  test('records the drive the surface is mounted under', () => {
    useAgentSurfaceStore.getState().hydrateFromSearch({ driveId: 'drive-1', search: '?agent=agent-1' });
    expect(useAgentSurfaceStore.getState().driveId).toBe('drive-1');
  });

  test('never writes history — hydrating is reading, not selecting', () => {
    // Critical for `popstate`: pushing during hydration would append a NEW entry
    // for the entry the user just went Back to, and Back would stop working.
    setLocation('/dashboard/agents?agent=agent-1&c=conv-1');
    useAgentSurfaceStore.getState().hydrateFromSearch();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  test('clears a selection the URL no longer carries', () => {
    // Back out of a selection: the state must follow the URL down, not keep the
    // stale id.
    useAgentSurfaceStore.setState({ selectedAgentId: 'agent-1', selectedConversationId: 'conv-1' });
    useAgentSurfaceStore.getState().hydrateFromSearch({ search: '' });
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBeNull();
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBeNull();
  });

  test('a malformed URL hydrates to the empty selection instead of throwing', () => {
    expect(() => useAgentSurfaceStore.getState().hydrateFromSearch({ search: '?%' })).not.toThrow();
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBeNull();
  });
});

describe('selectAgent', () => {
  test('selects the agent and mirrors it to the URL', () => {
    useAgentSurfaceStore.getState().selectAgent('agent-1');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
    expect(lastPushedUrl(pushSpy)).toBe('/dashboard/agents?agent=agent-1');
  });

  test('clears the conversation — a different agent is a different subject', () => {
    useAgentSurfaceStore.setState({ selectedAgentId: 'agent-1', selectedConversationId: 'conv-1' });
    useAgentSurfaceStore.getState().selectAgent('agent-2');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBeNull();
    expect(lastPushedUrl(pushSpy)).toBe('/dashboard/agents?agent=agent-2');
  });

  test('re-selecting the same agent keeps its conversation and writes no history entry', () => {
    // Clicking the row you're already on must not throw away the open
    // conversation, and must not stack duplicate Back entries.
    useAgentSurfaceStore.setState({ selectedAgentId: 'agent-1', selectedConversationId: 'conv-1' });
    setLocation('/dashboard/agents?agent=agent-1&c=conv-1');
    useAgentSurfaceStore.getState().selectAgent('agent-1');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
    expect(pushSpy).not.toHaveBeenCalled();
  });

  test('deselecting clears both and returns to the bare surface URL', () => {
    useAgentSurfaceStore.setState({ selectedAgentId: 'agent-1', selectedConversationId: 'conv-1' });
    setLocation('/dashboard/agents?agent=agent-1&c=conv-1');
    useAgentSurfaceStore.getState().selectAgent(null);
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBeNull();
    expect(lastPushedUrl(pushSpy)).toBe('/dashboard/agents');
  });

  test('stays inside the drive-scoped surface when mounted under a drive', () => {
    useAgentSurfaceStore.setState({ driveId: 'drive-1' });
    useAgentSurfaceStore.getState().selectAgent('agent-1');
    expect(lastPushedUrl(pushSpy)).toBe('/dashboard/drive-1/agents?agent=agent-1');
  });
});

describe('selectConversation', () => {
  test('selects the conversation under the current agent', () => {
    useAgentSurfaceStore.setState({ selectedAgentId: 'agent-1' });
    useAgentSurfaceStore.getState().selectConversation('conv-1');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
    expect(lastPushedUrl(pushSpy)).toBe('/dashboard/agents?agent=agent-1&c=conv-1');
  });

  test('adopts the agent the row belongs to', () => {
    // A conversation row in the tree knows its agent; passing it means clicking
    // a conversation under a different agent selects both in one transition
    // (and one history entry), never leaving the two params disagreeing.
    useAgentSurfaceStore.setState({ selectedAgentId: 'agent-1' });
    useAgentSurfaceStore.getState().selectConversation('conv-9', 'agent-9');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-9');
    expect(lastPushedUrl(pushSpy)).toBe('/dashboard/agents?agent=agent-9&c=conv-9');
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  test('a conversation with no agent is a valid selection', () => {
    // The global assistant has no agent page (`agentPageId: null`).
    useAgentSurfaceStore.getState().selectConversation('conv-1', null);
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBeNull();
    expect(lastPushedUrl(pushSpy)).toBe('/dashboard/agents?c=conv-1');
  });

  test('re-selecting the open conversation writes no history entry', () => {
    useAgentSurfaceStore.setState({ selectedAgentId: 'agent-1', selectedConversationId: 'conv-1' });
    setLocation('/dashboard/agents?agent=agent-1&c=conv-1');
    useAgentSurfaceStore.getState().selectConversation('conv-1', 'agent-1');
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

describe('URL mirroring', () => {
  test('every selection round-trips through the URL alone', () => {
    // Property 2, stated directly: what a refresh reconstructs is exactly what
    // was in memory before it.
    const transitions: Array<() => void> = [
      () => useAgentSurfaceStore.getState().selectAgent('agent-1'),
      () => useAgentSurfaceStore.getState().selectConversation('conv-1'),
      () => useAgentSurfaceStore.getState().selectAgent('agent-2'),
      () => useAgentSurfaceStore.getState().selectConversation('conv-2', 'agent-2'),
      () => useAgentSurfaceStore.getState().selectAgent(null),
    ];

    for (const transition of transitions) {
      transition();
      const { selectedAgentId, selectedConversationId } = useAgentSurfaceStore.getState();
      const written = lastPushedUrl(pushSpy) ?? window.location.pathname;
      // Simulate the refresh: land on the written URL with an empty store.
      setLocation(written);
      resetStore();
      useAgentSurfaceStore.getState().hydrateFromSearch();
      expect(useAgentSurfaceStore.getState().selectedAgentId).toBe(selectedAgentId);
      expect(useAgentSurfaceStore.getState().selectedConversationId).toBe(selectedConversationId);
      // Put the state back so the next transition starts from where it left off.
      useAgentSurfaceStore.setState({ selectedAgentId, selectedConversationId });
    }
  });

  test('writes history and nothing else — selection is not navigation', () => {
    const replaceSpy = vi.spyOn(window.history, 'replaceState');
    useAgentSurfaceStore.getState().selectAgent('agent-1');
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});

describe('mobile sheet', () => {
  const asSheetBreakpoint = () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('1023px'),
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
  };

  test('selecting an agent closes the left sheet on a narrow viewport', () => {
    asSheetBreakpoint();
    useAgentSurfaceStore.getState().selectAgent('agent-1');
    expect(useLayoutStore.getState().leftSheetOpen).toBe(false);
  });

  test('selecting a conversation closes the left sheet on a narrow viewport', () => {
    asSheetBreakpoint();
    useAgentSurfaceStore.getState().selectConversation('conv-1', 'agent-1');
    expect(useLayoutStore.getState().leftSheetOpen).toBe(false);
  });

  test('leaves the sidebar alone on a wide viewport', () => {
    // On desktop the sidebar is permanent furniture, not a sheet — closing it
    // would hide the tree the user is browsing.
    useAgentSurfaceStore.getState().selectAgent('agent-1');
    expect(useLayoutStore.getState().leftSheetOpen).toBe(true);
  });

  test('hydration does not close the sheet', () => {
    // Deep-linking into a conversation is not a click; the user may have opened
    // the sheet deliberately after landing.
    asSheetBreakpoint();
    useAgentSurfaceStore.getState().hydrateFromSearch({ search: '?agent=agent-1&c=conv-1' });
    expect(useLayoutStore.getState().leftSheetOpen).toBe(true);
  });
});
