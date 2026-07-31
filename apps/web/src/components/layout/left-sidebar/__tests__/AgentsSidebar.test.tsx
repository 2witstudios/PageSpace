/**
 * The Agents sidebar's wiring — **Drive → Session → conversations**.
 *
 * The behaviour worth pinning hardest is the one that has no visible symptom
 * when it breaks: **clicking a row does not navigate**. Selection goes to the
 * store, which writes `?session=&c=&agent=` with `pushState`, and the route
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
 * - The admin gate is a DISABLED FETCH (null SWR key), not a hidden list.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

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

// Spied, not merely stubbed: the `enabled` argument IS half the admin gate
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

import { within } from '@testing-library/react';
import { ApiRequestError } from '@/lib/auth/auth-fetch';
import AgentsSidebar from '../AgentsSidebar';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
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
  sessionId: string;
  driveId: string | null;
  name: string;
  sandboxStatus: 'none' | 'starting' | 'running' | 'ended';
  conversations: { conversationId: string; title: string | null; agentPageId: string | null }[];
  shells: { shellId: string; name: string }[];
}

const SESSION: SessionFixture = {
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

const respondWithSessions = (sessions: SessionFixture[]) => {
  mockFetchWithAuth.mockResolvedValue({
    ok: true,
    json: async () => ({ sessions }),
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
  mockUseAuth.mockReturnValue({ user: { role: 'admin' }, isLoading: false });
  mockUseParams.mockReturnValue({ driveId: 'drive-1' });
  mockUsePathname.mockReturnValue('/dashboard/drive-1/agents');
  mockUseBreakpoint.mockReturnValue(false);
  mockUseTouchDevice.mockReturnValue(false);
  respondWithSessions([SESSION]);
});

describe('AgentsSidebar', () => {
  test("lists the drive's sessions for an admin", async () => {
    renderSidebar();
    expect(await screen.findByText('api refactor')).toBeDefined();
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/agent-sessions?driveId=drive-1');
  });

  test('refuses a non-admin, and makes no request on their behalf', () => {
    mockUseAuth.mockReturnValue({ user: { role: 'user' }, isLoading: false });

    renderSidebar();

    expect(screen.getByText(/administrator privileges/i)).toBeDefined();
    expect(screen.queryByText('api refactor')).toBeNull();
    // The load-bearing half: neither fetch is ever made, rather than made and
    // discarded.
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
    expect(mockUsePageAgents).toHaveBeenCalledWith('drive-1', { enabled: false });
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

  test('never lists panes — the second level is conversations', async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByLabelText(/expand api refactor/i));

    // Conversations, yes; anything pane-shaped, no.
    expect(screen.getByText('First chat')).toBeDefined();
    expect(screen.queryByText(/pane/i)).toBeNull();
    expect(screen.queryByText(/split/i)).toBeNull();
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
      expect(window.location.search).toBe('?session=ses-1&c=conv-1&agent=agent-1');
      // The whole point: no route change, so nothing remounts.
      expect(mockPush).not.toHaveBeenCalled();
    });

    test('clicking a conversation selects it under its session, still without navigating', async () => {
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      await user.click(await screen.findByText('Second chat'));

      expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
      expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-2');
      expect(window.location.search).toBe('?session=ses-1&c=conv-2&agent=agent-1');
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

  describe('new conversation in a session', () => {
    test("posts into the session with the last conversation's agent and selects the new thread", async () => {
      mockPost.mockResolvedValue({ conversationId: 'conv-new' });
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      await user.click(screen.getByLabelText('New conversation in this session'));

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      expect(mockPost).toHaveBeenCalledWith('/api/ai/page-agents/agent-1/conversations', {
        sessionId: 'ses-1',
      });
      await waitFor(() =>
        expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-new'),
      );
      expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
      expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
    });
  });

  describe('new session', () => {
    test('the inline "+" opens a searchable agent palette; picking an agent advances to a naming step, and submitting blank still spawns the session AND its first conversation, landing inside it', async () => {
      mockPost.mockResolvedValue({ session: { sessionId: 'ses-new' }, conversationId: 'conv-new' });
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
      expect(mockPost).toHaveBeenCalledWith('/api/agent-sessions', {
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

      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1'));
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

    test('right-click opens a context menu; "New conversation" drives the same handler as the inline icon', async () => {
      mockPost.mockResolvedValue({ conversationId: 'conv-new' });
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      fireEvent.contextMenu(screen.getByText('api refactor'));
      await user.click(await screen.findByText('New conversation'));

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      expect(mockPost).toHaveBeenCalledWith('/api/ai/page-agents/agent-1/conversations', {
        sessionId: 'ses-1',
      });
    });

    test('"End session" from the context menu opens the same confirm dialog as the inline X', async () => {
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      fireEvent.contextMenu(screen.getByText('api refactor'));
      await user.click(await screen.findByText('End session'));

      expect(await screen.findByRole('alertdialog')).toBeDefined();
    });

    test('the 3-dots dropdown opens the same two items, driving the same handlers', async () => {
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('api refactor');
      await user.click(screen.getByLabelText('Session actions'));

      expect(await screen.findByText('New conversation')).toBeDefined();
      await user.click(screen.getByText('End session'));

      expect(await screen.findByRole('alertdialog')).toBeDefined();
    });
  });

  describe('conversation close', () => {
    test('right-click "Close" DELETEs the session-scoped route and refetches on success', async () => {
      mockDel.mockResolvedValue(undefined);
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      const fetchesBefore = mockFetchWithAuth.mock.calls.length;
      fireEvent.contextMenu(await screen.findByText('First chat'));
      await user.click(await screen.findByText('Close'));

      await waitFor(() =>
        expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-1'),
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
      const firstChatRow = (await screen.findByText('First chat')).closest(
        '[data-slot="context-menu-trigger"]',
      ) as HTMLElement;
      await user.click(within(firstChatRow).getByLabelText('Conversation actions'));
      await user.click(await screen.findByText('Close'));

      await waitFor(() =>
        expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-1'),
      );
    });

    test('a 409 (the session\'s last open listing) falls back to the end-session confirm dialog, mirroring the pane grid', async () => {
      mockDel.mockRejectedValue(new ApiRequestError('last open listing', 409));
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      fireEvent.contextMenu(await screen.findByText('First chat'));
      await user.click(await screen.findByText('Close'));

      expect(await screen.findByRole('alertdialog')).toBeDefined();
    });

    test('a non-409 failure shows an error toast, not the end-session dialog', async () => {
      mockDel.mockRejectedValue(new ApiRequestError('boom', 500));
      const user = userEvent.setup();
      renderSidebar();

      await user.click(await screen.findByLabelText(/expand api refactor/i));
      fireEvent.contextMenu(await screen.findByText('First chat'));
      await user.click(await screen.findByText('Close'));

      await waitFor(() => expect(mockDel).toHaveBeenCalled());
      expect(screen.queryByRole('alertdialog')).toBeNull();
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
      expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/agent-sessions');
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

    test('shows no roster groups for a non-admin — refusal-only, not a dead spawn chooser', () => {
      // The admin gate must cover the roster too: previously only the
      // Assistant group's visibility was tied to admin status, so a
      // non-admin with drives in the persisted store would see every
      // roster drive's header and its inline "+" alongside the refusal
      // notice, opening onto an empty palette since usePageAgents is
      // disabled for them.
      mockUseAuth.mockReturnValue({ user: { role: 'user' }, isLoading: false });
      useDriveStore.setState({ drives: [driveFixture('drive-1', 'Alpha')] });

      renderSidebar();

      expect(screen.getByText(/administrator privileges/i)).toBeDefined();
      expect(screen.queryByText('Alpha')).toBeNull();
      expect(screen.queryByText('Assistant')).toBeNull();
      expect(screen.queryByRole('button', { name: /^New session/i })).toBeNull();
      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });

    test('spawning from a roster drive with zero sessions posts its driveId + the chosen agent + the typed name', async () => {
      mockPost.mockResolvedValue({ session: { sessionId: 'ses-new' }, conversationId: 'conv-new' });
      respondWithSessions([]);
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('Alpha');
      await user.click(within(groupContainer('Alpha')).getByRole('button', { name: /^New session/i }));
      await user.click(await screen.findByText('Researcher'));

      const nameInput = await screen.findByPlaceholderText('Researcher');
      await user.type(nameInput, 'my session{Enter}');

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/agent-sessions', {
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
      mockPost.mockResolvedValue({ session: { sessionId: 'ses-a' }, conversationId: 'conv-a' });
      respondWithSessions([]);
      const user = userEvent.setup();
      renderSidebar();

      expect(await screen.findByText('Assistant')).toBeDefined();
      // Scoped: the roster's own drive group also renders its own inline "+"
      // now, so an unscoped query would be ambiguous.
      await user.click(within(groupContainer('Assistant')).getByRole('button', { name: /^New session/i }));

      const nameInput = await screen.findByPlaceholderText('Assistant');
      expect(nameInput).toHaveValue('');
      await user.type(nameInput, '{Enter}');

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/agent-sessions', {
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
      const headers = screen.getAllByText(/^(Alpha|Assistant)$/);
      expect(headers.map((el) => el.textContent)).toEqual(['Assistant', 'Alpha']);
    });

    test('a new conversation in an assistant session goes through the session-centric creator', async () => {
      // The assistant has no agent page, so the page-agents route has nothing
      // to hang it on — the session route is the path.
      mockPost.mockResolvedValue({ conversationId: 'conv-new' });
      respondWithSessions([
        {
          ...SESSION,
          sessionId: 'ses-g',
          driveId: null,
          name: 'assistant session',
          conversations: [{ conversationId: 'conv-g', title: 'Thread', agentPageId: null }],
        },
      ]);
      const user = userEvent.setup();
      renderSidebar();

      await screen.findByText('assistant session');
      await user.click(screen.getByLabelText('New conversation in this session'));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/agent-sessions/ses-g/conversations', {}),
      );
      await waitFor(() =>
        expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-new'),
      );
      expect(useAgentSurfaceStore.getState().selectedAgentId).toBeNull();
    });
  });
});
