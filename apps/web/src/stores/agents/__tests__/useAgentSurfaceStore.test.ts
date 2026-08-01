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
 *
 * The selection is session-first: `session` addresses the workspace, `c` the
 * conversation inside it, `agent` the conversation's agent page (the pane
 * grid's render seed). Sessions own conversations — so switching SESSIONS
 * clears the conversation, while selecting a conversation always names all
 * three so one click is one transition.
 */
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { useAgentSurfaceStore } from '../useAgentSurfaceStore';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useTabsStore } from '@/stores/useTabsStore';

const resetStore = () => {
  useAgentSurfaceStore.setState({
    driveId: null,
    selectedSessionId: null,
    selectedConversationId: null,
    selectedAgentId: null,
  });
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
    setLocation('/dashboard/agents?session=ses-1&c=conv-1&agent=agent-1');
    useAgentSurfaceStore.getState().hydrateFromSearch();
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
  });

  test('reads the live location when given no explicit search', () => {
    // What the `popstate` handler does: the browser has already changed the URL
    // by the time the event fires, so the store reads it rather than being told.
    setLocation('/dashboard/agents?session=ses-2');
    useAgentSurfaceStore.getState().hydrateFromSearch();
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-2');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBeNull();
  });

  test('accepts an explicit search string', () => {
    useAgentSurfaceStore.getState().hydrateFromSearch({ search: '?session=ses-3&c=conv-3&agent=agent-3' });
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-3');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-3');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-3');
  });

  test('records the drive the surface is mounted under', () => {
    useAgentSurfaceStore.getState().hydrateFromSearch({ driveId: 'drive-1', search: '?session=ses-1' });
    expect(useAgentSurfaceStore.getState().driveId).toBe('drive-1');
  });

  test('a bare re-read keeps the drive scope', () => {
    // `popstate` hydrates without naming the drive; that must not silently
    // reset the surface to global mode.
    useAgentSurfaceStore.getState().hydrateFromSearch({ driveId: 'drive-1', search: '?session=ses-1' });
    useAgentSurfaceStore.getState().hydrateFromSearch({ search: '?session=ses-2' });
    expect(useAgentSurfaceStore.getState().driveId).toBe('drive-1');
  });

  test('never writes history — hydrating is reading, not selecting', () => {
    // Critical for `popstate`: pushing during hydration would append a NEW entry
    // for the entry the user just went Back to, and Back would stop working.
    setLocation('/dashboard/agents?session=ses-1&c=conv-1');
    useAgentSurfaceStore.getState().hydrateFromSearch();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  test('clears a selection the URL no longer carries', () => {
    // Back out of a selection: the state must follow the URL down, not keep the
    // stale ids.
    useAgentSurfaceStore.setState({
      selectedSessionId: 'ses-1',
      selectedConversationId: 'conv-1',
      selectedAgentId: 'agent-1',
    });
    useAgentSurfaceStore.getState().hydrateFromSearch({ search: '' });
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBeNull();
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBeNull();
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBeNull();
  });

  test('a malformed URL hydrates to the empty selection instead of throwing', () => {
    expect(() => useAgentSurfaceStore.getState().hydrateFromSearch({ search: '?%' })).not.toThrow();
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBeNull();
  });
});

describe('selectSession', () => {
  test('selects the session and mirrors it to the URL', () => {
    useAgentSurfaceStore.getState().selectSession('ses-1');
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
    expect(lastPushedUrl(pushSpy)).toBe('/dashboard/agents?session=ses-1');
  });

  test('clears the conversation — it belonged to the old workspace', () => {
    useAgentSurfaceStore.setState({
      selectedSessionId: 'ses-1',
      selectedConversationId: 'conv-1',
      selectedAgentId: 'agent-1',
    });
    useAgentSurfaceStore.getState().selectSession('ses-2');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBeNull();
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBeNull();
    expect(lastPushedUrl(pushSpy)).toBe('/dashboard/agents?session=ses-2');
  });

  test('re-selecting the open session keeps its conversation and writes no history entry', () => {
    // Clicking the row you're already on must not throw away the open
    // conversation, and must not stack duplicate Back entries.
    useAgentSurfaceStore.setState({
      selectedSessionId: 'ses-1',
      selectedConversationId: 'conv-1',
      selectedAgentId: 'agent-1',
    });
    setLocation('/dashboard/agents?session=ses-1&c=conv-1&agent=agent-1');
    useAgentSurfaceStore.getState().selectSession('ses-1');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
    expect(pushSpy).not.toHaveBeenCalled();
  });

  test('deselecting clears everything and returns to the bare surface URL', () => {
    // What the pane grid calls after ending a session (last pane closed).
    useAgentSurfaceStore.setState({
      selectedSessionId: 'ses-1',
      selectedConversationId: 'conv-1',
      selectedAgentId: 'agent-1',
    });
    setLocation('/dashboard/agents?session=ses-1&c=conv-1&agent=agent-1');
    useAgentSurfaceStore.getState().selectSession(null);
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBeNull();
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBeNull();
    expect(lastPushedUrl(pushSpy)).toBe('/dashboard/agents');
  });

  test('stays inside the drive-scoped surface when mounted under a drive', () => {
    useAgentSurfaceStore.setState({ driveId: 'drive-1' });
    useAgentSurfaceStore.getState().selectSession('ses-1');
    expect(lastPushedUrl(pushSpy)).toBe('/dashboard/drive-1/agents?session=ses-1');
  });
});

describe('selectConversation', () => {
  test('selects session, conversation and agent as one transition', () => {
    useAgentSurfaceStore.getState().selectConversation({
      sessionId: 'ses-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
    });
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
    expect(lastPushedUrl(pushSpy)).toBe('/dashboard/agents?session=ses-1&c=conv-1&agent=agent-1');
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  test('adopts the session the conversation belongs to', () => {
    // A conversation row in the tree knows its session; clicking one under a
    // DIFFERENT session selects both in one transition (one history entry),
    // never leaving the params disagreeing.
    useAgentSurfaceStore.setState({ selectedSessionId: 'ses-1' });
    useAgentSurfaceStore.getState().selectConversation({
      sessionId: 'ses-9',
      conversationId: 'conv-9',
      agentId: 'agent-9',
    });
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-9');
    expect(lastPushedUrl(pushSpy)).toBe('/dashboard/agents?session=ses-9&c=conv-9&agent=agent-9');
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  test('a conversation with no agent is a valid selection', () => {
    // The global assistant has no agent page (`agentPageId: null`).
    useAgentSurfaceStore.getState().selectConversation({
      sessionId: 'ses-1',
      conversationId: 'conv-1',
      agentId: null,
    });
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBeNull();
    expect(lastPushedUrl(pushSpy)).toBe('/dashboard/agents?session=ses-1&c=conv-1');
  });

  test('re-selecting the open conversation writes no history entry', () => {
    useAgentSurfaceStore.setState({
      selectedSessionId: 'ses-1',
      selectedConversationId: 'conv-1',
      selectedAgentId: 'agent-1',
    });
    setLocation('/dashboard/agents?session=ses-1&c=conv-1&agent=agent-1');
    useAgentSurfaceStore.getState().selectConversation({
      sessionId: 'ses-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
    });
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

describe('URL mirroring', () => {
  test('every selection round-trips through the URL alone', () => {
    // Property 2, stated directly: what a refresh reconstructs is exactly what
    // was in memory before it.
    const transitions: Array<() => void> = [
      () => useAgentSurfaceStore.getState().selectSession('ses-1'),
      () =>
        useAgentSurfaceStore
          .getState()
          .selectConversation({ sessionId: 'ses-1', conversationId: 'conv-1', agentId: 'agent-1' }),
      () => useAgentSurfaceStore.getState().selectSession('ses-2'),
      () =>
        useAgentSurfaceStore
          .getState()
          .selectConversation({ sessionId: 'ses-2', conversationId: 'conv-2', agentId: null }),
      () => useAgentSurfaceStore.getState().selectSession(null),
    ];

    for (const transition of transitions) {
      transition();
      const { selectedSessionId, selectedConversationId, selectedAgentId } = useAgentSurfaceStore.getState();
      const written = lastPushedUrl(pushSpy) ?? window.location.pathname;
      // Simulate the refresh: land on the written URL with an empty store.
      setLocation(written);
      resetStore();
      useAgentSurfaceStore.getState().hydrateFromSearch();
      expect(useAgentSurfaceStore.getState().selectedSessionId).toBe(selectedSessionId);
      expect(useAgentSurfaceStore.getState().selectedConversationId).toBe(selectedConversationId);
      expect(useAgentSurfaceStore.getState().selectedAgentId).toBe(selectedAgentId);
      // Put the state back so the next transition starts from where it left off.
      useAgentSurfaceStore.setState({ selectedSessionId, selectedConversationId, selectedAgentId });
    }
  });

  test('writes history and nothing else — selection is not navigation', () => {
    const replaceSpy = vi.spyOn(window.history, 'replaceState');
    useAgentSurfaceStore.getState().selectSession('ses-1');
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});

describe('tab sync', () => {
  // `commit()` writes the URL with a raw `pushState`, which Next's router (and
  // therefore `useTabSync`) never sees — so this is the one call site that must
  // keep the browser-style tab bar's record of this tab's address truthful,
  // otherwise switching tabs away and back lands on the bare route.
  beforeEach(() => {
    useTabsStore.setState({ tabs: [], activeTabId: null });
    useTabsStore.getState().createTab({ path: '/dashboard/agents' });
  });

  const activeTabSearch = () => {
    const { tabs, activeTabId } = useTabsStore.getState();
    return tabs.find((t) => t.id === activeTabId)?.search;
  };

  test('selecting a session updates the active tab', () => {
    useAgentSurfaceStore.getState().selectSession('ses-1');
    expect(activeTabSearch()).toBe('session=ses-1');
  });

  test('selecting a conversation updates the active tab', () => {
    useAgentSurfaceStore.getState().selectConversation({
      sessionId: 'ses-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
    });
    expect(activeTabSearch()).toBe('session=ses-1&c=conv-1&agent=agent-1');
  });

  test('re-selecting the same session (a no-op push) leaves the active tab search untouched', () => {
    useAgentSurfaceStore.getState().selectSession('ses-1');
    setLocation('/dashboard/agents?session=ses-1');
    const tabsBefore = useTabsStore.getState().tabs;
    useAgentSurfaceStore.getState().selectSession('ses-1');
    expect(useTabsStore.getState().tabs).toBe(tabsBefore);
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

  test('selecting a session closes the left sheet on a narrow viewport', () => {
    asSheetBreakpoint();
    useAgentSurfaceStore.getState().selectSession('ses-1');
    expect(useLayoutStore.getState().leftSheetOpen).toBe(false);
  });

  test('selecting a conversation closes the left sheet on a narrow viewport', () => {
    asSheetBreakpoint();
    useAgentSurfaceStore.getState().selectConversation({
      sessionId: 'ses-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
    });
    expect(useLayoutStore.getState().leftSheetOpen).toBe(false);
  });

  test('leaves the sidebar alone on a wide viewport', () => {
    // On desktop the sidebar is permanent furniture, not a sheet — closing it
    // would hide the tree the user is browsing.
    useAgentSurfaceStore.getState().selectSession('ses-1');
    expect(useLayoutStore.getState().leftSheetOpen).toBe(true);
  });

  test('hydration does not close the sheet', () => {
    // Deep-linking into a conversation is not a click; the user may have opened
    // the sheet deliberately after landing.
    asSheetBreakpoint();
    useAgentSurfaceStore.getState().hydrateFromSearch({ search: '?session=ses-1&c=conv-1&agent=agent-1' });
    expect(useLayoutStore.getState().leftSheetOpen).toBe(true);
  });
});
