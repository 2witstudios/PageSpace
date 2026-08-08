/**
 * The Agents sidebar's wiring — **Drive → Session → conversations**.
 *
 * The behaviour worth pinning hardest is the one that has no visible symptom
 * when it breaks: **clicking a row does not navigate**. Selection goes to the
 * store, which writes `?workspace=&c=&agent=` with `pushState`, and the route
 * never changes — so nothing remounts and a live shell or streaming chat
 * survives the click. A regression to `router.push` would look identical on
 * screen and would silently tear down every PTY on the surface.
 *
 * Structural invariants pinned here:
 * - The tree's second level is the SESSION (workspace), and under it its
 *   conversations — never its panes (layout is centre-view state).
 * - Selecting a session opens its most recent CONVERSATION: session, c and
 *   agent land as one transition, so the centre never shows a session with no
 *   conversation resolved.
 * - Spawning a session is ONE act: pick an agent, and the server answers with
 *   the session AND its first conversation (a session is never empty).
 * - The authentication gate is a DISABLED FETCH (null SWR key), not a hidden
 *   list — sessions/chat/panes are open to every authenticated user, not
 *   just admins; the default auth mock below is a plain non-admin user on
 *   purpose, so every test in this file doubles as proof of that.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';
import { annotateConversationsWithPanes } from '@/lib/agent-workspaces/annotate-conversation-panes';

const mockPush = vi.fn();
const mockUseAuth = vi.fn();
const mockUseParams = vi.fn<() => { driveId?: string }>(() => ({ driveId: 'drive-1' }));
const mockUsePathname = vi.fn(() => '/dashboard/drive-1/agents');
const mockUseBreakpoint = vi.fn(() => false);

vi.mock('next/navigation', () => ({
  useParams: () => mockUseParams(),
  usePathname: () => mockUsePathname(),
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mockUseAuth() }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => mockUseBreakpoint() }));

const mockUseTouchDevice = vi.fn(() => false);
vi.mock('@/hooks/useTouchDevice', () => ({ useTouchDevice: () => mockUseTouchDevice() }));

interface PageAgentsResult {
  agentsByDrive: {
    driveId: string;
    driveName: string;
    agentCount: number;
    agents: { id: string; title: string | null; driveId: string }[];
  }[];
  isLoading: boolean;
  isError: boolean;
  mutate: () => void;
}

// Spied, not merely stubbed: the `enabled` argument IS half the auth gate
// (the other half is the null sessions SWR key) — asserting only that nothing
// renders would still pass if the gate were dropped, since the refusal notice
// short-circuits the list anyway.
const defaultPageAgents = (driveId?: string, options?: { enabled?: boolean }): PageAgentsResult => ({
  agentsByDrive: options?.enabled
    ? [
        {
          driveId: 'drive-1',
          driveName: 'Alpha',
          agentCount: 1,
          agents: [{ id: 'agent-1', title: 'Researcher', driveId: 'drive-1' }],
        },
      ]
    : [],
  isLoading: false,
  isError: false,
  mutate: vi.fn(),
});
const mockUsePageAgents = vi.fn(defaultPageAgents);
vi.mock('@/hooks/page-agents/usePageAgents', () => ({
  usePageAgents: (driveId?: string, options?: { enabled?: boolean }) => mockUsePageAgents(driveId, options),
}));

const mockFetchWithAuth = vi.fn();
const mockPost = vi.fn();
const mockDel = vi.fn();
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => {
  // `ApiRequestError` is re-exported from the REAL module (not hand-rolled)
  // so the component's `instanceof` check on a mocked-`del` rejection stays
  // true to the actual class the real `del()` throws.
  const actual = await importOriginal<typeof import('@/lib/auth/auth-fetch')>();
  return {
    ...actual,
    fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
    post: (...args: unknown[]) => mockPost(...args),
    del: (...args: unknown[]) => mockDel(...args),
  };
});

// Sidebar chrome that isn't under test.
vi.mock('@/components/layout/navbar/DriveSwitcher', () => ({ default: () => <div /> }));
vi.mock('../PrimaryNavigation', () => ({ default: () => <div /> }));
vi.mock('../DriveFooter', () => ({ default: () => <div /> }));
vi.mock('../DashboardFooter', () => ({ default: () => <div /> }));

const mockToastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args) } }));

import { within } from '@testing-library/react';
import { ApiRequestError } from '@/lib/auth/auth-fetch';
import AgentsSidebar, { resolveListNotice } from '../AgentsSidebar';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import {
  useAgentWorkspaceStore,
  __resetWorkspaceQueuesForTests,
} from '@/stores/agent-workspace/useAgentWorkspaceStore';
import type { WorkspaceState } from '@pagespace/lib/agent-workspaces/workspace-layout-verbs';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useDriveStore, type Drive } from '@/hooks/useDrive';

const driveFixture = (id: string, name: string, overrides: Partial<Drive> = {}): Drive => ({
  id,
  name,
  slug: name.toLowerCase(),
  ownerId: 'user-1',
  isTrashed: false,
  trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isOwned: true,
  ...overrides,
});

interface SessionFixture {
  workspaceId: string;
  /** The rolling-deploy compat twin the DTO still carries; nothing reads it. */
  sessionId: string;
  driveId: string | null;
  name: string;
  sandboxStatus: 'none' | 'starting' | 'running' | 'ended';
  conversations: { conversationId: string; title: string | null; agentPageId: string | null }[];
  shells: { shellId: string; name: string }[];
  /** Omitted (undefined) in most fixtures — the sidebar reads that as "fall back to the flat conversation list above." */
  workspace?: unknown;
}

const SESSION: SessionFixture = {
  // The listing spreads AgentSessionDTO, which carries the canonical id AND
  // the rolling-deploy compat twin. The sidebar reads the canonical one.
  workspaceId: 'ses-1',
  sessionId: 'ses-1',
  driveId: 'drive-1',
  name: 'api refactor',
  sandboxStatus: 'running',
  conversations: [
    { conversationId: 'conv-1', title: 'First chat', agentPageId: 'agent-1' },
    { conversationId: 'conv-2', title: 'Second chat', agentPageId: 'agent-1' },
  ],
  shells: [],
};

/**
 * Serve a listing the way the ROUTE serves one (issue #2373): each thread
 * annotated with its pane placement, using the server's own
 * `annotateConversationsWithPanes`. Fixtures cannot drift from the shape the
 * sidebar actually receives — a `workspace` grid and a `conversations` list
 * that disagreed about placement is precisely the bug this suite now guards.
 */
const respondWithSessions = (sessions: SessionFixture[]) => {
  const annotated = sessions.map((session) => ({
    ...session,
    conversations: annotateConversationsWithPanes(
      session.conversations,
      (session.workspace as { columns?: unknown } | undefined)?.columns as never,
    ),
  }));
  mockFetchWithAuth.mockResolvedValue({
    ok: true,
    json: async () => ({ sessions: annotated }),
  });
};

/** A fresh SWR cache per render — tests must not serve each other's sessions. */
const renderSidebar = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AgentsSidebar />
    </SWRConfig>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears calls, not implementations — a `mockImplementation`
  // from one test would otherwise leak into the next.
  mockUsePageAgents.mockImplementation(defaultPageAgents);
  window.history.replaceState({}, '', '/dashboard/drive-1/agents');
  useAgentSurfaceStore.setState({
    driveId: 'drive-1',
    selectedSessionId: null,
    selectedConversationId: null,
    selectedAgentId: null,
  });
  useLayoutStore.setState({ leftSheetOpen: false });
  // The roster is the canonical drive-group source in global mode — reset per
  // test so one test's fixture never leaks into the next via the persisted
  // store.
  useDriveStore.setState({ drives: [] });
  // Same leak risk for panes: two tests opening the same session id (every
  // fixture here is 'ses-1' or 'ses-new') would otherwise see each other's
  // panes[0], since nothing else clears this store between tests.
  __resetWorkspaceQueuesForTests();
  // Deliberately a PLAIN, non-admin user: sessions/chat/panes are open to
  // every authenticated user now, so every test in this file that relies on
  // this default doubles as proof a non-admin gets full access too.
  mockUseAuth.mockReturnValue({ user: { role: 'user' }, isLoading: false });
  mockUseParams.mockReturnValue({ driveId: 'drive-1' });
  mockUsePathname.mockReturnValue('/dashboard/drive-1/agents');
  mockUseBreakpoint.mockReturnValue(false);
  mockUseTouchDevice.mockReturnValue(false);
  respondWithSessions([SESSION]);
});

describe('AgentsSidebar', () => {
  test("lists the drive's sessions for a non-admin authenticated user", async () => {
    renderSidebar();
    expect(await screen.findByText('api refactor')).toBeDefined();
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/agent-workspaces?driveId=drive-1');
  });

  test('refuses when signed out, and makes no request on their behalf', () => {
    mockUseAuth.mockReturnValue({ user: null, isLoading: false });

    renderSidebar();

    expect(screen.getByText(/sign in to view your sessions/i)).toBeDefined();
    expect(screen.queryByText('api refactor')).toBeNull();
    // The load-bearing half: neither fetch is ever made, rather than made and
    // discarded.
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
    // Unfiltered (no driveId arg) now in both modes — see AgentsSidebar.tsx's
    // comment on the `usePageAgents` call — but the load-bearing half of
    // this assertion is `enabled: false`, unchanged.
    expect(mockUsePageAgents).toHaveBeenCalledWith(undefined, { enabled: false });
  });

  test('shows the cold-load state rather than the empty notice', () => {
    mockFetchWithAuth.mockReturnValue(new Promise(() => {})); // never resolves

    renderSidebar();

    expect(screen.getByText(/loading sessions/i)).toBeDefined();
    expect(screen.queryByText(/no sessions/i)).toBeNull();
  });

  test('a failed load with nothing cached shows the error, with a way out', async () => {
    mockFetchWithAuth.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    renderSidebar();

    expect(await screen.findByText(/failed to load sessions/i)).toBeDefined();
    expect(screen.getByText('Retry')).toBeDefined();
  });

  test('an empty drive still offers the affordance that fixes it', async () => {
    // An empty state with no way out of it is a dead end.
    respondWithSessions([]);

    renderSidebar();

    expect(await screen.findByText(/no sessions in this drive/i)).toBeDefined();
    expect(screen.getByLabelText('New session')).toBeDefined();
  });

  test('falls back to a flat conversation list when the session has no saved pane grid', async () => {
    // SESSION carries no `workspace` — a session never opened under
    // `useWorkspaceServerSync` (or opened only by an older client).
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByLabelText(/expand api refactor/i));

    expect(screen.getByText('Researcher — First chat')).toBeDefined();
    expect(screen.queryByText(/split/i)).toBeNull();
  });

  describe('a session with a saved pane grid', () => {
    const workspaceFixture = {
      id: 'ses-1',
      columns: [
        {
          id: 'col-1',
          panes: [
            {
              id: 'pane-1',
              scope: { kind: 'chat', name: 'Conversation', targetId: 'conv-1', agentPageId: 'agent-1' },
            },
            {
              id: 'pane-2',
              scope: { kind: 'chat', name: 'Conversation', targetId: 'conv-2', agentPageId: 'agent-1' },
            },
          ],
        },
      ],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    };

    test('groups conversations by PANE — one row per pane, each labeled by its own conversation', async () => {
      respondWithSessions([{ ...SESSION, workspace: workspaceFixture }]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));

      // Two panes, each showing its own conversation — two sibling rows.
      expect(screen.getByText('Researcher — First chat')).toBeDefined();
      expect(screen.getByText('Researcher — Second chat')).toBeDefined();
    });

    /**
     * THE BUG (issue #2373). The expansion used to be
     * `chatPanes ? … : session.conversations`, and an open workspace always
     * has a grid — so the pane branch always won and a thread with no pane row
     * simply did not render. Placement is best-effort, so that is the ordinary
     * state of a freshly spawned worker: production showed one workspace with
     * 3 threads and 2 panes, another with 10 threads and 4 panes. Six threads
     * were unreachable from the sidebar entirely.
     *
     * Fails on the pre-fix component: only the two placed rows appear.
     */
    test('renders a thread that has NO pane, alongside the placed ones', async () => {
      respondWithSessions([
        {
          ...SESSION,
          conversations: [
            ...SESSION.conversations,
            // Spawned, claimed, never placed — the "hi" conversation from the
            // production repro.
            { conversationId: 'conv-unplaced', title: 'hi', agentPageId: 'agent-1' },
          ],
          workspace: workspaceFixture,
        },
      ]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));

      expect(screen.getByText('Researcher — First chat')).toBeDefined();
      expect(screen.getByText('Researcher — Second chat')).toBeDefined();
      expect(screen.getByText('Researcher — hi')).toBeDefined();
      expect(screen.getAllByTestId('sidebar-conversation-row')).toHaveLength(3);
    });

    test('an unplaced thread closes the THREAD — there is no pane to unbind', async () => {
      respondWithSessions([
        {
          ...SESSION,
          conversations: [{ conversationId: 'conv-unplaced', title: 'hi', agentPageId: 'agent-1' }],
          workspace: workspaceFixture,
        },
      ]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      fireEvent.contextMenu(await screen.findByText('Researcher — hi'));
      await user.click(await screen.findByText('Close'));

      // The conversation DELETE, not a layout verb: an unplaced thread has no
      // pane binding to reset.
      await waitFor(() => {
        expect(mockDel).toHaveBeenCalledWith(
          expect.stringContaining('/conversations/conv-unplaced'),
        );
      });
    });

    test('clicking a pane row selects its conversation', async () => {
      respondWithSessions([{ ...SESSION, workspace: workspaceFixture }]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      await user.click(await screen.findByText('Researcher — First chat'));

      expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
      expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
      expect(mockPush).not.toHaveBeenCalled();
    });

    test('clicking the OTHER pane\'s row selects ITS conversation', async () => {
      respondWithSessions([{ ...SESSION, workspace: workspaceFixture }]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      await user.click(await screen.findByText('Researcher — Second chat'));

      expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
      expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-2');
    });

    test('lists a PAGE pane as its own row, labeled by the page title', async () => {
      // A document/task page opened into the grid (picker or an agent's
      // `open_page_pane`) is a persisted pane like any other — it must not
      // be invisible in the sidebar while chat panes and shells are listed.
      const withPagePane = {
        ...workspaceFixture,
        columns: [
          {
            id: 'col-1',
            panes: [
              ...workspaceFixture.columns[0].panes,
              { id: 'pane-3', scope: { kind: 'page', name: 'Spec doc', targetId: 'page-1', agentPageId: null } },
            ],
          },
        ],
      };
      respondWithSessions([{ ...SESSION, workspace: withPagePane }]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));

      expect(screen.getByText('Spec doc')).toBeDefined();
    });

    test('clicking a page pane row focuses the session and that pane, seating the grid from the row\'s own listing', async () => {
      // Deliberately NO local grid: the session isn't the displayed one, so
      // `AgentPanes`/`useWorkspaceServerSync` never hydrated it. The click
      // must seat the row's own server-listing snapshot before focusing —
      // `selectPane` no-ops on a session the store has never seen (review
      // P1, chatgpt-codex-connector).
      const withPagePane = {
        ...workspaceFixture,
        columns: [
          {
            id: 'col-1',
            panes: [
              ...workspaceFixture.columns[0].panes,
              { id: 'pane-3', scope: { kind: 'page', name: 'Spec doc', targetId: 'page-1', agentPageId: null } },
            ],
          },
        ],
      };
      respondWithSessions([{ ...SESSION, workspace: withPagePane }]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      await user.click(await screen.findByText('Spec doc'));

      expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1'].activePaneId).toBe('pane-3');
    });

    test('closing a page pane row persists the close to the server — the sync hook only covers the displayed session (review P1)', async () => {
      const withPagePane = {
        ...workspaceFixture,
        columns: [
          {
            id: 'col-1',
            panes: [
              ...workspaceFixture.columns[0].panes,
              { id: 'pane-3', scope: { kind: 'page', name: 'Spec doc', targetId: 'page-1', agentPageId: null } },
            ],
          },
        ],
      };
      respondWithSessions([{ ...SESSION, workspace: withPagePane }]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      fireEvent.contextMenu(await screen.findByText('Spec doc'));
      await user.click(await screen.findByText('Close'));

      // The local grid dropped the pane…
      await waitFor(() => {
        const panes = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes);
        expect(panes.find((p) => p.scope?.targetId === 'page-1')).toBeUndefined();
      });
      // …and the close crossed the wire as its own `close_pane` VERB. The
      // hand-rolled PUT this test used to pin is gone: the store posts every
      // mutation for every session, displayed or not, so the sidebar has no
      // persistence of its own left to get wrong.
      await waitFor(() => {
        const verbCall = mockFetchWithAuth.mock.calls.find(
          ([url, init]) =>
            url === '/api/agent-workspaces/ses-1/workspace/verbs' &&
            (init as RequestInit | undefined)?.method === 'POST',
        );
        expect(verbCall).toBeDefined();
        const body = JSON.parse((verbCall![1] as RequestInit).body as string) as {
          opId: string;
          baseRev: number;
          verb: { type: string; paneId: string };
        };
        expect(body.verb).toEqual({ type: 'close_pane', paneId: 'pane-3' });
        expect(body.opId).toBeTruthy();
      });
      // Nothing was PUT — the legacy blob route survives one release for
      // rolling deploys, but this client no longer calls it.
      expect(
        mockFetchWithAuth.mock.calls.find(
          ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
        ),
      ).toBeUndefined();
    });

    test('closing a row the local store no longer knows refreshes the listing instead of clobbering the server', async () => {
      // The store holds a DIFFERENT grid for ses-1 with no page pane —
      // zustand persist rehydrates every session's grid from localStorage
      // at page load, and another tab/device may have moved past this
      // row's snapshot. A wholesale PUT of that grid would overwrite the
      // server's newer layout AND leave the clicked pane alive (review P2).
      act(() => {
        useAgentWorkspaceStore.getState().hydrateWorkspace('ses-1', {
          id: 'ses-1',
          columns: [
            {
              id: 'col-9',
              panes: [{ id: 'pane-9', scope: { kind: 'chat', name: 'Conversation', targetId: 'conv-9', agentPageId: null } }],
            },
          ],
          activePaneId: 'pane-9',
          pendingPickerPaneId: null,
        } as WorkspaceState);
      });
      const withPagePane = {
        ...workspaceFixture,
        columns: [
          {
            id: 'col-1',
            panes: [
              ...workspaceFixture.columns[0].panes,
              { id: 'pane-3', scope: { kind: 'page', name: 'Spec doc', targetId: 'page-1', agentPageId: null } },
            ],
          },
        ],
      };
      respondWithSessions([{ ...SESSION, workspace: withPagePane }]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      fireEvent.contextMenu(await screen.findByText('Spec doc'));
      await user.click(await screen.findByText('Close'));

      await waitFor(() => {
        // The listing was asked to refresh… (the GET listing call count grows)
        expect(mockFetchWithAuth.mock.calls.length).toBeGreaterThan(1);
      });
      // …but nothing was PUT, and the local grid is untouched.
      const putCall = mockFetchWithAuth.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeUndefined();
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1'].activePaneId).toBe('pane-9');
    });

    test('a close whose verb the server rejects converges on the server truth, not a guessed rollback', async () => {
      // The old hand-rolled PUT rolled back to `session.workspace` and
      // toasted. The queue's answer is better and needs no local guess: a
      // 4xx abandons the op and re-reads the server's own snapshot, so what
      // the user ends up looking at is what is actually durable.
      const withPagePane = {
        ...workspaceFixture,
        columns: [
          {
            id: 'col-1',
            panes: [
              ...workspaceFixture.columns[0].panes,
              { id: 'pane-3', scope: { kind: 'page', name: 'Spec doc', targetId: 'page-1', agentPageId: null } },
            ],
          },
        ],
      };
      mockFetchWithAuth.mockImplementation(async (...args: unknown[]) => {
        const url = args[0] as string;
        const init = args[1] as RequestInit | undefined;
        if (url.endsWith('/workspace/verbs')) return { ok: false, status: 404, json: async () => ({}) };
        if (url.endsWith('/workspace') && init?.method === undefined) {
          return { ok: true, status: 200, json: async () => ({ rev: 4, grid: withPagePane.columns }) };
        }
        return { ok: true, status: 200, json: async () => ({ sessions: [{ ...SESSION, workspace: withPagePane }] }) };
      });
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      fireEvent.contextMenu(await screen.findByText('Spec doc'));
      await user.click(await screen.findByText('Close'));

      await waitFor(() => {
        const panes = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes);
        expect(panes.find((p) => p.scope?.targetId === 'page-1')).toBeDefined();
      });
      expect(useAgentWorkspaceStore.getState().sync['ses-1'].rev).toBe(4);
    });

    test('closing the LAST pane via a page row asks to end the session instead of silently tearing it down', async () => {
      const pageOnlyWorkspace = {
        id: 'ses-1',
        columns: [
          {
            id: 'col-1',
            panes: [{ id: 'pane-1', scope: { kind: 'page', name: 'Spec doc', targetId: 'page-1', agentPageId: null } }],
          },
        ],
        activePaneId: 'pane-1',
        pendingPickerPaneId: null,
      };
      respondWithSessions([{ ...SESSION, conversations: [], workspace: pageOnlyWorkspace }]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      fireEvent.contextMenu(await screen.findByText('Spec doc'));
      await user.click(await screen.findByText('Close'));

      // The end-session confirm opened; nothing was closed or PUT yet.
      expect(await screen.findByText(/end session/i)).toBeDefined();
      const putCall = mockFetchWithAuth.mock.calls.find(
        ([url, init]) =>
          url === '/api/agent-workspaces/ses-1/workspace' &&
          (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeUndefined();
    });

    test('selecting a session with a saved grid opens the ACTIVE pane\'s own conversation', async () => {
      respondWithSessions([{ ...SESSION, workspace: workspaceFixture }]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByText('api refactor'));

      expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
    });

    test('closing a pane row\'s "Close" menu item closes its conversation\'s listing and resets the pane to its picker', async () => {
      act(() => {
        useAgentWorkspaceStore.getState().hydrateWorkspace('ses-1', workspaceFixture as WorkspaceState);
      });
      respondWithSessions([{ ...SESSION, workspace: workspaceFixture }]);
      mockDel.mockResolvedValue(undefined);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      fireEvent.contextMenu(await screen.findByText('Researcher — First chat'));
      await user.click(await screen.findByText('Close'));

      await waitFor(() =>
        expect(mockDel).toHaveBeenCalledWith('/api/agent-workspaces/ses-1/conversations/conv-1'),
      );
      await waitFor(() => {
        const pane = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0];
        expect(pane.scope).toBeNull();
      });
    });

    test("closing the grid's ONLY pane rebinds it to another open listing instead of leaving it on an empty picker", async () => {
      // conv-2 is a real open listing elsewhere in the SESSION (per
      // `SESSION.conversations`) with no pane of its own — the grid never
      // empties (contract invariant 3), so closing this pane's own
      // conversation should repoint it at that other listing rather than
      // vanishing to a blank picker, the same grid-last rebind the pane
      // grid's own close control already gets from `decideClosePane` (review
      // finding — chatgpt-codex-connector on PR #2308).
      const singlePaneWorkspace = {
        id: 'ses-1',
        columns: [
          {
            id: 'col-1',
            panes: [{ id: 'pane-1', scope: { kind: 'chat', name: 'Conversation', targetId: 'conv-1', agentPageId: 'agent-1' } }],
          },
        ],
        activePaneId: 'pane-1',
        pendingPickerPaneId: null,
      };
      act(() => {
        useAgentWorkspaceStore.getState().hydrateWorkspace('ses-1', singlePaneWorkspace as WorkspaceState);
      });
      respondWithSessions([{ ...SESSION, workspace: singlePaneWorkspace }]);
      mockDel.mockResolvedValue(undefined);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      fireEvent.contextMenu(await screen.findByText('Researcher — First chat'));
      await user.click(await screen.findByText('Close'));

      await waitFor(() =>
        expect(mockDel).toHaveBeenCalledWith('/api/agent-workspaces/ses-1/conversations/conv-1'),
      );
      await waitFor(() => {
        const pane = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0];
        expect(pane.scope?.targetId).toBe('conv-2');
      });
    });

    /**
     * THE SAME CASE, FROM A SESSION THE STORE HAS NEVER SEEN (review finding —
     * CodeRabbit).
     *
     * A sidebar row can act on a session that is not the displayed one, and for
     * that session `AgentPanes` — and the layout sync that seats its grid — was
     * never mounted. `closePaneConversation` read the store raw, got undefined,
     * defaulted `shownElsewhere` to FALSE, and turned "close this pane" into
     * "DELETE this conversation" for a thread still open in another pane.
     *
     * The test above pre-hydrates the store, which is exactly why it could not
     * see this. Here the store is deliberately left empty: the fix seats the
     * row's own `session.workspace` snapshot through `ensureLocalWorkspace`
     * first, so the second pane is visible and only the clicked pane resets.
     *
     * Fails on the pre-fix component with a DELETE.
     */
    test('closing a shared pane in an UNHYDRATED session still resets locally — never DELETEs', async () => {
      const sharedWorkspace = {
        id: 'ses-1',
        columns: [
          {
            id: 'col-1',
            panes: [
              { id: 'pane-1', scope: { kind: 'chat', name: 'Conversation', targetId: 'conv-1', agentPageId: 'agent-1' } },
              { id: 'pane-2', scope: { kind: 'chat', name: 'Conversation', targetId: 'conv-1', agentPageId: 'agent-1' } },
            ],
          },
        ],
        activePaneId: 'pane-1',
        pendingPickerPaneId: null,
      };
      // NO hydrateWorkspace — this session was never opened in the grid.
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeUndefined();
      respondWithSessions([{ ...SESSION, workspace: sharedWorkspace }]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      fireEvent.contextMenu(await screen.findByText('Researcher — First chat'));
      await user.click(await screen.findByText('Close'));

      // Assert the RESET, not merely the absence of a DELETE (review finding —
      // CodeRabbit): a bare early return on `shownElsewhere` would leave the
      // clicked pane still bound and pass a no-DELETE-only assertion. The
      // clicked pane must be emptied and its sibling left alone, which is also
      // what proves the fix seated the grid — an unseated one cannot see
      // pane-2, so it would have taken the DELETE branch instead.
      await waitFor(() => {
        const panes = useAgentWorkspaceStore.getState().workspaces['ses-1']?.columns[0].panes;
        expect(panes?.find((p) => p.id === 'pane-1')?.scope).toBeNull();
      });
      const panes = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes;
      expect(panes.find((p) => p.id === 'pane-2')?.scope?.targetId).toBe('conv-1');
      expect(mockDel).not.toHaveBeenCalled();
    });

    test('closing a pane whose conversation is also open in ANOTHER pane resets it locally only — never DELETEs the shared listing', async () => {
      const sharedWorkspace = {
        id: 'ses-1',
        columns: [
          {
            id: 'col-1',
            panes: [
              { id: 'pane-1', scope: { kind: 'chat', name: 'Conversation', targetId: 'conv-1', agentPageId: 'agent-1' } },
              { id: 'pane-2', scope: { kind: 'chat', name: 'Conversation', targetId: 'conv-1', agentPageId: 'agent-1' } },
            ],
          },
        ],
        activePaneId: 'pane-1',
        pendingPickerPaneId: null,
      };
      act(() => {
        useAgentWorkspaceStore.getState().hydrateWorkspace('ses-1', sharedWorkspace as WorkspaceState);
      });
      respondWithSessions([{ ...SESSION, workspace: sharedWorkspace }]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      // ONE row, though the thread occupies two panes — `findByText` throws on
      // a second match, so this also pins the property the pane-keyed rows
      // could not give: the sidebar lists THREADS. The row acts on the thread's
      // first placement (pane-1), which is what the annotator records.
      fireEvent.contextMenu(await screen.findByText('Researcher — First chat'));
      await user.click(await screen.findByText('Close'));

      await waitFor(() => {
        const panes = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes;
        expect(panes.find((p) => p.id === 'pane-1')?.scope).toBeNull();
        // The other pane is untouched, and the server listing was never
        // asked to close — it's still shown there.
        expect(panes.find((p) => p.id === 'pane-2')?.scope?.targetId).toBe('conv-1');
      });
      expect(mockDel).not.toHaveBeenCalled();
    });

    test('closing a pane reads the LIVE workspace store, not the stale SWR session.workspace snapshot', async () => {
      // `session.workspace` is only as fresh as the last 20s poll or
      // `onChanged()` — a second pane opened on this conversation moments
      // ago can be invisible to it. Seed a STALE single-pane snapshot (as if
      // the second pane had not yet been opened when this SWR response
      // landed) while the live store already has it in TWO panes, and
      // confirm the close decision follows the live store (review finding).
      const staleSnapshot = {
        id: 'ses-1',
        columns: [
          {
            id: 'col-1',
            panes: [{ id: 'pane-1', scope: { kind: 'chat', name: 'Conversation', targetId: 'conv-1', agentPageId: 'agent-1' } }],
          },
        ],
        activePaneId: 'pane-1',
        pendingPickerPaneId: null,
      };
      const liveWorkspace = {
        ...staleSnapshot,
        columns: [
          {
            id: 'col-1',
            panes: [
              ...staleSnapshot.columns[0].panes,
              { id: 'pane-2', scope: { kind: 'chat', name: 'Conversation', targetId: 'conv-1', agentPageId: 'agent-1' } },
            ],
          },
        ],
      };
      act(() => {
        useAgentWorkspaceStore.getState().hydrateWorkspace('ses-1', liveWorkspace as WorkspaceState);
      });
      respondWithSessions([{ ...SESSION, workspace: staleSnapshot }]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      fireEvent.contextMenu(await screen.findByText('Researcher — First chat'));
      await user.click(await screen.findByText('Close'));

      // If the decision had read the stale snapshot, it would see conv-1 as
      // shown in only ONE pane and issue a real DELETE. It must not.
      await waitFor(() => {
        const panes = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes;
        expect(panes.find((p) => p.id === 'pane-1')?.scope).toBeNull();
      });
      expect(mockDel).not.toHaveBeenCalled();
    });
  });

  describe('selection', () => {
    test('clicking a session opens its most recent conversation WITHOUT navigating', async () => {
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByText('api refactor'));

      // One transition carrying all three ids — the centre never sees a
      // session with no conversation resolved.
      expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
      expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
      expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
      expect(window.location.search).toBe('?workspace=ses-1&c=conv-1&agent=agent-1');
      // The whole point: no route change, so nothing remounts.
      expect(mockPush).not.toHaveBeenCalled();
    });

    test('clicking a shell-only session (no conversations) falls back to opening its first shell', async () => {
      respondWithSessions([
        { ...SESSION, conversations: [], shells: [{ shellId: 'shell-fallback-1', name: 'Shell' }] },
      ]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByText('api refactor'));

      expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']?.columns[0]?.panes[0]?.scope).toEqual({
        kind: 'terminal',
        name: 'Shell',
        targetId: 'shell-fallback-1',
        agentPageId: null,
      });
    });

    test('clicking a conversation selects it under its session, still without navigating', async () => {
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      await user.click(await screen.findByText('Researcher — Second chat'));

      expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
      expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-2');
      expect(window.location.search).toBe('?workspace=ses-1&c=conv-2&agent=agent-1');
      expect(mockPush).not.toHaveBeenCalled();
    });

    test('closes the left sheet on a narrow viewport', async () => {
      // Selection no longer navigates, and navigation is what used to close the
      // sheet — so on mobile the user would pick a row and keep staring at the
      // sidebar covering their choice.
      mockUseBreakpoint.mockReturnValue(true);
      useLayoutStore.setState({ leftSheetOpen: true });
      const user = userEvent.setup();
      const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation(
        (query: string) =>
          ({
            matches: true,
            media: query,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
          }) as unknown as MediaQueryList,
      );

      renderSidebar();
      await user.click(await screen.findByText('api refactor'));

      expect(useLayoutStore.getState().leftSheetOpen).toBe(false);
      matchMediaSpy.mockRestore();
    });
  });

  describe('running dot', () => {
    test('lights a session whose sandbox is running', async () => {
      renderSidebar();
      await screen.findByText('api refactor');
      expect(screen.getByLabelText('Sandbox running')).toBeDefined();
    });

    test('shows no dot for a session with no sandbox', async () => {
      respondWithSessions([{ ...SESSION, sandboxStatus: 'none' }]);
      renderSidebar();
      await screen.findByText('api refactor');
      expect(screen.queryByLabelText('Sandbox running')).toBeNull();
    });

    test('is announced as an image with its name — a plain span aria-label is not announced by most screen readers', async () => {
      renderSidebar();
      await screen.findByText('api refactor');
      // getByRole('img', {name}) only matches elements a screen reader would
      // actually announce as a named object — the bar a bare aria-label span
      // fails.
      expect(screen.getByRole('img', { name: 'Sandbox running' })).toBeDefined();
    });
  });

  describe('conversation sub-item labels', () => {
    test('composes <Agent> — <title> once a title is populated', async () => {
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));

      expect(screen.getByText('Researcher — First chat')).toBeDefined();
      expect(screen.getByText('Researcher — Second chat')).toBeDefined();
    });

    test('shows just the agent name when no title has been set yet', async () => {
      respondWithSessions([
        {
          ...SESSION,
          conversations: [{ conversationId: 'conv-1', title: null, agentPageId: 'agent-1' }],
        },
      ]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));

      expect(screen.getByText('Researcher')).toBeDefined();
      expect(screen.queryByText(/—/)).toBeNull();
    });

    test('falls back to "Global Assistant" for a null agentPageId, and "Agent" for an unknown one', async () => {
      respondWithSessions([
        {
          ...SESSION,
          conversations: [
            { conversationId: 'conv-1', title: null, agentPageId: null },
            { conversationId: 'conv-2', title: null, agentPageId: 'agent-deleted' },
          ],
        },
      ]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));

      expect(screen.getByText('Global Assistant')).toBeDefined();
      expect(screen.getByText('Agent')).toBeDefined();
    });
  });

  describe('shells', () => {
    test('renders each shell as its own row, not a count', async () => {
      respondWithSessions([
        { ...SESSION, shells: [{ shellId: 'shell-a', name: 'shell-1' }, { shellId: 'shell-b', name: 'shell-2' }] },
      ]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));

      expect(screen.getByText('shell-1')).toBeDefined();
      expect(screen.getByText('shell-2')).toBeDefined();
      expect(screen.queryByText(/shells$/)).toBeNull();
    });

    test('clicking a shell selects its session and opens its terminal pane', async () => {
      respondWithSessions([{ ...SESSION, shells: [{ shellId: 'shell-a', name: 'shell-1' }] }]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      await user.click(await screen.findByText('shell-1'));

      expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']?.columns[0]?.panes[0]?.scope).toEqual({
        kind: 'terminal',
        name: 'shell-1',
        targetId: 'shell-a',
        agentPageId: null,
      });
    });

    // issue #2295 (adversarial review, PR #2307): `openShell` calls the
    // store's `openConversation` directly — a second, independent path into
    // the same eviction-prone `isReplaceable` heuristic the main fix
    // protects, reachable without ever touching AgentPanes.tsx's seeding
    // effect. A pane already showing a conversation absent from THIS
    // session's own live listing (closed-in-session) must not be silently
    // overwritten just because the user reattached an unrelated shell.
    test('reattaching a shell does not evict a pane showing a conversation closed out of the session', async () => {
      const existingGrid = {
        id: 'ses-1',
        columns: [
          {
            id: 'col-1',
            panes: [
              {
                id: 'pane-1',
                scope: { kind: 'chat', name: 'Conversation', targetId: 'conv-closed', agentPageId: 'agent-1' },
              },
            ],
          },
        ],
        activePaneId: 'pane-1',
        pendingPickerPaneId: null,
      };
      act(() => {
        useAgentWorkspaceStore.getState().hydrateWorkspace('ses-1', existingGrid as WorkspaceState);
      });
      // `conv-closed` is deliberately absent from `conversations` — this
      // session's own live listing — simulating it having been closed out
      // of the session while its pane is still bound to it.
      respondWithSessions([
        { ...SESSION, conversations: [], shells: [{ shellId: 'shell-a', name: 'shell-1' }], workspace: existingGrid },
      ]);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      await user.click(await screen.findByText('shell-1'));

      const panes = useAgentWorkspaceStore.getState().workspaces['ses-1']!.columns.flatMap((c) => c.panes);
      // Protected: the original pane still shows conv-closed, untouched.
      expect(panes.find((p) => p.id === 'pane-1')?.scope?.targetId).toBe('conv-closed');
      // The shell opened in a NEW pane instead of evicting it.
      expect(panes.find((p) => p.scope?.kind === 'terminal')?.scope).toEqual({
        kind: 'terminal',
        name: 'shell-1',
        targetId: 'shell-a',
        agentPageId: null,
      });
      expect(panes).toHaveLength(2);
    });
  });

  describe('new session', () => {
    test('the inline "+" opens a searchable agent palette; picking an agent advances to a naming step, and submitting blank still spawns the session AND its first conversation, landing inside it', async () => {
      mockPost.mockResolvedValue({ session: { workspaceId: 'ses-new', sessionId: 'ses-new' }, conversationId: 'conv-new' });
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      await user.click(screen.getByLabelText('New session'));
      await user.click(await screen.findByText('Researcher'));

      // Naming step: input starts empty with the agent's title as placeholder.
      const nameInput = await screen.findByPlaceholderText('Researcher');
      expect(nameInput).toHaveValue('');
      await user.type(nameInput, '{Enter}');

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      expect(mockPost).toHaveBeenCalledWith('/api/agent-workspaces', {
        driveId: 'drive-1',
        agentPageId: 'agent-1',
        name: '',
      });
      await waitFor(() =>
        expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-new'),
      );
      // Landed IN the first conversation — no empty-session state is visible.
      expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-new');
      expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
    });

    test('the drive palette also offers Global Assistant, first — picking it spawns a session in THIS drive with no agent', async () => {
      mockPost.mockResolvedValue({ session: { workspaceId: 'ses-new', sessionId: 'ses-new' }, conversationId: 'conv-new' });
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      await user.click(screen.getByLabelText('New session'));
      await user.click(await screen.findByText('Global Assistant'));

      const nameInput = await screen.findByPlaceholderText('Global Assistant');
      expect(nameInput).toHaveValue('');
      await user.type(nameInput, '{Enter}');

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      // Drive-scoped, not the global assistant group: driveId stays 'drive-1'.
      expect(mockPost).toHaveBeenCalledWith('/api/agent-workspaces', {
        driveId: 'drive-1',
        agentPageId: null,
        name: '',
      });
      await waitFor(() =>
        expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-new'),
      );
      expect(useAgentSurfaceStore.getState().selectedAgentId).toBeNull();
    });

    test('spawning a shell-first session names its terminal pane from the SHELL\'s own auto-assigned name, not the session label', async () => {
      mockPost.mockResolvedValue({ session: { workspaceId: 'ses-new', sessionId: 'ses-new' }, shellId: 'shell-new', shellName: 'Shell 2' });
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      await user.click(screen.getByLabelText('New session'));
      await user.click(await screen.findByText('Shell'));

      const nameInput = await screen.findByPlaceholderText('Shell');
      await user.type(nameInput, 'My Custom Session{Enter}');

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(useAgentWorkspaceStore.getState().workspaces['ses-new']?.columns[0]?.panes[0]?.scope).toEqual({
          kind: 'terminal',
          name: 'Shell 2',
          targetId: 'shell-new',
          agentPageId: null,
        }),
      );
    });

    test('a drive with no agents still offers Shell — no empty chooser', async () => {
      mockUsePageAgents.mockImplementation(() => ({
        agentsByDrive: [],
        isLoading: false,
        isError: false,
        mutate: vi.fn(),
      }));
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      await user.click(screen.getByLabelText('New session'));

      expect(await screen.findByText('Shell')).toBeDefined();
      expect(screen.queryByText('Researcher')).toBeNull();
    });
  });

  describe('end session', () => {
    test('confirming ends it: DELETE, grid forgotten, selection cleared, list refetched', async () => {
      mockDel.mockResolvedValue(undefined);
      // The session is open in the centre, with a persisted pane grid.
      useAgentSurfaceStore.setState({
        selectedSessionId: 'ses-1',
        selectedConversationId: 'conv-1',
        selectedAgentId: 'agent-1',
      });
      useAgentWorkspaceStore
        .getState()
        .ensureWorkspace('ses-1', { kind: 'chat', name: 'x', targetId: 'conv-1', agentPageId: 'agent-1' });
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      await user.click(screen.getByLabelText('End session'));
      // Destructive and irreversible-ish (the sandbox dies): confirmed, never
      // one accidental hover-click.
      const dialog = await screen.findByRole('alertdialog');
      const fetchesBefore = mockFetchWithAuth.mock.calls.length;
      await user.click(within(dialog).getByRole('button', { name: 'End session' }));

      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-workspaces/ses-1'));
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeUndefined();
      expect(useAgentSurfaceStore.getState().selectedSessionId).toBeNull();
      await waitFor(() => expect(mockFetchWithAuth.mock.calls.length).toBeGreaterThan(fetchesBefore));
    });

    test('cancelling ends nothing', async () => {
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      await user.click(screen.getByLabelText('End session'));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      expect(mockDel).not.toHaveBeenCalled();
    });

    test('the grid, selection, and sidebar row drop instantly — before the sandbox-kill DELETE resolves, not after', async () => {
      // The whole point: ending a session must not wait on the sandbox
      // teardown this DELETE triggers server-side, which can take real
      // seconds. Everything user-visible updates the moment the user
      // confirms, not once the request comes back.
      let resolveDel!: () => void;
      mockDel.mockReturnValue(new Promise<void>((resolve) => (resolveDel = resolve)));
      useAgentSurfaceStore.setState({
        selectedSessionId: 'ses-1',
        selectedConversationId: 'conv-1',
        selectedAgentId: 'agent-1',
      });
      useAgentWorkspaceStore
        .getState()
        .ensureWorkspace('ses-1', { kind: 'chat', name: 'x', targetId: 'conv-1', agentPageId: 'agent-1' });
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      await user.click(screen.getByLabelText('End session'));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'End session' }));

      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-workspaces/ses-1'));
      // Still pending — nothing has resolved yet.
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeUndefined();
      expect(useAgentSurfaceStore.getState().selectedSessionId).toBeNull();
      expect(screen.queryByText('api refactor')).toBeNull();

      resolveDel();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    test('a failed end-session restores the grid and selection, but does not yank the user back if they already navigated elsewhere', async () => {
      // `selectSession` also pushes a URL — restoring a stale selection on a
      // rare rollback must not silently override wherever the user has since
      // navigated during this request's round trip.
      let rejectDel!: (error: unknown) => void;
      mockDel.mockReturnValue(new Promise((_resolve, reject) => (rejectDel = reject)));
      useAgentSurfaceStore.setState({
        selectedSessionId: 'ses-1',
        selectedConversationId: 'conv-1',
        selectedAgentId: 'agent-1',
      });
      useAgentWorkspaceStore
        .getState()
        .ensureWorkspace('ses-1', { kind: 'chat', name: 'x', targetId: 'conv-1', agentPageId: 'agent-1' });
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      await user.click(screen.getByLabelText('End session'));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'End session' }));
      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-workspaces/ses-1'));

      // While that DELETE is still pending, the user navigates to a
      // different session entirely.
      useAgentSurfaceStore.getState().selectSession('ses-2');

      rejectDel(new Error('boom'));
      await waitFor(() => expect(mockToastError).toHaveBeenCalled());

      // The grid is restored (nothing else could have touched it)...
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeDefined();
      // ...but the user's own, later navigation stands — not clobbered back
      // to the session whose end just failed.
      expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-2');
    });
  });

  describe('session row menu', () => {
    test('the 3-dots button is auto-revealed on a touch device', async () => {
      mockUseTouchDevice.mockReturnValue(true);
      renderSidebar();

      await screen.findByText('api refactor');
      expect(screen.getByLabelText('Session actions').className).toContain('opacity-100');
    });

    test('the 3-dots button is hover-revealed (opacity-0 at rest) on a non-touch device', async () => {
      renderSidebar();

      await screen.findByText('api refactor');
      expect(screen.getByLabelText('Session actions').className).toContain('opacity-0');
    });

    test('"End session" from the context menu opens the same confirm dialog as the inline X', async () => {
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      fireEvent.contextMenu(screen.getByText('api refactor'));
      await user.click(await screen.findByText('End session'));

      expect(await screen.findByRole('alertdialog')).toBeDefined();
    });

    test('the 3-dots dropdown opens the same single item, driving the same handler', async () => {
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      await user.click(screen.getByLabelText('Session actions'));

      await user.click(await screen.findByText('End session'));

      expect(await screen.findByRole('alertdialog')).toBeDefined();
    });

    test('the inline "New conversation" affordance is gone — switching an agent in an open pane is the only way to mint one', async () => {
      renderSidebar();

      await screen.findByText('api refactor');
      expect(screen.queryByLabelText('New conversation in this session')).toBeNull();
      fireEvent.contextMenu(screen.getByText('api refactor'));
      expect(screen.queryByText('New conversation')).toBeNull();
    });
  });

  describe('conversation close', () => {
    test('right-click "Close" DELETEs the session-scoped route and refetches on success', async () => {
      mockDel.mockResolvedValue(undefined);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      const fetchesBefore = mockFetchWithAuth.mock.calls.length;
      fireEvent.contextMenu(await screen.findByText('Researcher — First chat'));
      await user.click(await screen.findByText('Close'));

      await waitFor(() =>
        expect(mockDel).toHaveBeenCalledWith('/api/agent-workspaces/ses-1/conversations/conv-1'),
      );
      // Instant sidebar freshness, same as the session row's other mutating actions.
      await waitFor(() => expect(mockFetchWithAuth.mock.calls.length).toBeGreaterThan(fetchesBefore));
    });

    test('the 3-dots dropdown "Close" drives the same DELETE', async () => {
      mockDel.mockResolvedValue(undefined);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      // Two conversations render — each gets its own "Conversation actions"
      // trigger, so scope to "First chat"'s own row.
      const firstChatRow = (await screen.findByText('Researcher — First chat')).closest(
        '[data-slot="context-menu-trigger"]',
      ) as HTMLElement;
      await user.click(within(firstChatRow).getByLabelText('Conversation actions'));
      await user.click(await screen.findByText('Close'));

      await waitFor(() =>
        expect(mockDel).toHaveBeenCalledWith('/api/agent-workspaces/ses-1/conversations/conv-1'),
      );
    });

    test('a 409 (the session\'s last open listing) falls back to the end-session confirm dialog, mirroring the pane grid', async () => {
      mockDel.mockRejectedValue(new ApiRequestError('last open listing', 409));
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      fireEvent.contextMenu(await screen.findByText('Researcher — First chat'));
      await user.click(await screen.findByText('Close'));

      expect(await screen.findByRole('alertdialog')).toBeDefined();
    });

    test('a non-409 failure shows an error toast, not the end-session dialog', async () => {
      mockDel.mockRejectedValue(new ApiRequestError('boom', 500));
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      fireEvent.contextMenu(await screen.findByText('Researcher — First chat'));
      await user.click(await screen.findByText('Close'));

      await waitFor(() => expect(mockDel).toHaveBeenCalled());
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  describe('drive mode + the caller\'s global-assistant sessions (review #2325)', () => {
    /**
     * Three parents up, not the `global mode` describe's two: label span →
     * header-row span → header-row div (`SessionGroupHeader`'s own root, which
     * is enough to scope a click on its "+") → the actual GROUP div
     * (`<div key={group.driveId}>`), which is what's needed here to also
     * assert on sibling `SessionRow`s inside the same group.
     */
    const groupContainer = (headerText: string) =>
      screen.getByText(headerText).parentElement?.parentElement?.parentElement as HTMLElement;

    test('a null-driveId session renders under its own "Global Assistant" header, separate from the drive\'s own (headerless) sessions', async () => {
      respondWithSessions([
        SESSION,
        {
          ...SESSION,
          sessionId: 'ses-g',
          driveId: null,
          name: 'assistant session',
          conversations: [{ conversationId: 'conv-g', title: 'Thread', agentPageId: null }],
        },
      ]);
      renderSidebar();

      expect(await screen.findByText('api refactor')).toBeDefined();
      expect(await screen.findByText('assistant session')).toBeDefined();
      // The drive's own group stays headerless (unchanged from before this
      // session type existed) — only the Assistant group gets a header.
      expect(screen.queryAllByText('Global Assistant')).toHaveLength(1);
      expect(within(groupContainer('Global Assistant')).getByText('assistant session')).toBeDefined();
      expect(within(groupContainer('Global Assistant')).queryByText('api refactor')).toBeNull();
    });

    test('given only drive-scoped sessions, does NOT render an empty "Global Assistant" group — it would collide with the palette\'s unrelated "Global Assistant" agent-picker entry', async () => {
      // Regression pin for the review round where this group rendered
      // unconditionally (mirroring global mode's `canSpawn` escape hatch) and
      // broke two unrelated pre-existing tests via a duplicate-text collision:
      // the new-session palette's "Global Assistant" agent choice, and the
      // "falls back to Global Assistant for a null agentPageId" conversation
      // label. Both name the SAME agent-picker concept, not this session-scope
      // group, so the group must earn its place on screen only when relevant.
      renderSidebar();

      await screen.findByText('api refactor');
      expect(screen.queryByText('Global Assistant')).toBeNull();
    });

    test('labels a global session\'s conversation with an OUT-OF-DRIVE agent\'s real name, not the generic fallback (review: Codex P2 on #2325)', async () => {
      // Before this fix, `usePageAgents(driveId)` filtered agent names down to
      // the CURRENT drive only, so a global session's conversation with an
      // agent from a different drive (a legitimate shape — a global session
      // may host any accessible agent) fell back to the generic "Agent" label
      // even though its real name was fetchable.
      mockUsePageAgents.mockImplementation((driveId?: string) => ({
        agentsByDrive: [
          { driveId: 'drive-1', driveName: 'Alpha', agentCount: 1, agents: [{ id: 'agent-1', title: 'Researcher', driveId: 'drive-1' }] },
          { driveId: 'drive-2', driveName: 'Beta', agentCount: 1, agents: [{ id: 'agent-2', title: 'Beta Agent', driveId: 'drive-2' }] },
        ].filter((entry) => driveId === undefined || entry.driveId === driveId),
        isLoading: false,
        isError: false,
        mutate: vi.fn(),
      }));
      respondWithSessions([
        SESSION,
        {
          ...SESSION,
          sessionId: 'ses-g',
          driveId: null,
          name: 'assistant session',
          conversations: [{ conversationId: 'conv-g', title: null, agentPageId: 'agent-2' }],
        },
      ]);
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('assistant session');
      await user.click(await screen.findByLabelText(/expand assistant session/i));

      expect(await screen.findByText('Beta Agent')).toBeDefined();
      expect(screen.queryByText('Agent')).toBeNull();
    });

    test('spawning from the Assistant group posts driveId: null, distinct from the drive palette\'s own "Global Assistant" agent pick', async () => {
      mockPost.mockResolvedValue({ session: { workspaceId: 'ses-a', sessionId: 'ses-a' }, conversationId: 'conv-a' });
      respondWithSessions([
        SESSION,
        {
          ...SESSION,
          sessionId: 'ses-g',
          driveId: null,
          name: 'assistant session',
          conversations: [],
        },
      ]);
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('assistant session');
      await user.click(within(groupContainer('Global Assistant')).getByRole('button', { name: /^New session/i }));

      const nameInput = await screen.findByPlaceholderText('Global Assistant');
      await user.type(nameInput, 'my assistant session{Enter}');

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/agent-workspaces', {
          driveId: null,
          agentPageId: null,
          name: 'my assistant session',
        }),
      );
    });
  });

  describe('global mode', () => {
    beforeEach(() => {
      mockUseParams.mockReturnValue({});
      mockUsePathname.mockReturnValue('/dashboard/agents');
      window.history.replaceState({}, '', '/dashboard/agents');
      useAgentSurfaceStore.setState({ driveId: null });
      // The roster — every drive the user can work in — is what makes a
      // drive's group appear at all, independent of whether it has a live
      // session. `useDriveStore` (not `agentsByDrive`) is the canonical source.
      useDriveStore.setState({ drives: [driveFixture('drive-1', 'Alpha')] });
    });

    /**
     * The group div wrapping a header row (name + inline "+") and its
     * sessions. The name lives in a `<span>` inside the header row now (not
     * the header row's own text), so it's two parents up: span → header row
     * → group.
     */
    const groupContainer = (headerText: string) =>
      screen.getByText(headerText).parentElement?.parentElement as HTMLElement;

    test('fetches every accessible session and groups them under a drive header', async () => {
      renderSidebar();

      expect(await screen.findByText('api refactor')).toBeDefined();
      expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/agent-workspaces');
      // The drive name resolves through the roster, not the agents-by-drive fetch.
      expect(screen.getByText('Alpha')).toBeDefined();
    });

    test('lists every roster drive, not just ones with a live session', async () => {
      useDriveStore.setState({ drives: [driveFixture('drive-1', 'Alpha'), driveFixture('drive-2', 'Beta')] });
      respondWithSessions([]);
      renderSidebar();

      expect(await screen.findByText('Alpha')).toBeDefined();
      expect(screen.getByText('Beta')).toBeDefined();
      // Every roster drive gets its own inline spawn affordance, whether or
      // not it has a session — plus the Assistant group's own.
      expect(screen.getAllByRole('button', { name: /^New session/i })).toHaveLength(3);
    });

    test('excludes trashed drives from the roster, matching DriveSwitcher and the multi-drive agents API', async () => {
      // useDriveStore can legitimately hold trashed drives — useGlobalDriveSocket
      // refetches with includeTrash: true on drive events — so the roster must
      // filter them out itself rather than trusting the store's contents.
      useDriveStore.setState({
        drives: [driveFixture('drive-1', 'Alpha'), driveFixture('drive-2', 'Gamma', { isTrashed: true })],
      });
      respondWithSessions([]);
      renderSidebar();

      expect(await screen.findByText('Alpha')).toBeDefined();
      expect(screen.queryByText('Gamma')).toBeNull();
    });

    test('a trashed drive with a lingering session keeps it visible but offers no new-session spawn', async () => {
      // The trashed drive is excluded from the roster, so its lingering
      // session surfaces as an orphan group (session-groups.ts never drops a
      // session) — but that orphan group must not let an admin spawn a NEW
      // session into a drive that was explicitly excluded for being trashed.
      useDriveStore.setState({
        drives: [driveFixture('drive-1', 'Alpha'), driveFixture('drive-2', 'Gamma', { isTrashed: true })],
      });
      respondWithSessions([{ ...SESSION, sessionId: 'ses-trashed', driveId: 'drive-2', name: 'lingering session' }]);
      renderSidebar();

      await screen.findByText('lingering session');
      // The orphan header falls back to the raw id — the trash-filtered
      // roster has no name to offer for it.
      expect(within(groupContainer('drive-2')).queryByRole('button', { name: /^New session/i })).toBeNull();
      // An active roster drive is unaffected.
      expect(within(groupContainer('Alpha')).getByRole('button', { name: /^New session/i })).toBeDefined();
    });

    test('shows no roster groups when signed out — refusal-only, not a dead spawn chooser', () => {
      // The auth gate must cover the roster too: previously only the
      // Assistant group's visibility was tied to admin status, so a
      // signed-out visitor with drives in the persisted store would see
      // every roster drive's header and its inline "+" alongside the
      // refusal notice, opening onto an empty palette since usePageAgents
      // is disabled for them.
      mockUseAuth.mockReturnValue({ user: null, isLoading: false });
      useDriveStore.setState({ drives: [driveFixture('drive-1', 'Alpha')] });

      renderSidebar();

      expect(screen.getByText(/sign in to view your sessions/i)).toBeDefined();
      expect(screen.queryByText('Alpha')).toBeNull();
      expect(screen.queryByText('Global Assistant')).toBeNull();
      expect(screen.queryByRole('button', { name: /^New session/i })).toBeNull();
      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });

    test('spawning from a roster drive with zero sessions posts its driveId + the chosen agent + the typed name', async () => {
      mockPost.mockResolvedValue({ session: { workspaceId: 'ses-new', sessionId: 'ses-new' }, conversationId: 'conv-new' });
      respondWithSessions([]);
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('Alpha');
      await user.click(within(groupContainer('Alpha')).getByRole('button', { name: /^New session/i }));
      await user.click(await screen.findByText('Researcher'));

      const nameInput = await screen.findByPlaceholderText('Researcher');
      await user.type(nameInput, 'my session{Enter}');

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/agent-workspaces', {
          driveId: 'drive-1',
          agentPageId: 'agent-1',
          name: 'my session',
        }),
      );
      await waitFor(() => expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-new'));
      expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-new');
    });

    test('the Assistant group exists with zero sessions, and its "+" opens the same naming step (not an instant spawn)', async () => {
      // Sessions are always deliberately named now — the Assistant group's "+"
      // goes through the naming step too, even though there's no agent to
      // choose (the assistant is the counterpart).
      mockPost.mockResolvedValue({ session: { workspaceId: 'ses-a', sessionId: 'ses-a' }, conversationId: 'conv-a' });
      respondWithSessions([]);
      const user = userEvent.setup();
      renderSidebar();

      expect(await screen.findByText('Global Assistant')).toBeDefined();
      // Scoped: the roster's own drive group also renders its own inline "+"
      // now, so an unscoped query would be ambiguous.
      await user.click(within(groupContainer('Global Assistant')).getByRole('button', { name: /^New session/i }));

      const nameInput = await screen.findByPlaceholderText('Global Assistant');
      expect(nameInput).toHaveValue('');
      await user.type(nameInput, '{Enter}');

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/agent-workspaces', {
          driveId: null,
          agentPageId: null,
          name: '',
        }),
      );
      await waitFor(() => expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-a'));
      expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-a');
      expect(useAgentSurfaceStore.getState().selectedAgentId).toBeNull();
    });

    test('the Assistant group sorts first even when a drive session arrives before it in the fetch', async () => {
      // Assistant first because it's the user's own — not because
      // `showEmptyAssistantGroup` happened to seed the Map before this drive
      // session was iterated. Here there's no empty-group seed at all: an
      // assistant session is already present, ahead of the map-insertion-order
      // bug this pins.
      respondWithSessions([
        SESSION,
        {
          ...SESSION,
          sessionId: 'ses-g',
          driveId: null,
          name: 'assistant session',
          conversations: [{ conversationId: 'conv-g', title: 'Thread', agentPageId: null }],
        },
      ]);
      renderSidebar();

      await screen.findByText('api refactor');
      const headers = screen.getAllByText(/^(Alpha|Global Assistant)$/);
      expect(headers.map((el) => el.textContent)).toEqual(['Global Assistant', 'Alpha']);
    });
  });

  describe('session search', () => {
    test('replaces the old static "Agent Sessions" label with a search box, and its "+" still opens the new-session flow', async () => {
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      expect(screen.queryByText('Agent Sessions')).toBeNull();

      await user.click(screen.getByLabelText('New session'));
      // Same agent palette the pre-existing "new session" tests assert on —
      // confirms the "+" next to the search box still drives the real flow.
      expect(await screen.findByText('Researcher')).toBeDefined();
    });

    test('typing filters the drive\'s sessions by name, and clearing the query restores the rest', async () => {
      // Override BOTH ids. `sessionId` is only the rolling-deploy compat twin;
      // the sidebar keys rows on the canonical `workspaceId`, so overriding
      // the twin alone gave two rows keyed `ses-1` — React warned about the
      // duplicate key and this "two sessions" test was really rendering one
      // session twice.
      respondWithSessions([
        SESSION,
        { ...SESSION, workspaceId: 'ses-2', sessionId: 'ses-2', name: 'design review' },
      ]);
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      expect(screen.getByText('design review')).toBeDefined();

      const search = screen.getByPlaceholderText('Search sessions…');
      await user.type(search, 'design');

      expect(screen.queryByText('api refactor')).toBeNull();
      expect(screen.getByText('design review')).toBeDefined();

      await user.clear(search);
      expect(await screen.findByText('api refactor')).toBeDefined();
    });

    test('a query with no matches shows a distinct notice, not the empty-drive one', async () => {
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      await user.type(screen.getByPlaceholderText('Search sessions…'), 'zzz-nope');

      expect(await screen.findByText('No sessions match your search')).toBeDefined();
      expect(screen.queryByText(/no sessions in this drive/i)).toBeNull();
    });

    describe('resolveListNotice', () => {
      // Unit-level, not through the full SWR + component stack: getting a real
      // `hasError` while `sessions` is still non-empty means forcing an SWR
      // background revalidation to actually fail (the 20s refreshInterval, or
      // a mutate()), which an integration test can't trigger deterministically
      // without fake timers fighting userEvent's own. Calling the (exported)
      // helper directly pins the exact branch logic instead.
      const baseArgs = {
        authLoading: false,
        isAuthenticated: true,
        hasError: false,
        isLoading: false,
        isDataEmpty: false,
        isResultEmpty: false,
        emptyTitle: 'No sessions yet',
        onRetry: vi.fn(),
      };

      test('given not authenticated, shows the sign-in notice regardless of other state', () => {
        render(
          <>
            {resolveListNotice({
              ...baseArgs,
              isAuthenticated: false,
              hasError: true,
              isDataEmpty: true,
              isResultEmpty: true,
            })}
          </>,
        );

        expect(screen.getByText(/sign in to view your sessions/i)).toBeDefined();
        expect(screen.queryByText(/failed to load sessions/i)).toBeNull();
      });

      test('a background refresh failure on cached sessions shows the no-match notice, not "Failed to load sessions"', () => {
        // Regression pin for the isDataEmpty/isResultEmpty split: hasError can
        // be true (a background refresh failing) while sessions is still the
        // last-known-good, non-empty cache (isDataEmpty stays false) — the
        // error branch must be skipped in favor of the search-driven notice.
        render(
          <>
            {resolveListNotice({
              ...baseArgs,
              hasError: true,
              isDataEmpty: false,
              isResultEmpty: true,
              emptyTitle: 'No sessions match your search',
            })}
          </>,
        );

        expect(screen.getByText('No sessions match your search')).toBeDefined();
        expect(screen.queryByText(/failed to load sessions/i)).toBeNull();
      });

      test('a failed load with nothing cached still shows "Failed to load sessions"', () => {
        render(
          <>
            {resolveListNotice({
              ...baseArgs,
              hasError: true,
              isDataEmpty: true,
              isResultEmpty: true,
            })}
          </>,
        );

        expect(screen.getByText(/failed to load sessions/i)).toBeDefined();
      });
    });

    describe('global mode', () => {
      beforeEach(() => {
        mockUseParams.mockReturnValue({});
        mockUsePathname.mockReturnValue('/dashboard/agents');
        window.history.replaceState({}, '', '/dashboard/agents');
        useAgentSurfaceStore.setState({ driveId: null });
        useDriveStore.setState({ drives: [driveFixture('drive-1', 'Alpha')] });
      });

      test('a search+"+" row sits above the per-drive groups, and its "+" opens Create a new drive — not a session', async () => {
        const user = userEvent.setup();
        renderSidebar();

        await screen.findByText('Alpha');
        await user.click(screen.getByLabelText('New drive'));

        expect(await screen.findByText('Create a new drive')).toBeDefined();
        // Distinct from the roster groups' own per-drive spawn affordance.
        expect(mockPost).not.toHaveBeenCalled();
      });

      test('searching hides every drive group with no matching sessions, across the whole roster', async () => {
        const user = userEvent.setup();
        renderSidebar();

        await screen.findByText('Alpha');
        await user.type(screen.getByPlaceholderText('Search sessions…'), 'zzz-nope');

        expect(screen.queryByText('Alpha')).toBeNull();
        expect(screen.queryByText('Global Assistant')).toBeNull();
        expect(await screen.findByText('No sessions match your search')).toBeDefined();
      });
    });
  });
});
