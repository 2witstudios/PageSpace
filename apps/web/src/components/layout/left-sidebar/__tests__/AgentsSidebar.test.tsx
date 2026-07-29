/**
 * The Agents sidebar's wiring.
 *
 * The behaviour worth pinning hardest is the one that has no visible symptom
 * when it breaks: **clicking a row does not navigate**. Selection goes to the
 * store, which writes `?agent=&c=` with `pushState`, and the route never
 * changes — so nothing remounts and a live shell or streaming chat survives the
 * click. A regression to `router.push` would look identical on screen and would
 * silently tear down every PTY on the surface, which is exactly the failure the
 * old Development surface needed a keep-alive host to paper over.
 *
 * After that: the admin gate is a DISABLED FETCH, conversations load only when
 * an agent is expanded, and the notice ordering (auth → admin → loading → error
 * → empty) matches the Development sidebar's — which is where its reasoning is
 * written down.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

// Spied, not merely stubbed: the `enabled` argument IS the admin gate, so it is
// the property under test — asserting only that no agent renders would still
// pass if the gate were dropped, since the refusal notice short-circuits the
// list anyway.
const mockUsePageAgents = vi.fn(
  (driveId?: string, options?: { enabled?: boolean }): PageAgentsResult => ({
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
  }),
);
vi.mock('@/hooks/page-agents/usePageAgents', () => ({
  usePageAgents: (driveId?: string, options?: { enabled?: boolean }) => mockUsePageAgents(driveId, options),
}));

const mockCreateConversation = vi.fn();
const mockUseConversations = vi.fn(
  (options: { agentId: string | null; enabled?: boolean; onConversationCreate?: (id: string) => void }) => ({
    conversations: options.enabled
      ? [{ id: 'conv-1', title: 'First chat' }, { id: 'conv-2', title: 'Second chat' }]
      : [],
    isLoading: false,
    createConversation: () => {
      options.onConversationCreate?.('conv-new');
      return mockCreateConversation();
    },
  }),
);
vi.mock('@/lib/ai/shared', () => ({
  useConversations: (options: Parameters<typeof mockUseConversations>[0]) => mockUseConversations(options),
}));

const mockUseUserActiveStreams = vi.fn(() => ({
  streams: [] as { messageId: string; conversationId: string; channelId: string; startedAt: string }[],
  isLoading: false,
  error: undefined,
  mutate: vi.fn(),
}));
vi.mock('@/hooks/useUserActiveStreams', () => ({
  useUserActiveStreams: () => mockUseUserActiveStreams(),
}));

const mockSeedConversation = vi.fn();
vi.mock('@/hooks/conversationMessagesActions', () => ({
  conversationMessagesActions: { seedConversation: (id: string) => mockSeedConversation(id) },
}));

const mockPost = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  post: (...args: unknown[]) => mockPost(...args),
  del: vi.fn(),
}));

// Sidebar chrome that isn't under test.
vi.mock('@/components/layout/navbar/DriveSwitcher', () => ({ default: () => <div /> }));
vi.mock('../PrimaryNavigation', () => ({ default: () => <div /> }));
vi.mock('../DriveFooter', () => ({ default: () => <div /> }));
vi.mock('../DashboardFooter', () => ({ default: () => <div /> }));

import AgentsSidebar from '../AgentsSidebar';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import { useLayoutStore } from '@/stores/useLayoutStore';

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/dashboard/drive-1/agents');
  useAgentSurfaceStore.setState({ driveId: 'drive-1', selectedAgentId: null, selectedConversationId: null });
  useLayoutStore.setState({ leftSheetOpen: false });
  mockUseAuth.mockReturnValue({ user: { role: 'admin' }, isLoading: false });
  mockUseParams.mockReturnValue({ driveId: 'drive-1' });
  mockUsePathname.mockReturnValue('/dashboard/drive-1/agents');
  mockUseBreakpoint.mockReturnValue(false);
  // `clearAllMocks` clears calls, not implementations — a `mockReturnValue` from
  // one test would otherwise leak into the next.
  mockUseUserActiveStreams.mockReturnValue({ streams: [], isLoading: false, error: undefined, mutate: vi.fn() });
});

describe('AgentsSidebar', () => {
  test("lists the drive's agents for an admin", async () => {
    render(<AgentsSidebar />);
    expect(await screen.findByText('Researcher')).toBeDefined();
  });

  test('refuses a non-admin, and asks the API for no agents on their behalf', () => {
    mockUseAuth.mockReturnValue({ user: { role: 'user' }, isLoading: false });

    render(<AgentsSidebar />);

    expect(screen.getByText(/administrator privileges/i)).toBeDefined();
    expect(screen.queryByText('Researcher')).toBeNull();
    // The load-bearing half: the request is never made, rather than made and
    // discarded.
    expect(mockUsePageAgents).toHaveBeenCalledWith('drive-1', { enabled: false });
  });

  test('shows the cold-load state rather than the empty notice', () => {
    mockUsePageAgents.mockReturnValueOnce({
      agentsByDrive: [],
      isLoading: true,
      isError: false,
      mutate: vi.fn(),
    });

    render(<AgentsSidebar />);

    expect(screen.getByText(/loading agents/i)).toBeDefined();
    expect(screen.queryByText(/no agents in this drive/i)).toBeNull();
  });

  test('a failed poll keeps the tree rather than replacing it with an error', () => {
    mockUsePageAgents.mockReturnValueOnce({
      agentsByDrive: [
        {
          driveId: 'drive-1',
          driveName: 'Alpha',
          agentCount: 1,
          agents: [{ id: 'agent-1', title: 'Researcher', driveId: 'drive-1' }],
        },
      ],
      isLoading: false,
      isError: true,
      mutate: vi.fn(),
    });

    render(<AgentsSidebar />);

    expect(screen.getByText('Researcher')).toBeDefined();
    expect(screen.queryByText(/failed to load agents/i)).toBeNull();
  });

  test('shows the drive header only in the aggregated global view', () => {
    render(<AgentsSidebar />);
    expect(screen.queryByText('Alpha')).toBeNull();

    mockUseParams.mockReturnValue({});
    mockUsePathname.mockReturnValue('/dashboard/agents');
    render(<AgentsSidebar />);
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
  });

  describe('selection', () => {
    test('clicking an agent selects it WITHOUT navigating', async () => {
      const user = userEvent.setup();
      render(<AgentsSidebar />);

      await user.click(await screen.findByText('Researcher'));

      expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
      expect(window.location.search).toBe('?agent=agent-1');
      // The whole point: no route change, so nothing remounts.
      expect(mockPush).not.toHaveBeenCalled();
    });

    test('clicking a conversation selects it under its own agent, still without navigating', async () => {
      const user = userEvent.setup();
      render(<AgentsSidebar />);

      await user.click(await screen.findByTestId('expand-chevron'));
      await user.click(await screen.findByText('First chat'));

      expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
      expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
      expect(window.location.search).toBe('?agent=agent-1&c=conv-1');
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

      render(<AgentsSidebar />);
      await user.click(await screen.findByText('Researcher'));

      expect(useLayoutStore.getState().leftSheetOpen).toBe(false);
      matchMediaSpy.mockRestore();
    });
  });

  describe('conversations', () => {
    test('does not fetch an agent\'s conversations until it is expanded', async () => {
      const user = userEvent.setup();
      render(<AgentsSidebar />);
      await screen.findByText('Researcher');

      // N agents on screen must not mean N conversation requests on mount.
      expect(mockUseConversations).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
      expect(screen.queryByText('First chat')).toBeNull();

      await user.click(screen.getByTestId('expand-chevron'));

      await waitFor(() =>
        expect(mockUseConversations).toHaveBeenCalledWith(expect.objectContaining({ enabled: true })),
      );
      expect(screen.getByText('First chat')).toBeDefined();
    });

    test('new conversation mints an id, seeds its cache, and selects it', async () => {
      // Mirrors `usePageAgentDashboardStore.createNewConversation`: the id is
      // known synchronously, the empty cache entry stops anything fetching for
      // it, and the persist is fire-and-forget.
      const user = userEvent.setup();
      render(<AgentsSidebar />);
      await user.click(await screen.findByTestId('expand-chevron'));
      await user.click(screen.getByText('New conversation'));

      expect(mockSeedConversation).toHaveBeenCalledWith('conv-new');
      expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-new');
      expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
    });
  });

  describe('running badges', () => {
    test('lights an agent whose conversation is streaming, even while collapsed', async () => {
      mockUseUserActiveStreams.mockReturnValue({
        streams: [
          {
            messageId: 'msg-1',
            conversationId: 'conv-1',
            channelId: 'agent-1',
            startedAt: '2026-07-28T00:00:00.000Z',
          },
        ],
        isLoading: false,
        error: undefined,
        mutate: vi.fn(),
      });

      render(<AgentsSidebar />);

      await screen.findByText('Researcher');
      expect(screen.getAllByLabelText('Running').length).toBe(1);
    });

    test('shows no dot when nothing is running', async () => {
      render(<AgentsSidebar />);
      await screen.findByText('Researcher');
      expect(screen.queryByLabelText('Running')).toBeNull();
    });
  });

  describe('new agent', () => {
    test('an empty drive still offers the affordance that fixes it', () => {
      // An empty state with no way out of it is a dead end.
      mockUsePageAgents.mockReturnValueOnce({
        agentsByDrive: [],
        isLoading: false,
        isError: false,
        mutate: vi.fn(),
      });

      render(<AgentsSidebar />);

      expect(screen.getByText(/no agents in this drive/i)).toBeDefined();
      expect(screen.getByText('New agent')).toBeDefined();
    });

    test('a refused user gets no create affordance', () => {
      mockUseAuth.mockReturnValue({ user: { role: 'user' }, isLoading: false });

      render(<AgentsSidebar />);

      expect(screen.queryByText('New agent')).toBeNull();
    });

    test('creates an AI_CHAT page in the drive and selects it', async () => {
      mockPost.mockResolvedValue({ id: 'agent-new' });
      const user = userEvent.setup();
      render(<AgentsSidebar />);

      await user.click(await screen.findByText('New agent'));

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      expect(mockPost).toHaveBeenCalledWith(
        '/api/pages',
        expect.objectContaining({ type: 'AI_CHAT', driveId: 'drive-1' }),
      );
      await waitFor(() => expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-new'));
    });
  });
});
