/**
 * The Agents console's default middle-panel view — every past conversation
 * the requester owns. The behavior worth pinning: clicking an unbound
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

// Spies on the shared `/api/agent-workspaces**` invalidation only — `useSWR`
// and `SWRConfig` stay real so this component's own data fetching (via the
// isolated per-test Map provider below) is unaffected.
const mockMutate = vi.hoisted(() => vi.fn());
vi.mock('swr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('swr')>();
  return { ...actual, mutate: (...args: unknown[]) => mockMutate(...args) };
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
import { isAgentWorkspacesKey } from '../panes/workspace-conversations';
import type { PastConversationDTO } from '@/lib/agent-workspaces/past-conversation-dto';

/**
 * The wire shape, imported — NOT re-declared here. A private `interface Row`
 * used to live in this file saying `sessionId`, and that is precisely how the
 * bug stayed invisible: these tests fed the component rows shaped like the
 * client's wrong belief, so they agreed with it. Fixtures now come from the
 * one declaration the server is derived from as well
 * (`past-conversation-dto.ts`), so a rename breaks this file too.
 */
type Row = PastConversationDTO;

/** A real cuid2 — `claimConflictWorkspaceId` refuses anything that is not one. */
const OWNER_WORKSPACE_ID = 'nshgif165q8ehrnjgx9jvqxc';

const PAGE_ROW: Row = {
  conversationId: 'conv-page',
  title: 'Page chat',
  type: 'page' as const,
  agentPageId: 'agent-1',
  pageTitle: 'Researcher',
  lastMessageAt: '2026-07-28T00:00:00.000Z',
  createdAt: '2026-07-28T00:00:00.000Z',
  workspaceId: null,
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
  workspaceId: null,
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
  workspaceId: 'ses-1',
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
  test('a workspace-bound row selects it directly — no claim, no navigation', async () => {
    mockFetchWithAuth.mockResolvedValue(conversationsResponse([BOUND_ROW]));
    renderList();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Live chat'));

    expect(mockPost).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-bound');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
  });

  test('a 409 naming the owning workspace opens THAT workspace — it never leaves the surface', async () => {
    // The race this exists for: another tab (or a claim that landed between
    // this listing's fetch and the click) already claimed the conversation,
    // so the row is stale and the claim is refused. The refusal names the
    // winner, and "already belongs to a session" is the answer, not a dead
    // end — before this, it fell through to `navigateFallback` and pushed the
    // user to /dashboard.
    mockFetchWithAuth.mockResolvedValue(conversationsResponse([PAGE_ROW]));
    mockPost.mockRejectedValue(
      new ApiRequestError('That conversation already belongs to a session', 409, {
        error: 'That conversation already belongs to a session',
        // A real cuid2 — the client validates the shape, so `ses-owner` would
        // be refused as an id no `agentWorkspaces.id` could hold.
        workspaceId: OWNER_WORKSPACE_ID,
      }),
    );
    renderList();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Page chat'));

    await waitFor(() => expect(useAgentSurfaceStore.getState().selectedSessionId).toBe(OWNER_WORKSPACE_ID));
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-page');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
    // The winning workspace was minted by another tab, so this tab's shared
    // listing has never seen it — the panes render off that listing, so it
    // must be revalidated or the selection points at nothing until the 20s
    // poll happens to fire.
    expect(mockMutate).toHaveBeenCalledWith(isAgentWorkspacesKey);
  });

  test('a 409 naming an UNOPENABLE workspace falls back — the server withheld the id', async () => {
    // The server omits `workspaceId` when the caller cannot open that
    // workspace (it can hold a conversation you own inside a drive session you
    // have since lost membership of). Nothing to select into, so the
    // pre-existing degrade is right — and the client must not invent one.
    mockFetchWithAuth.mockResolvedValue(conversationsResponse([PAGE_ROW]));
    mockPost.mockRejectedValue(
      new ApiRequestError('That conversation already belongs to a session', 409, {
        error: 'That conversation already belongs to a session',
      }),
    );
    renderList();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Page chat'));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith('/dashboard/drive-1/agent-1?conversationId=conv-page'),
    );
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBeNull();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  test('a 409 that names no workspace still falls back — nothing to open', async () => {
    // The route's other 409: a `type: 'client'` conversation, refused because
    // no in-app viewer can host it. There is no workspace to select into, so
    // the pre-existing degrade is still the right answer.
    mockFetchWithAuth.mockResolvedValue(conversationsResponse([PAGE_ROW]));
    mockPost.mockRejectedValue(
      new ApiRequestError('That conversation is not available', 409, { error: 'That conversation is not available' }),
    );
    renderList();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Page chat'));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith('/dashboard/drive-1/agent-1?conversationId=conv-page'),
    );
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBeNull();
  });

  test('an unbound page row claims into a freshly spawned session and selects it', async () => {
    mockFetchWithAuth.mockResolvedValue(conversationsResponse([PAGE_ROW]));
    mockPost.mockResolvedValue({ session: { workspaceId: 'ses-new', sessionId: 'ses-new' }, conversationId: 'conv-page' });
    renderList();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Page chat'));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/agent-workspaces', {
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

  test('a successful claim invalidates the shared sessions cache so the sidebar picks it up', async () => {
    mockFetchWithAuth.mockResolvedValue(conversationsResponse([PAGE_ROW]));
    mockPost.mockResolvedValue({ session: { workspaceId: 'ses-new', sessionId: 'ses-new' }, conversationId: 'conv-page' });
    renderList();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Page chat'));

    await waitFor(() => expect(mockMutate).toHaveBeenCalledWith(isAgentWorkspacesKey));
  });

  test('a failed claim does NOT invalidate the shared sessions cache', async () => {
    mockFetchWithAuth.mockResolvedValue(conversationsResponse([PAGE_ROW]));
    mockPost.mockRejectedValue(new ApiRequestError('Forbidden', 403));
    renderList();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Page chat'));

    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(mockMutate).not.toHaveBeenCalled();
  });

  test('an unbound global row claims with the surface\'s own (absent) drive scope', async () => {
    mockFetchWithAuth.mockResolvedValue(conversationsResponse([GLOBAL_ROW]));
    mockPost.mockResolvedValue({ session: { workspaceId: 'ses-new', sessionId: 'ses-new' }, conversationId: 'conv-global' });
    renderList();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Global assistant chat'));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/agent-workspaces', {
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
    resolveClaim({ session: { workspaceId: 'ses-new', sessionId: 'ses-new' }, conversationId: 'conv-page' });
    await waitFor(() => expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-new'));
  });
});
