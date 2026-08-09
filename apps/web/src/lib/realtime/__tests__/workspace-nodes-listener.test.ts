import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * THE LAYOUT PLANE, app-wide — the hook that closes the epic's headline
 * symptom.
 *
 * A pane an agent placed reached only the workspace's own `session:<id>` room,
 * which nothing joins unless that workspace's grid is mounted. So the sidebar
 * learned about it from the 120s backstop poll: up to two minutes for a row to
 * appear, for a change that had already committed. The owner's own
 * `user:<id>:sessions` room carries the same event now, and this translates it
 * into the one thing it should — `applyRemoteUpdate`.
 *
 * The properties worth pinning are the ones a broadcast plane always needs: it
 * must not RESURRECT a workspace the store has stopped tracking, it must survive
 * a garbage payload, and it must unsubscribe.
 */

const { mockSocket, socketHandlers } = vi.hoisted(() => {
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
  return { mockSocket: { current: socket as typeof socket | null }, socketHandlers: handlers };
});

vi.mock('@/hooks/useSocket', () => ({ useSocket: () => mockSocket.current }));

const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

import { useWorkspaceNodesListener } from '../workspace-nodes-listener';
import {
  useAgentWorkspaceStore,
  __resetWorkspaceQueuesForTests,
} from '@/stores/agent-workspace/useAgentWorkspaceStore';
import type { WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';

const WS = 'ws-1';
const root: WorkspaceNode = { nodeType: 'root', id: WS, parentId: null, position: 0, axis: 'row' };
const pane = (id: string, parentId: string | null, position: number, conversationId: string): WorkspaceNode => ({
  nodeType: 'pane',
  id,
  parentId,
  position,
  target: { kind: 'chat', id: conversationId },
});

const fire = (payload: unknown) => {
  act(() => {
    for (const handler of socketHandlers.get('workspace:nodes-updated') ?? []) handler(payload);
  });
};

const tree = () => useAgentWorkspaceStore.getState().workspaces[WS];

beforeEach(() => {
  socketHandlers.clear();
  mockFetchWithAuth.mockReset();
  mockFetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));
  __resetWorkspaceQueuesForTests();
  useAgentWorkspaceStore.setState({ workspaces: {}, sync: {}, focus: {}, queueErrors: {} });
});

describe('useWorkspaceNodesListener', () => {
  it('subscribes to the layout event exactly once', () => {
    renderHook(() => useWorkspaceNodesListener());
    expect(socketHandlers.get('workspace:nodes-updated')).toHaveLength(1);
  });

  it('unsubscribes on unmount, so a remount does not double-apply', () => {
    const { unmount } = renderHook(() => useWorkspaceNodesListener());
    unmount();
    expect(socketHandlers.get('workspace:nodes-updated') ?? []).toHaveLength(0);
  });

  /** THE POINT: no poll, no refetch, no per-workspace room — the row just updates. */
  it('adopts a tree for a workspace the store is tracking, with no request at all', () => {
    useAgentWorkspaceStore.getState().hydrateFromServer(WS, { rev: 1, nodes: [root], targets: [] });
    renderHook(() => useWorkspaceNodesListener());

    fire({ workspaceId: WS, rev: 2, nodes: [root, pane('n1', WS, 0, 'conv-1')] });

    expect(tree().rev).toBe(2);
    expect(tree().nodes).toHaveLength(2);
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  /**
   * The owner's room carries events for EVERY workspace they own, and the store
   * is not a mirror of the account — it is a cache of what is open. Seating one
   * here would resurrect a workspace the user just ended.
   */
  it('does not seat a workspace the store is not tracking', () => {
    renderHook(() => useWorkspaceNodesListener());
    fire({ workspaceId: WS, rev: 2, nodes: [root] });
    expect(tree()).toBeUndefined();
  });

  it('does not resurrect a workspace that was forgotten', () => {
    useAgentWorkspaceStore.getState().hydrateFromServer(WS, { rev: 1, nodes: [root], targets: [] });
    useAgentWorkspaceStore.getState().forgetWorkspace(WS);
    renderHook(() => useWorkspaceNodesListener());

    fire({ workspaceId: WS, rev: 9, nodes: [root, pane('n1', WS, 0, 'conv-1')] });

    expect(tree()).toBeUndefined();
  });

  /**
   * DOUBLE DELIVERY. Someone who both owns the workspace and has its grid
   * mounted is in both rooms, so this hook and `useWorkspaceLayoutSync` each get
   * a copy. The rev guard is armed synchronously by whichever lands first.
   */
  it('is idempotent across a duplicate delivery of the same event', () => {
    useAgentWorkspaceStore.getState().hydrateFromServer(WS, { rev: 1, nodes: [root], targets: [] });
    renderHook(() => useWorkspaceNodesListener());
    const event = { workspaceId: WS, rev: 2, nodes: [root, pane('n1', WS, 0, 'conv-1')] };

    fire(event);
    const afterFirst = tree();
    fire(event);

    expect(tree()).toBe(afterFirst);
  });

  it('survives a payload with no workspaceId rather than throwing on the socket', () => {
    renderHook(() => useWorkspaceNodesListener());
    expect(() => fire(undefined)).not.toThrow();
    expect(() => fire({ rev: 2, nodes: [] })).not.toThrow();
  });

  it('refuses a payload whose tree is invalid, leaving the last good one in place', () => {
    useAgentWorkspaceStore.getState().hydrateFromServer(WS, {
      rev: 1,
      nodes: [root, pane('n1', WS, 0, 'conv-1')],
      targets: [],
    });
    renderHook(() => useWorkspaceNodesListener());

    // Two roots — a tree the server would never store and this client must
    // never adopt, or every later local edit is refused by the same gate.
    fire({
      workspaceId: WS,
      rev: 2,
      nodes: [root, { nodeType: 'root', id: 'second', parentId: null, position: 0, axis: 'row' }],
    });

    expect(tree().rev).toBe(1);
    expect(tree().nodes).toHaveLength(2);
  });

  it('does nothing at all when there is no socket yet', () => {
    mockSocket.current = null;
    expect(() => renderHook(() => useWorkspaceNodesListener())).not.toThrow();
    expect(socketHandlers.get('workspace:nodes-updated') ?? []).toHaveLength(0);
  });
});
