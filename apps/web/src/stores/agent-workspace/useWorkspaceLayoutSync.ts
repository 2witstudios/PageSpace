/**
 * Binds ONE workspace's tree to the server: read the snapshot on mount, then
 * keep it live from that workspace's own `session:<id>` room.
 *
 * That is the whole hook. It is deliberately NOT the only path any more: the
 * owner's directory plane carries the same event
 * (`workspace-nodes-listener.ts`, mounted once for the whole app), so a
 * workspace nobody is looking at still updates its sidebar rows. This hook
 * covers the other direction — a workspace a NON-owner is looking at, where the
 * per-workspace room is the only room they are in.
 *
 * Double delivery to someone who is both is expected and safe: `applyRemoteUpdate`
 * drops anything at a rev it already holds, and that guard is armed
 * synchronously by whichever copy arrives first.
 *
 * Passive: it never calls a mutation itself.
 *
 * **Reconnect is a resync, not a resume.** The broadcast transport is
 * best-effort (`agent-workspace-events.ts`), so a socket that drops may have
 * missed a rev. Rejoining the room without re-reading would leave the tree
 * quietly stale until the user's next edit 409'd; re-reading costs one request
 * and makes the healing unconditional.
 */
import { useEffect } from 'react';
import { useSocketStore } from '@/stores/useSocketStore';
import { useAgentWorkspaceStore, type WorkspaceNodesUpdatedEvent } from './useAgentWorkspaceStore';

export function useWorkspaceLayoutSync(workspaceId: string, options?: { enabled?: boolean }): void {
  const enabled = options?.enabled ?? true;
  // Subscribed, not driven: `useSocket()` also owns connection LIFECYCLE
  // (connect on auth, disconnect on logout), and a passive room listener has no
  // business doing that — every surface this hook renders under already sits
  // inside `Layout`, which calls `useSocket()`. Subscribing to the socket OBJECT
  // (not the stable accessor) is still load-bearing: the store REPLACES it on
  // the auth-refresh reconnect path, and a consumer holding the old one would
  // be listening to a permanently dead socket.
  const socket = useSocketStore((state) => state.socket);

  // Mount-time snapshot. Unconditional and server-wins over whatever the store
  // already holds STRUCTURALLY — but the unacked queue survives it and rebases
  // on top, which is what makes it safe to fire alongside anything the caller
  // is doing at the same moment.
  useEffect(() => {
    if (!enabled) return;
    void useAgentWorkspaceStore.getState().refreshWorkspaceSnapshot(workspaceId);
  }, [enabled, workspaceId]);

  useEffect(() => {
    if (!enabled || !socket) return;

    const join = () => socket.emit('join_session', workspaceId);
    join();

    const handleUpdate = (payload: WorkspaceNodesUpdatedEvent) => {
      // The room is per-workspace, but a socket can hold several; never let one
      // workspace's event land on another's cache.
      if (payload?.workspaceId !== workspaceId) return;
      useAgentWorkspaceStore.getState().applyRemoteUpdate(payload);
    };

    const handleReconnect = () => {
      join();
      void useAgentWorkspaceStore.getState().refreshWorkspaceSnapshot(workspaceId);
    };

    socket.on('workspace:nodes-updated', handleUpdate);
    socket.on('connect', handleReconnect);

    return () => {
      socket.off('workspace:nodes-updated', handleUpdate);
      socket.off('connect', handleReconnect);
      socket.emit('leave_session', workspaceId);
    };
  }, [enabled, socket, workspaceId]);
}
