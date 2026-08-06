import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * The directory plane (Agent-Session SSoT epic, Phase 2 / plan PR 4): a server-side
 * conversation change reaches the session listings as an EVENT, not as the next
 * poll tick. These pin which events do targeted surgery and which fall back to a
 * re-read — the distinction is only "can the payload reconstruct a listing row".
 */

const { mockSocket, socketHandlers, mockMutate } = vi.hoisted(() => {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const socket = {
    on: (event: string, handler: (payload: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    off: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    },
    emit: vi.fn(),
  };
  return {
    mockSocket: { current: socket as typeof socket | null },
    socketHandlers: handlers,
    mockMutate: vi.fn(),
  };
});

vi.mock('@/hooks/useSocket', () => ({ useSocket: () => mockSocket.current }));
vi.mock('swr', () => ({ useSWRConfig: () => ({ mutate: mockMutate }) }));

import { useSessionDirectoryListener } from '../session-directory-listener';

const SESSION = 'ws-1';
const CONV = 'conv-1';

const fire = (event: string, payload: unknown) => {
  act(() => {
    for (const handler of socketHandlers.get(event) ?? []) handler(payload);
  });
};

/** Run the update function SWR would run, against a starting cache. */
const applyMutation = <T,>(callIndex: number, current: T): T => {
  const [, updater] = mockMutate.mock.calls[callIndex];
  return (updater as (c: T) => T)(current);
};

const listing = (conversations: Array<Record<string, unknown>>) => ({
  sessions: [{ sessionId: SESSION, conversations }],
});

const base = (overrides: Record<string, unknown> = {}) => ({
  conversationId: CONV,
  rev: 1,
  scope: { kind: 'page' as const, pageId: 'page-1' },
  workspaceId: SESSION,
  triggeredBy: { userId: 'u1', browserSessionId: 'server' },
  ...overrides,
});

describe('useSessionDirectoryListener', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketHandlers.clear();
    mockSocket.current = {
      on: (event: string, handler: (payload: unknown) => void) => {
        const list = socketHandlers.get(event) ?? [];
        list.push(handler);
        socketHandlers.set(event, list);
      },
      off: (event: string, handler: (payload: unknown) => void) => {
        socketHandlers.set(event, (socketHandlers.get(event) ?? []).filter((h) => h !== handler));
      },
      emit: vi.fn(),
    };
  });

  describe('conversation:created — the spawn-appears-without-a-poll case', () => {
    it('should write the new conversation straight into its session listing, with no request', () => {
      renderHook(() => useSessionDirectoryListener());

      fire('conversation:created', base({
        conversation: {
          id: CONV,
          title: 'worker',
          type: 'page',
          contextId: 'agent-page-9',
          workspaceId: SESSION,
          isShared: false,
          createdAt: '2024-01-01T00:00:00.000Z',
          lastMessageAt: null,
        },
      }));

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const next = applyMutation(0, listing([{ conversationId: 'conv-old', agentPageId: null, lastMessageAt: null }]));
      expect(next.sessions[0].conversations[0]).toMatchObject({
        conversationId: CONV,
        agentPageId: 'agent-page-9',
        title: 'worker',
      });
      // Most-recent-first: the new row goes to the front.
      expect(next.sessions[0].conversations.map((c) => c.conversationId)).toEqual([CONV, 'conv-old']);
      // `{ revalidate: false }` — the write IS the update; no round-trip.
      expect(mockMutate.mock.calls[0][2]).toEqual({ revalidate: false });
    });

    it('given the row is already there (the originating surface wrote it optimistically), should MERGE not duplicate', () => {
      renderHook(() => useSessionDirectoryListener());

      fire('conversation:created', base({
        conversation: {
          id: CONV,
          title: 'worker',
          type: 'page',
          contextId: 'agent-page-9',
          workspaceId: SESSION,
          isShared: false,
          createdAt: '2024-01-01T00:00:00.000Z',
          lastMessageAt: null,
        },
      }));

      const next = applyMutation(0, listing([{ conversationId: CONV, agentPageId: 'agent-page-9', lastMessageAt: null }]));
      expect(next.sessions[0].conversations).toHaveLength(1);
      expect(next.sessions[0].conversations[0]).toMatchObject({ conversationId: CONV, title: 'worker' });
    });

    it('given a global conversation with no workspace, should touch no session listing', () => {
      renderHook(() => useSessionDirectoryListener());

      fire('conversation:created', base({ workspaceId: null, conversation: { id: CONV, title: null, type: 'global', contextId: null, workspaceId: null, isShared: false, createdAt: 'x', lastMessageAt: null } }));

      expect(mockMutate).not.toHaveBeenCalled();
    });
  });

  describe('conversation:updated', () => {
    it('given a lastMessageAt bump, should patch it in place and re-sort the listing', () => {
      renderHook(() => useSessionDirectoryListener());

      fire('conversation:updated', base({ changes: { lastMessageAt: '2024-06-01T00:00:00.000Z' } }));

      const next = applyMutation(0, listing([
        { conversationId: 'conv-newer', agentPageId: null, lastMessageAt: '2024-03-01T00:00:00.000Z' },
        { conversationId: CONV, agentPageId: null, lastMessageAt: '2024-01-01T00:00:00.000Z' },
      ]));
      expect(next.sessions[0].conversations.map((c) => c.conversationId)).toEqual([CONV, 'conv-newer']);
    });

    it('given a workspace re-binding, should re-read — which row lives where is what this cache holds', () => {
      renderHook(() => useSessionDirectoryListener());

      fire('conversation:updated', base({ changes: { workspaceId: 'ws-2' } }));

      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(mockMutate.mock.calls[0]).toHaveLength(1); // bare revalidate: no updater, no options
    });

    it('given a listing-membership stamp change, should re-read', () => {
      renderHook(() => useSessionDirectoryListener());

      fire('conversation:updated', base({ changes: { closedInSessionAt: null } }));

      expect(mockMutate.mock.calls[0]).toHaveLength(1);
    });

    it('given a rename, should re-read (the row renders the title)', () => {
      renderHook(() => useSessionDirectoryListener());

      fire('conversation:updated', base({ changes: { title: 'renamed' } }));

      expect(mockMutate.mock.calls[0]).toHaveLength(1);
    });

    it('given an update with no changes bag at all, should do nothing', () => {
      renderHook(() => useSessionDirectoryListener());

      fire('conversation:updated', base({}));

      expect(mockMutate).not.toHaveBeenCalled();
    });
  });

  describe('conversation:closed / :deleted', () => {
    it.each(['conversation:closed', 'conversation:deleted'])('%s should drop the row from its session listing', (event) => {
      renderHook(() => useSessionDirectoryListener());

      fire(event, base());

      const next = applyMutation(0, listing([
        { conversationId: CONV, agentPageId: null, lastMessageAt: null },
        { conversationId: 'conv-keep', agentPageId: null, lastMessageAt: null },
      ]));
      expect(next.sessions[0].conversations.map((c) => c.conversationId)).toEqual(['conv-keep']);
    });

    it('given no workspace on the payload, should do nothing', () => {
      renderHook(() => useSessionDirectoryListener());

      fire('conversation:closed', base({ workspaceId: null }));

      expect(mockMutate).not.toHaveBeenCalled();
    });
  });

  describe('re-read cases', () => {
    it('conversation:reopened should re-read — the row left the cache and the event is id-level', () => {
      renderHook(() => useSessionDirectoryListener());

      fire('conversation:reopened', base());

      expect(mockMutate.mock.calls[0]).toHaveLength(1);
    });

    it.each(['session:created', 'session:updated', 'session:ended'])('%s should re-read', (event) => {
      renderHook(() => useSessionDirectoryListener());

      fire(event, {});

      expect(mockMutate.mock.calls[0]).toHaveLength(1);
    });

    it('a reconnect should re-read — the directory has no watermark to heal against', () => {
      renderHook(() => useSessionDirectoryListener());

      fire('connect', undefined);

      expect(mockMutate.mock.calls[0]).toHaveLength(1);
    });
  });

  it('should unsubscribe every handler on unmount', () => {
    const { unmount } = renderHook(() => useSessionDirectoryListener());
    unmount();

    for (const handlers of socketHandlers.values()) {
      expect(handlers).toHaveLength(0);
    }
  });

  it('given no socket yet, should register nothing rather than throw', () => {
    mockSocket.current = null;

    expect(() => renderHook(() => useSessionDirectoryListener())).not.toThrow();
    expect(socketHandlers.size).toBe(0);
  });
});
