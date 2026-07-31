'use client';

import { useCallback, useEffect } from 'react';
import { Bot } from 'lucide-react';

import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import { panesOf } from '@/stores/agent-workspace/pane-reducer';
import { useLatestRef } from '@/hooks/useLatestRef';
import { useSessionRecord } from './useSessionRecord';
import AgentPanes from './panes/AgentPanes';

/**
 * The Agents console: mounted for the lifetime of the route, whatever is
 * selected inside it.
 *
 * That sentence is the whole architecture. Selection lives in the query string
 * and is written with `history.pushState` (see `useAgentSurfaceStore`), so
 * clicking through sessions and conversations changes what this component
 * RENDERS without changing the route — nothing above it remounts, and a live
 * shell or a streaming chat survives every click. The Development surface put
 * the selection in the path and needed `MachineKeepAliveHost` to render
 * machines outside the route tree just to survive its own navigation; that
 * component has no successor here because it has no problem to solve.
 *
 * The centre is a PANE GRID (`AgentPanes`), keyed by the SESSION: switching
 * sessions swaps the whole grid (its layout persists in the workspace store and
 * the PTYs persist server-side), while everything inside one session — splits,
 * conversations with different agents, shells — lives in panes, never tabs,
 * and never in the sidebar.
 */
export default function AgentsSurface({ driveId }: { driveId?: string }) {
  const hydrateFromSearch = useAgentSurfaceStore((state) => state.hydrateFromSearch);
  const selectedSessionId = useAgentSurfaceStore((state) => state.selectedSessionId);
  const selectedConversationId = useAgentSurfaceStore((state) => state.selectedConversationId);
  const selectedAgentId = useAgentSurfaceStore((state) => state.selectedAgentId);
  const selectSession = useAgentSurfaceStore((state) => state.selectSession);
  const selectConversation = useAgentSurfaceStore((state) => state.selectConversation);
  const storeDriveId = useAgentSurfaceStore((state) => state.driveId);

  const { data: sessionData } = useSessionRecord(selectedSessionId);
  // The session's own drive wins; the surface's drive covers the in-flight
  // window (they agree in drive mode, and global mode has nothing better).
  // Checked as `sessionData?.session ?  : ` rather than `??` — `driveId` on a
  // RESOLVED session can itself legitimately be `null` (a global session),
  // which `??` would wrongly treat as "unresolved" and fall through to
  // `storeDriveId` (caught alongside the AgentPageView cross-drive fix).
  const sessionDriveId = sessionData?.session ? sessionData.session.driveId : storeDriveId;

  // The server is the authority on whether the selected session still
  // exists. `session: null` means it doesn't (ended elsewhere, reaped,
  // never existed) — forget its persisted grid rather than let a dead
  // workspace sit in `localStorage` forever, and back out of it the same way
  // a deep link to nothing does (issue #2263, finding 6: GC on the one
  // signal this surface already has, rather than a new sweep).
  useEffect(() => {
    if (selectedSessionId && sessionData && sessionData.session === null) {
      useAgentWorkspaceStore.getState().forgetWorkspace(selectedSessionId);
      selectSession(null);
    }
  }, [selectedSessionId, sessionData, selectSession]);

  // Deep link, refresh, and Back are the same operation: read the URL. `popstate`
  // needs nothing beyond re-reading it, because the browser has already restored
  // the address by the time the event fires.
  useEffect(() => {
    hydrateFromSearch({ driveId });
    const onPopState = () => hydrateFromSearch();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [hydrateFromSearch, driveId]);

  // The LATEST selection, read at completion time rather than trusted from a
  // closure captured before an await: `AgentPanes`' close DELETE can still be
  // in flight when the user picks a different conversation in this SAME
  // session, and the callback that eventually fires is the ONE that closed
  // over the selection at the moment the close started — a plain destructure
  // here would still match the now-stale `conversationId` and clobber the
  // user's newer pick with the computed rebind target (caught in review).
  const selectionRef = useLatestRef({ selectedConversationId, selectedSessionId });

  // The grid closed the conversation THIS surface has selected — follow so
  // this surface's own selection (and the URL it mirrors to) stays truthful.
  // A closed conversation this surface was NOT showing (some other pane in
  // the grid) is none of its business. Two shapes:
  // - grid-last close: `next` names the pane's rebind target — follow it.
  // - ordinary close (the grid still has other panes): `next` is always
  //   null, since rebinding is only for an EMPTIED grid — but the selection
  //   is now just as stale, still naming a conversation with no listing left.
  //   Retarget to another OPEN chat pane still in the grid so a refresh or a
  //   deep link back to this URL doesn't reopen the closed conversation and
  //   silently replace whatever pane is actually live. If no other chat pane
  //   remains (e.g. only a terminal, or the session's other open listing has
  //   no pane here at all — a background worker minted one), CLEAR the
  //   selection instead of leaving it stale: showing "pick a conversation" is
  //   honest and recoverable, where keeping the closed id risks silently
  //   reopening it (or hiding a still-open listing) on the next refresh or
  //   deep link (caught in review — the first pass here left this case
  //   untouched).
  const handleConversationClosed = useCallback(
    (event: { conversationId: string; next: string | null; nextAgentPageId: string | null }) => {
      const { selectedConversationId: currentConversationId, selectedSessionId: currentSessionId } =
        selectionRef.current;
      if (event.conversationId !== currentConversationId || !currentSessionId) return;
      if (event.next !== null) {
        selectConversation({ sessionId: currentSessionId, conversationId: event.next, agentId: event.nextAgentPageId });
        return;
      }
      const workspace = useAgentWorkspaceStore.getState().workspaces[currentSessionId];
      const replacement = workspace
        ? panesOf(workspace).find(
            (pane) =>
              pane.scope?.kind === 'chat' && pane.scope.targetId !== null && pane.scope.targetId !== event.conversationId,
          )
        : undefined;
      selectConversation({
        sessionId: currentSessionId,
        conversationId: replacement?.scope?.targetId ?? null,
        agentId: replacement?.scope?.agentPageId ?? null,
      });
    },
    [selectConversation, selectionRef],
  );

  return (
    <div className="flex h-full flex-col">
      {selectedSessionId && selectedConversationId ? (
        <AgentPanes
          key={selectedSessionId}
          sessionId={selectedSessionId}
          driveId={sessionDriveId}
          initialConversation={{
            conversationId: selectedConversationId,
            agentPageId: selectedAgentId,
            name: 'Conversation',
          }}
          onSessionEnded={() => selectSession(null)}
          onConversationClosed={handleConversationClosed}
        />
      ) : selectedSessionId ? (
        // A session is selected but its opening conversation has not resolved
        // from the URL (a hand-trimmed link). The sidebar's session rows always
        // write both, so this is the degenerate-deep-link case, not a step in
        // the normal flow.
        <EmptyState
          title="Pick a conversation"
          description="This session's conversations are listed under it in the sidebar."
        />
      ) : (
        <EmptyState
          title="Select a session"
          description="Pick a session from the sidebar, or start a new one."
        />
      )}
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Bot className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
