/**
 * Binds one session's pane grid to the server: read the snapshot on mount,
 * then keep it live from the `session:<id>` room.
 *
 * That is the WHOLE hook. Its predecessor (`useWorkspaceServerSync`, deleted
 * with this PR) also owned a debounced PUT of the entire grid, an in-flight
 * race guard, a force-flush on unmount, and two hydration latches
 * (`hydratedSessionsThisPageLoad` + `adoptServerWorkspaceAsHydrated`) whose
 * only job was to arbitrate between a local seed and a server-wins fetch.
 * None of that survives: writes now leave the store as individual verbs the
 * moment they happen (`useAgentWorkspaceStore`), and arbitration is a rev
 * plus a replayable queue — a local seed racing this fetch simply 409s once
 * and rebases.
 *
 * Passive, exactly like its predecessor: it never calls a transition itself.
 *
 * **Reconnect is a resync, not a resume.** The broadcast transport is
 * best-effort (`agent-workspace-events.ts`), so a socket that drops may have
 * missed a rev. Rejoining the room without re-reading the snapshot would
 * leave the grid quietly stale until the user's next edit 409'd; re-reading
 * costs one request and makes the healing unconditional.
 */
import { useEffect } from 'react';
import { useSocketStore } from '@/stores/useSocketStore';
import { useAgentWorkspaceStore, type WorkspaceUpdatedEvent } from './useAgentWorkspaceStore';

export function useWorkspaceLayoutSync(workspaceId: string, options?: { enabled?: boolean }): void {
  const enabled = options?.enabled ?? true;
  // Subscribed, not driven: `useSocket()` also owns connection LIFECYCLE
  // (connect on auth, disconnect on logout), and a passive room listener has
  // no business doing that — every surface this hook renders under already
  // sits inside `Layout`, which calls `useSocket()`. Subscribing to the
  // socket OBJECT (not the stable accessor) is still load-bearing: the store
  // REPLACES it on the auth-refresh reconnect path, and a consumer holding
  // the old one would be listening to a permanently dead socket.
  const socket = useSocketStore((state) => state.socket);

  // Mount-time snapshot. Unconditional and server-wins over whatever the
  // store already holds STRUCTURALLY — but the unacked queue survives it and
  // replays on top, which is what makes it safe to fire alongside the
  // caller's own mount-time seeding (the seed's verb is still queued, so it
  // is re-applied to the server's grid rather than lost to it).
  useEffect(() => {
    if (!enabled) return;
    void useAgentWorkspaceStore.getState().refreshWorkspaceSnapshot(workspaceId);
  }, [enabled, workspaceId]);

  useEffect(() => {
    if (!enabled || !socket) return;

    const join = () => socket.emit('join_session', workspaceId);
    join();

    const handleUpdate = (payload: WorkspaceUpdatedEvent) => {
      // The room is per-workspace, but a socket can hold several; never let
      // one session's event land on another's cache.
      if (payload?.workspaceId !== workspaceId) return;
      useAgentWorkspaceStore.getState().applyRemoteUpdate(payload);
    };

    const handleReconnect = () => {
      join();
      void useAgentWorkspaceStore.getState().refreshWorkspaceSnapshot(workspaceId);
    };

    socket.on('workspace:updated', handleUpdate);
    socket.on('connect', handleReconnect);

    return () => {
      socket.off('workspace:updated', handleUpdate);
      socket.off('connect', handleReconnect);
      socket.emit('leave_session', workspaceId);
    };
  }, [enabled, socket, workspaceId]);
}
