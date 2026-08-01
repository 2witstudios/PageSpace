/**
 * The Agents console's default middle-panel view — every past conversation
 * the requester owns. The behavior worth pinning: clicking a session-less
 * row now tries to CLAIM it into a freshly spawned session (landing it in
 * the pane grid with a real sandbox) before falling back to the pre-claim
 * page/global navigation, and a capability-kind failure degrades silently
 * (no toast) while a quota-kind one still shows one — same split
 * `useResolvedConversation.ts`'s opportunistic spawn already uses.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockFetchWithAuth = vi.hoisted(() => vi.fn());
const mockPost = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/auth-fetch')>();
  return {
    ...actual,
    fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
    post: (...args: unknown[]) => mockPost(...args),
  };
});

const mockLoadConversation = vi.hoisted(() => vi.fn());
vi.mock('@/contexts/GlobalChatContext', () => ({
  useGlobalChatConversation: () => ({ loadConversation: mockLoadConversation }),
}));

const mockToastError = vi.hoisted(() => vi.fn());
const mockToastInfo = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: mockToastError, info: mockToastInfo } }));

import AgentsPastConversationsList from '../AgentsPastConversationsList';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import { ApiRequestError } from '@/lib/auth/auth-fetch';

interface Row {
  conversationId: string;
  title: string | null;
  type: 'page' | 'global';
  agentPageId: string | null;
  pageTitle: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  sessionId: string | null;
  sessionName: string | null;
  sessionEndedAt: string | null;
  driveId: string | null;
}

const PAGE_ROW: Row = {
  conversationId: 'conv-page',
  title: 'Page chat',
  type: 'page' as const,
  agentPageId: 'agent-1',
  pageTitle: 'Researcher',
  lastMessageAt: '2026-07-28T00:00:00.000Z',
  createdAt: '2026-07-28T00:00:00.000Z',
  sessionId: null,
  sessionName: null,
  sessionEndedAt: null,
  driveId: 'drive-1',
};

const GLOBAL_ROW: Row = {
  conversationId: 'conv-global',
  title: null,
  type: 'global' as const,
  agentPageId: null,
  pageTitle: null,
  lastMessageAt: '2026-07-28T00:00:00.000Z',
  createdAt: '2026-07-28T00:00:00.000Z',
  sessionId: null,
  sessionName: null,
  sessionEndedAt: null,
  driveId: null,
};

const BOUND_ROW: Row = {
  conversationId: 'conv-bound',
  title: 'Live chat',
  type: 'page' as const,
  agentPageId: 'agent-1',
  pageTitle: 'Researcher',
  lastMessageAt: '2026-07-28T00:00:00.000Z',
  createdAt: '2026-07-28T00:00:00.000Z',
  sessionId: 'ses-1',
  sessionName: 'Worker',
  sessionEndedAt: null,
  driveId: 'drive-1',
};

function conversationsResponse(rows: Row[]) {
  return { ok: true, json: async () => ({ conversations: rows, pagination: { hasMore: false, nextCursor: null, limit: 20 } }) };
}

// Isolated SWR cache per render — this component's cache key never changes
// across these tests (no driveId, no cursor), so sharing SWR's default
// module-level cache would let a later test's render start from an EARLIER
// test's stale, deduped data.
function renderList() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AgentsPastConversationsList />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAgentSurfaceStore.setState({
    driveId: null,
    selectedSessionId: null,
    selectedConversationId: null,
    selectedAgentId: null,
  });
});

describe('AgentsPastConversationsList', () => {
  test('a session-bound row selects it directly — no claim, no navigation', async () => {
    mockFetchWithAuth.mockResolvedValue(conversationsResponse([BOUND_ROW]));
    renderList();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Live chat'));

    expect(mockPost).not.toHaveBeenCalled();
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-bound');
  });

  test('a session-less page row claims into a freshly spawned session and selects it', async () => {
    mockFetchWithAuth.mockResolvedValue(conversationsResponse([PAGE_ROW]));
    mockPost.mockResolvedValue({ session: { sessionId: 'ses-new' }, conversationId: 'conv-page' });
    renderList();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Page chat'));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/agent-sessions', {
        firstThing: 'claim',
        conversationId: 'conv-page',
        driveId: 'drive-1',
      }),
    );
    await waitFor(() => expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-new'));
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-page');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
    expect(mockPush).not.toHaveBeenCalled();
  });

  test('a session-less global row claims with the surface\'s own (absent) drive scope', async () => {
    mockFetchWithAuth.mockResolvedValue(conversationsResponse([GLOBAL_ROW]));
    mockPost.mockResolvedValue({ session: { sessionId: 'ses-new' }, conversationId: 'conv-global' });
    renderList();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Global assistant chat'));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/agent-sessions', {
        firstThing: 'claim',
        conversationId: 'conv-global',
        driveId: undefined,
      }),
    );
    await waitFor(() => expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-new'));
  });

  test('a capability-kind claim failure (403) degrades SILENTLY to the old page navigation — no toast', async () => {
    mockFetchWithAuth.mockResolvedValue(conversationsResponse([PAGE_ROW]));
    mockPost.mockRejectedValue(new ApiRequestError('Forbidden', 403));
    renderList();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Page chat'));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        '/dashboard/drive-1/agent-1?conversationId=conv-page',
      ),
    );
    expect(mockToastError).not.toHaveBeenCalled();
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBeNull();
  });

  test('a quota-kind claim failure (429) shows a toast AND still falls back to the old global navigation', async () => {
    mockFetchWithAuth.mockResolvedValue(conversationsResponse([GLOBAL_ROW]));
    mockPost.mockRejectedValue(new ApiRequestError('Out of sessions', 429));
    renderList();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Global assistant chat'));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockLoadConversation).toHaveBeenCalledWith('conv-global');
    expect(mockPush).toHaveBeenCalledWith('/dashboard?c=conv-global');
  });

  test('a second click while a claim is pending is ignored — no double-spawn', async () => {
    mockFetchWithAuth.mockResolvedValue(conversationsResponse([PAGE_ROW]));
    let resolveClaim!: (value: unknown) => void;
    mockPost.mockReturnValue(new Promise((resolve) => (resolveClaim = resolve)));
    renderList();
    const user = userEvent.setup();

    const row = await screen.findByText('Page chat');
    await user.click(row);
    await user.click(row);
    await user.click(row);

    expect(mockPost).toHaveBeenCalledTimes(1);
    resolveClaim({ session: { sessionId: 'ses-new' }, conversationId: 'conv-page' });
    await waitFor(() => expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-new'));
  });
});
