'use client';

import { useEffect } from 'react';
import { Bot } from 'lucide-react';
import useSWR from 'swr';

import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import AgentPanes from './panes/AgentPanes';

/**
 * The selected session's own record — the authority on ITS drive. The surface
 * store only knows the drive the CONSOLE is mounted under, which is null on
 * `/dashboard/agents`; passing that to the grid left every drive session's
 * pane picker with no agents to offer in global mode (review M5).
 */
async function sessionFetcher(url: string): Promise<{ session: { driveId: string | null } | null }> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to load session (${response.status})`);
  return response.json();
}

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
  const storeDriveId = useAgentSurfaceStore((state) => state.driveId);

  const { data: sessionData } = useSWR(
    selectedSessionId ? `/api/agent-sessions/${encodeURIComponent(selectedSessionId)}` : null,
    sessionFetcher,
    { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );
  // The session's own drive wins; the surface's drive covers the in-flight
  // window (they agree in drive mode, and global mode has nothing better).
  const sessionDriveId = sessionData?.session?.driveId ?? storeDriveId;

  // Deep link, refresh, and Back are the same operation: read the URL. `popstate`
  // needs nothing beyond re-reading it, because the browser has already restored
  // the address by the time the event fires.
  useEffect(() => {
    hydrateFromSearch({ driveId });
    const onPopState = () => hydrateFromSearch();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [hydrateFromSearch, driveId]);

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
