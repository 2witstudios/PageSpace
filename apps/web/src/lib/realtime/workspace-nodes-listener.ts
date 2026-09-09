'use client';

import { useEffect } from 'react';
import { useSocket } from '@/hooks/useSocket';
import { useAgentWorkspaceStore, type WorkspaceNodesUpdatedEvent } from '@/stores/agent-workspace/useAgentWorkspaceStore';

/**
 * `useWorkspaceNodesListener` — the LAYOUT plane, app-wide.
 *
 * This is the hook that closes the epic's headline symptom. A pane an agent
 * placed — or one the user opened in another tab — reached only the workspace's
 * own `session:<id>` room, which nothing joins unless that workspace's grid is
 * mounted. So the sidebar learned about it from the 120s backstop poll: up to
 * two minutes for a row to appear, for a change that had already committed.
 *
 * The server now also emits `workspace:nodes-updated` to the OWNER's
 * `user:<id>:sessions` room — joined automatically at connect, no subscription
 * call — and this translates it into the one thing it should:
 * `applyRemoteUpdate`, which is `hydrateFromServer`'s structural sibling. There
 * is no SWR surgery here and there should not be, because the tree is not in
 * SWR: the store holds it, and both renderings read the store.
 *
 * **MOUNTED EXACTLY ONCE**, from `GlobalChatProvider` (which wraps the whole
 * Layout), for the same reason `SessionDirectoryListener` and
 * `DerivedStreamingRegistrations` are: the tree is app-wide state, and N mounted
 * copies would be N identical adoptions per event.
 *
 * **A SIBLING of `SessionDirectoryListener`, not a branch inside it.** That
 * module's own doc scopes it to targeted SWR surgery on the
 * `/api/agent-workspaces**` listings — a cache of conversation ROWS. This is a
 * different plane with a different store, a different correctness argument (a
 * rev watermark rather than best-effort revalidation) and a different failure
 * mode. Folding one into the other would give the pair a doc that describes
 * neither.
 *
 * **It cannot resurrect anything.** `applyRemoteUpdate` returns immediately for
 * a workspace the store is not tracking, so an event for one the user just
 * ended, or one they have never opened, seats nothing. That is deliberate: the
 * owner's room carries events for EVERY workspace they own, and the store is
 * not a mirror of the account — it is a cache of what is open.
 *
 * BEST-EFFORT, like every broadcast. A missed event costs one stale tree until
 * the next event, the next listing revalidation, or the surface's own reconnect
 * resync — never correctness, which the rev carries.
 */
export function useWorkspaceNodesListener(): void {
  const socket = useSocket();

  useEffect(() => {
    if (!socket) return;

    const handleNodesUpdated = (payload: WorkspaceNodesUpdatedEvent) => {
      if (!payload?.workspaceId) return;
      useAgentWorkspaceStore.getState().applyRemoteUpdate(payload);
    };

    socket.on('workspace:nodes-updated', handleNodesUpdated);
    return () => {
      socket.off('workspace:nodes-updated', handleNodesUpdated);
    };
  }, [socket]);
}

/**
 * Component wrapper, so the one mount site is a JSX line beside
 * `SessionDirectoryListener` rather than a hook call buried in the provider's
 * body. Renders nothing.
 */
export function WorkspaceNodesListener(): null {
  useWorkspaceNodesListener();
  return null;
}
