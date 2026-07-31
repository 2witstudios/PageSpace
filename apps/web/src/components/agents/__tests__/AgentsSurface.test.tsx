/**
 * The console shell.
 *
 * Two structural properties and one rendering contract:
 *
 * - It hydrates its selection from the URL on mount (deep link, refresh),
 *   reactively on any Next-router-driven change to the query string on this
 *   SAME route (`useSearchParams()` — e.g. reactivating a different tab that
 *   also points here), and on `popstate` (Back/Forward, including one
 *   restoring a raw `history.pushState` entry Next's router never saw).
 *   Together those are what let selection live in the query string instead of
 *   the route, which is what lets this component stay mounted through every
 *   click.
 * - The centre is the SESSION's pane grid, keyed by the session id — switching
 *   sessions swaps the grid; nothing else about the shell changes.
 */
import { useRef } from 'react';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

// The global setup mock's `useSearchParams` is a static empty stub — fine for
// most tests, but this surface now reads it reactively (see AgentsSurface.tsx),
// and these tests drive scenarios entirely through `window.history.replaceState`.
// Override it here to read the CURRENT location, same shape as the real hook.
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  usePathname: vi.fn(() => window.location.pathname),
  useSearchParams: vi.fn(() => new URLSearchParams(window.location.search)),
}));

vi.mock('../panes/AgentPanes', () => ({
  default: function MockAgentPanes({
    sessionId,
    driveId,
    initialConversation,
    onConversationClosed,
  }: {
    sessionId: string;
    driveId: string | null;
    initialConversation: { conversationId: string; agentPageId: string | null };
    onConversationClosed?: (event: { conversationId: string; next: string | null; nextAgentPageId: string | null }) => void;
  }) {
    // Captured ONCE, on this component's first render — models the closure a
    // real in-flight `closeConversationListing` call would hold, unaffected
    // by whatever `onConversationClosed` the surface passes down on a LATER
    // render (e.g. after the user picks a different conversation while the
    // close DELETE is still pending).
    const staleOnConversationClosed = useRef(onConversationClosed).current;
    return (
      <div data-testid="agent-panes" data-drive-id={driveId ?? 'none'}>
        {sessionId}/{initialConversation.conversationId}/{initialConversation.agentPageId ?? 'no-agent'}
        <button
          type="button"
          data-testid="fire-conversation-closed-rebind"
          onClick={() =>
            onConversationClosed?.({
              conversationId: initialConversation.conversationId,
              next: 'conv-next',
              nextAgentPageId: 'agent-next',
            })
          }
        />
        <button
          type="button"
          data-testid="fire-conversation-closed-no-rebind"
          onClick={() =>
            onConversationClosed?.({ conversationId: initialConversation.conversationId, next: null, nextAgentPageId: null })
          }
        />
        <button
          type="button"
          data-testid="fire-conversation-closed-unrelated"
          onClick={() => onConversationClosed?.({ conversationId: 'conv-other', next: 'conv-next', nextAgentPageId: 'agent-next' })}
        />
        <button
          type="button"
          data-testid="fire-conversation-closed-stale"
          onClick={() =>
            staleOnConversationClosed?.({ conversationId: 'conv-1', next: 'conv-next', nextAgentPageId: 'agent-next' })
          }
        />
      </div>
    );
  },
}));

const mockFetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const mockLoadConversation = vi.hoisted(() => vi.fn());
vi.mock('@/contexts/GlobalChatContext', () => ({
  useGlobalChatConversation: () => ({ loadConversation: mockLoadConversation }),
}));

const mockToastInfo = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { info: mockToastInfo, error: vi.fn() } }));

import AgentsSurface from '../AgentsSurface';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';

/** Empty by default — the "no history yet" case is the common one across these tests; individual tests override with `mockFetchWithAuth.mockImplementation`. */
const EMPTY_CONVERSATIONS = { conversations: [], pagination: { hasMore: false, nextCursor: null, limit: 20 } };

beforeEach(() => {
  // Two different endpoints share this mock — route by URL rather than one
  // blanket response, since a session-fetch shape and a conversations-list
  // shape are never interchangeable.
  mockFetchWithAuth.mockImplementation(async (url: string) => {
    if (url.includes('/api/agent-sessions/conversations')) {
      return { ok: true, json: async () => EMPTY_CONVERSATIONS };
    }
    // A selected session exists by default — the tests that care about a GONE
    // session (finding 6's GC) set their own `{ session: null }` response.
    return { ok: true, json: async () => ({ session: { driveId: null } }) };
  });
  window.history.replaceState({}, '', '/dashboard/agents');
  useAgentSurfaceStore.setState({
    driveId: null,
    selectedSessionId: null,
    selectedConversationId: null,
    selectedAgentId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentsSurface', () => {
  test('hydrates the selection from a deep link on mount', () => {
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-1&c=conv-1&agent=agent-1');

    render(<AgentsSurface />);

    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
  });

  test('records the drive it is mounted under, so selections stay in this surface', () => {
    render(<AgentsSurface driveId="drive-1" />);
    expect(useAgentSurfaceStore.getState().driveId).toBe('drive-1');
  });

  test('the global surface has no drive scope', () => {
    useAgentSurfaceStore.setState({ driveId: 'stale-drive' });
    render(<AgentsSurface />);
    expect(useAgentSurfaceStore.getState().driveId).toBeNull();
  });

  test('re-hydrates on Back — the browser restores the URL, the store follows it', () => {
    render(<AgentsSurface />);

    act(() => {
      window.history.replaceState({}, '', '/dashboard/agents?session=ses-2&c=conv-2');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-2');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-2');
  });

  test('re-hydrates on a same-route query change with no popstate and no remount (caught in review, P2)', () => {
    // What reactivating a DIFFERENT tab that also points at this pathname does:
    // `router.push` changes only the query string, so nothing here remounts and
    // no popstate fires — only `useSearchParams()` changing. Before this fix the
    // panes kept showing whichever tab's selection was hydrated last.
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-1&c=conv-1&agent=agent-1');
    const { rerender } = render(<AgentsSurface />);
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');

    act(() => {
      window.history.replaceState({}, '', '/dashboard/agents?session=ses-2&c=conv-2&agent=agent-2');
    });
    rerender(<AgentsSurface />);

    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-2');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-2');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-2');
  });

  test('stops listening for popstate once unmounted', () => {
    const { unmount } = render(<AgentsSurface />);
    unmount();

    act(() => {
      window.history.replaceState({}, '', '/dashboard/agents?session=ses-3');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(useAgentSurfaceStore.getState().selectedSessionId).toBeNull();
  });

  test('prompts for a selection when nothing is open', () => {
    render(<AgentsSurface />);
    expect(screen.getByText('Select a session')).toBeDefined();
  });

  test('a session with no conversation is the degenerate deep link, not the grid', () => {
    // The sidebar always writes session AND conversation together; only a
    // hand-trimmed URL lands here. It must render a prompt, never a
    // speculative pane grid for a conversation that isn't named.
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-1');
    render(<AgentsSurface />);
    expect(screen.getByText('Pick a conversation')).toBeDefined();
    expect(screen.queryByTestId('agent-panes')).toBeNull();
  });

  test('renders the pane grid, keyed by the session, once a conversation is selected', () => {
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-1&c=conv-1&agent=agent-1');
    render(<AgentsSurface />);
    expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-1/conv-1/agent-1');
  });

  test('a conversation with no agent still renders the grid', () => {
    // Global-assistant conversations have no agent page; the grid (not this
    // shell) owns what that pane shows.
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-1&c=conv-1');
    render(<AgentsSurface />);
    expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-1/conv-1/no-agent');
  });
});

describe('GC when the server says the session is gone (issue #2263, finding 6)', () => {
  beforeEach(() => {
    useAgentWorkspaceStore.setState({ workspaces: {} });
  });

  it('forgets the persisted grid and backs out to the empty state', async () => {
    mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ session: null }) });
    useAgentWorkspaceStore.getState().ensureWorkspace('ses-gone', {
      kind: 'chat',
      name: 'x',
      targetId: 'conv-1',
      agentPageId: 'agent-1',
    });
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-gone&c=conv-1&agent=agent-1');

    render(<AgentsSurface />);

    await waitFor(() => expect(useAgentSurfaceStore.getState().selectedSessionId).toBeNull());
    expect(useAgentWorkspaceStore.getState().workspaces['ses-gone']).toBeUndefined();
    expect(screen.getByText('Select a session')).toBeDefined();
  });

  it('a session the server confirms exists is left untouched', async () => {
    mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ session: { driveId: null } }) });
    useAgentWorkspaceStore.getState().ensureWorkspace('ses-live', {
      kind: 'chat',
      name: 'x',
      targetId: 'conv-1',
      agentPageId: 'agent-1',
    });
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-live&c=conv-1&agent=agent-1');

    render(<AgentsSurface />);

    await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-live');
    expect(useAgentWorkspaceStore.getState().workspaces['ses-live']).toBeDefined();
  });
});

describe('the grid gets the SESSION\'s drive, not the surface\'s (review M5)', () => {
  it('in global mode, a drive session\'s picker still knows its drive', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ session: { driveId: 'drive-7' } }),
    });
    // A session id no earlier test fetched — SWR's cache is module-global and
    // this key's first answer would otherwise win for 30s.
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-m5&c=conv-1&agent=agent-1');
    render(<AgentsSurface />);

    await waitFor(() =>
      expect(screen.getByTestId('agent-panes')).toHaveAttribute('data-drive-id', 'drive-7'),
    );
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/agent-sessions/ses-m5');
  });

  it('does not mount the grid as global while the session record is still unresolved', async () => {
    // On the global route, `storeDriveId` is null — the same value a
    // CONFIRMED global session's driveId legitimately has. `AgentPanes`
    // treats `driveId === null` as "show every accessible agent", so
    // mounting it with that fallback DURING the loading window would offer
    // a drive session's picker agents it doesn't actually have, and picking
    // one would hit the server's cross-drive gate and 400 (caught in
    // review — chatgpt-codex-connector, P2).
    let resolveSession!: (value: { ok: true; json: () => Promise<{ session: { driveId: string } }> }) => void;
    mockFetchWithAuth.mockReturnValue(new Promise((resolve) => (resolveSession = resolve)));
    // A session id no earlier test fetched — SWR's cache is module-global.
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-unresolved&c=conv-1&agent=agent-1');
    render(<AgentsSurface />);

    // Still unresolved: the grid must not be mounted at all (neither as
    // "global" nor with any other guessed driveId) — a loading state, not a
    // wrong one.
    expect(screen.queryByTestId('agent-panes')).toBeNull();

    resolveSession({ ok: true, json: async () => ({ session: { driveId: 'drive-9' } }) });

    await waitFor(() =>
      expect(screen.getByTestId('agent-panes')).toHaveAttribute('data-drive-id', 'drive-9'),
    );
  });
});

describe('onConversationClosed — following the grid\'s own close/rebind', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-1&c=conv-1&agent=agent-1');
    useAgentSurfaceStore.getState().hydrateFromSearch();
  });

  it('follows a rebind of the CURRENTLY selected conversation', async () => {
    const { getByTestId } = render(<AgentsSurface />);
    await waitFor(() => expect(getByTestId('agent-panes')).toBeInTheDocument());

    act(() => getByTestId('fire-conversation-closed-rebind').click());

    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-next');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-next');
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
  });

  it('clears the selection when there was nothing to rebind to and no other chat pane remains', async () => {
    // Keeping the closed id would risk silently reopening it (or hiding a
    // still-open listing elsewhere with no pane here) on the next refresh
    // or deep link — showing "pick a conversation" is honest instead
    // (caught in review; the first pass here left this case untouched).
    const { getByTestId } = render(<AgentsSurface />);
    await waitFor(() => expect(getByTestId('agent-panes')).toBeInTheDocument());

    act(() => getByTestId('fire-conversation-closed-no-rebind').click());

    expect(useAgentSurfaceStore.getState().selectedConversationId).toBeNull();
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
  });

  it('retargets to another OPEN chat pane when an ordinary (non-grid-last) close drops the SELECTED conversation', async () => {
    // `next: null` isn't only for "nothing to rebind to" — it's also what an
    // ORDINARY close reports when the grid still has other panes (rebinding
    // only matters for an emptied grid). Left alone, the surface's own
    // selection (and the URL it mirrors to) would keep naming a conversation
    // with no listing left — a refresh or deep link back to this URL would
    // reopen it, silently replacing whatever pane is actually live (caught
    // in review).
    useAgentWorkspaceStore.getState().ensureWorkspace('ses-1', {
      kind: 'chat',
      name: 'Conversation',
      targetId: 'conv-1',
      agentPageId: 'agent-1',
    });
    const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
    useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId);
    const secondPaneId = useAgentWorkspaceStore
      .getState()
      .workspaces['ses-1'].columns.flatMap((c) => c.panes)
      .find((p) => p.id !== firstPaneId)!.id;
    useAgentWorkspaceStore.getState().assignPane('ses-1', secondPaneId, {
      kind: 'chat',
      name: 'Conversation',
      targetId: 'conv-2',
      agentPageId: 'agent-2',
    });

    const { getByTestId } = render(<AgentsSurface />);
    await waitFor(() => expect(getByTestId('agent-panes')).toBeInTheDocument());

    act(() => getByTestId('fire-conversation-closed-no-rebind').click());

    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-2');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-2');
  });

  it('ignores a close for a conversation this surface was not showing', async () => {
    const { getByTestId } = render(<AgentsSurface />);
    await waitFor(() => expect(getByTestId('agent-panes')).toBeInTheDocument());

    act(() => getByTestId('fire-conversation-closed-unrelated').click());

    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
  });

  it('a stale close (captured before the user picked something else) does not clobber the newer selection', async () => {
    const { getByTestId } = render(<AgentsSurface />);
    await waitFor(() => expect(getByTestId('agent-panes')).toBeInTheDocument());

    // The user switches conversations WHILE a close DELETE for conv-1 is
    // still in flight (this test's "stale" button fires the callback exactly
    // as it was captured on first render, before this switch).
    act(() =>
      useAgentSurfaceStore.getState().selectConversation({
        sessionId: 'ses-1',
        conversationId: 'conv-switched',
        agentId: 'agent-switched',
      }),
    );

    act(() => getByTestId('fire-conversation-closed-stale').click());

    // The stale callback's `conversationId: 'conv-1'` no longer matches the
    // CURRENT selection ('conv-switched'), so it must be ignored — not
    // overwrite the user's newer pick with the stale rebind target.
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-switched');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-switched');
  });
});

describe('past conversations (default view, replacing the old static prompt)', () => {
  it('renders the paginated list instead of the empty-state prompt when history exists', async () => {
    // A drive scope no earlier test fetched — SWR's cache is module-global and
    // an earlier test's empty answer for the SAME key would otherwise win here.
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.includes('/api/agent-sessions/conversations')) {
        return {
          ok: true,
          json: async () => ({
            conversations: [
              {
                conversationId: 'conv-hist-1',
                title: 'A past chat',
                type: 'global',
                agentPageId: null,
                pageTitle: null,
                lastMessageAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                sessionId: null,
                sessionName: null,
                sessionEndedAt: null,
                driveId: null,
              },
            ],
            pagination: { hasMore: false, nextCursor: null, limit: 20 },
          }),
        };
      }
      return { ok: true, json: async () => ({ session: { driveId: null } }) };
    });

    render(<AgentsSurface driveId="drive-past-convos-render" />);

    await waitFor(() => expect(screen.getByText('A past chat')).toBeDefined());
    expect(screen.queryByText('Select a session')).toBeNull();
  });

  it('clicking a session-bound row opens it in the pane grid, same as picking it from the sidebar', async () => {
    // A drive scope no earlier test fetched — see the cache note above.
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.includes('/api/agent-sessions/conversations')) {
        return {
          ok: true,
          json: async () => ({
            conversations: [
              {
                conversationId: 'conv-1',
                title: 'Session chat',
                type: 'page',
                agentPageId: 'agent-1',
                pageTitle: 'My Agent',
                lastMessageAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                sessionId: 'ses-1',
                sessionName: 'My Session',
                sessionEndedAt: null,
                driveId: 'drive-1',
              },
            ],
            pagination: { hasMore: false, nextCursor: null, limit: 20 },
          }),
        };
      }
      return { ok: true, json: async () => ({ session: { driveId: null } }) };
    });

    render(<AgentsSurface driveId="drive-past-convos-click" />);

    const label = await screen.findByText('Session chat');
    act(() => label.closest('button')!.click());

    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
  });

  it('resets the list to page one when driveId changes on an already-mounted surface (review: switching drives mid-session must not keep a stale cursor)', async () => {
    const conversationsFor = (driveLabel: string, cursor: string | null) => ({
      ok: true,
      json: async () => ({
        conversations: [
          {
            conversationId: cursor ? `conv-${driveLabel}-page2` : `conv-${driveLabel}-page1`,
            title: cursor ? `${driveLabel} page 2` : `${driveLabel} page 1`,
            type: 'global',
            agentPageId: null,
            pageTitle: null,
            lastMessageAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            sessionId: null,
            sessionName: null,
            sessionEndedAt: null,
            driveId: null,
          },
        ],
        // Page 1 always advertises more, so the Next button is enabled —
        // page 2 (any `cursor` present) is the end of the list.
        pagination: { hasMore: !cursor, nextCursor: cursor ? null : `conv-${driveLabel}-page1`, limit: 20 },
      }),
    });

    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.includes('/api/agent-sessions/conversations')) {
        const parsed = new URL(url, 'http://localhost');
        const driveLabel = parsed.searchParams.get('driveId') ?? 'none';
        const cursor = parsed.searchParams.get('cursor');
        return conversationsFor(driveLabel, cursor);
      }
      return { ok: true, json: async () => ({ session: { driveId: null } }) };
    });

    const { rerender, getByText, findByText } = render(<AgentsSurface driveId="drive-reset-a" />);

    await findByText('drive-reset-a page 1');
    act(() => getByText('Next').click());
    await findByText('drive-reset-a page 2');

    // Switch drives WITHOUT unmounting AgentsSurface itself — the exact
    // scenario the `key` fix targets (a route-param change re-renders, it
    // does not remount, the surface above this list).
    rerender(<AgentsSurface driveId="drive-reset-b" />);

    // Without the fix, the list would still be on page 2, replaying
    // drive-reset-a's cursor against drive-reset-b's data. With it, a fresh
    // instance mounts and asks for page one of the NEW drive.
    await waitFor(() => expect(screen.getByText('drive-reset-b page 1')).toBeDefined());
    expect(screen.queryByText(/page 2/)).toBeNull();
  });

  it('a failed Next fetch does not strand the user — the last loaded page and Prev/Next stay usable', async () => {
    let pageTwoShouldFail = false;

    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.includes('/api/agent-sessions/conversations')) {
        const parsed = new URL(url, 'http://localhost');
        const cursor = parsed.searchParams.get('cursor');
        if (cursor && pageTwoShouldFail) {
          return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
        }
        return {
          ok: true,
          json: async () => ({
            conversations: [
              {
                conversationId: cursor ? 'conv-page2' : 'conv-page1',
                title: cursor ? 'Page 2 chat' : 'Page 1 chat',
                type: 'global',
                agentPageId: null,
                pageTitle: null,
                lastMessageAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                sessionId: null,
                sessionName: null,
                sessionEndedAt: null,
                driveId: null,
              },
            ],
            pagination: { hasMore: !cursor, nextCursor: cursor ? null : 'conv-page1', limit: 20 },
          }),
        };
      }
      return { ok: true, json: async () => ({ session: { driveId: null } }) };
    });

    const { getByText, findByText, queryByText } = render(<AgentsSurface driveId="drive-fail-recover" />);
    await findByText('Page 1 chat');

    pageTwoShouldFail = true;
    act(() => getByText('Next').click());

    // The failed page must not wipe the view: page 1's row is still there,
    // an inline notice covers the failure, and Prev is still the way out.
    await waitFor(() => expect(screen.getByText(/Couldn't load this page/)).toBeDefined());
    expect(getByText('Page 1 chat')).toBeDefined();
    expect(queryByText("Couldn't load past conversations")).toBeNull();
    const prevButton = getByText('Prev').closest('button')!;
    expect(prevButton).not.toBeDisabled();

    act(() => prevButton.click());
    await waitFor(() => expect(screen.queryByText(/Couldn't load this page/)).toBeNull());
    expect(getByText('Page 1 chat')).toBeDefined();
  });

  it('the Next button is disabled while a page fetch is in flight — a fast double-click cannot skip a page', async () => {
    // Without gating on `isValidating`, a second click before the first
    // click's fetch resolves would read the same (still page-1) `nextCursor`
    // twice, pushing it onto `cursorStack` for two different page indices
    // and silently skipping whatever page actually follows page 2.
    let resolvePageTwoFetch!: (value: { ok: true; json: () => Promise<unknown> }) => void;
    const pageTwoFetch = new Promise<{ ok: true; json: () => Promise<unknown> }>((resolve) => {
      resolvePageTwoFetch = resolve;
    });

    const pageResponse = (label: string, nextCursor: string | null) => ({
      ok: true as const,
      json: async () => ({
        conversations: [
          {
            conversationId: `conv-${label}`,
            title: label,
            type: 'global',
            agentPageId: null,
            pageTitle: null,
            lastMessageAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            sessionId: null,
            sessionName: null,
            sessionEndedAt: null,
            driveId: null,
          },
        ],
        pagination: { hasMore: nextCursor !== null, nextCursor, limit: 20 },
      }),
    });

    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.includes('/api/agent-sessions/conversations')) {
        const cursor = new URL(url, 'http://localhost').searchParams.get('cursor');
        if (!cursor) return pageResponse('page-1', 'conv-page-1');
        return pageTwoFetch;
      }
      return { ok: true, json: async () => ({ session: { driveId: null } }) };
    });

    const { getByText, findByText } = render(<AgentsSurface driveId="drive-race" />);
    await findByText('page-1');

    const nextButton = getByText('Next').closest('button')!;
    act(() => nextButton.click());

    // The fetch for page 2 is now in flight (not yet resolved) — the button
    // must already be disabled, so a second click here is a no-op rather
    // than queuing a second page-advance against the same stale cursor.
    expect(nextButton).toBeDisabled();
    act(() => nextButton.click());

    resolvePageTwoFetch(pageResponse('page-2', null));
    await findByText('page-2');

    // Exactly one page-advance happened: still on page-2's content, not
    // having silently skipped to a (nonexistent) page-3.
    expect(screen.queryByText('page-1')).toBeNull();
  });

  it('clicking a client (API-managed) conversation shows a toast instead of navigating — no in-app surface can open it', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.includes('/api/agent-sessions/conversations')) {
        return {
          ok: true,
          json: async () => ({
            conversations: [
              {
                conversationId: 'conv-client-1',
                title: 'My API thread',
                type: 'client',
                agentPageId: null,
                pageTitle: null,
                lastMessageAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                sessionId: null,
                sessionName: null,
                sessionEndedAt: null,
                driveId: 'drive-1',
              },
            ],
            pagination: { hasMore: false, nextCursor: null, limit: 20 },
          }),
        };
      }
      return { ok: true, json: async () => ({ session: { driveId: null } }) };
    });

    render(<AgentsSurface driveId="drive-past-convos-client" />);

    const label = await screen.findByText('My API thread');
    act(() => label.closest('button')!.click());

    expect(mockToastInfo).toHaveBeenCalledTimes(1);
    expect(mockLoadConversation).not.toHaveBeenCalled();
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBeNull();
  });
});
