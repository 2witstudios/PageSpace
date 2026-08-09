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
  sessions: [{ workspaceId: SESSION, sessionId: SESSION, conversations }],
});

const base = (overrides: Record<string, unknown> = {}) => ({
  conversationId: CONV,
  rev: 1,
  scope: { kind: 'page' as const, pageId: 'page-1' },
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

  /**
   * `created` USED TO DO SURGERY: the payload named a `workspaceId`, so the row
   * went straight into that session's cache entry with no request. The column is
   * gone — membership is an `agent_workspace_nodes` row — so the event names the
   * conversation and nothing else, and there is no key left to aim a patch at.
   *
   * Pinned as a RE-READ rather than deleted, because the liveness is the point:
   * the surgery had already stopped firing for the case it was written for (a
   * spawned worker arrived with `workspaceId: null` and took the early-return),
   * which put that sidebar row back on the 120s poll. A re-read is one request;
   * a poll is up to two minutes.
   */
  describe('conversation:created — the spawn-appears-without-a-poll case', () => {
    it('should re-read the session listings — the payload no longer says which one to patch', () => {
      renderHook(() => useSessionDirectoryListener());

      fire('conversation:created', base({
        conversation: {
          id: CONV,
          title: 'worker',
          type: 'page',
          contextId: 'agent-page-9',
          isShared: false,
          createdAt: '2024-01-01T00:00:00.000Z',
          lastMessageAt: null,
        },
      }));

      expect(mockMutate).toHaveBeenCalledTimes(1);
      // A bare revalidate: no updater, no options — nothing is written locally,
      // because nothing in the payload says where it would go.
      expect(mockMutate.mock.calls[0]).toHaveLength(1);
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

    /**
     * `workspaceId` and `closedInWorkspaceAt` used to be members of the changes
     * bag, and each drove a re-read. Both COLUMNS are gone — membership is a
     * node row — so neither is a change anything can report.
     *
     * Asserted as a NON-outcome rather than simply deleted with the code: "we
     * stopped writing those branches" and "an unknown key in the changes bag
     * does not drive a re-read from here" are different claims, and only the
     * second one stops someone reinstating them. The membership fact itself
     * rides structurally on `workspace:nodes-updated`, a plane this module
     * deliberately does not touch.
     */
    it('given a changes bag naming no field it handles, should do nothing — that plane moved', () => {
      renderHook(() => useSessionDirectoryListener());

      fire('conversation:updated', base({ changes: { closedInWorkspaceAt: null } }));

      expect(mockMutate).not.toHaveBeenCalled();
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

  /**
   * Both used to drop the row from ONE session's cache entry, keyed on the
   * payload's `workspaceId`. Same story as `created`: no key, so a re-read.
   */
  describe('conversation:closed / :deleted', () => {
    it.each(['conversation:closed', 'conversation:deleted'])('%s should re-read the session listings', (event) => {
      renderHook(() => useSessionDirectoryListener());

      fire(event, base());

      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(mockMutate.mock.calls[0]).toHaveLength(1);
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
