'use client';

import { useEffect } from 'react';
import { Bot } from 'lucide-react';

import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';

/**
 * The Agents console: mounted for the lifetime of the route, whatever is
 * selected inside it.
 *
 * That sentence is the whole architecture. Selection lives in the query string
 * and is written with `history.pushState` (see `useAgentSurfaceStore`), so
 * clicking through agents and conversations changes what this component RENDERS
 * without changing the route — nothing above it remounts, and a live shell or a
 * streaming chat survives every click. The Development surface put the selection
 * in the path and needed `MachineKeepAliveHost` to render machines outside the
 * route tree just to survive its own navigation; that component has no successor
 * here because it has no problem to solve.
 *
 * This phase ships the shell and the empty state. The session view — the agent
 * header, the sandbox chip, chat, and the shell tabs — mounts here next.
 */
export default function AgentsSurface({ driveId }: { driveId?: string }) {
  const hydrateFromSearch = useAgentSurfaceStore((state) => state.hydrateFromSearch);
  const selectedConversationId = useAgentSurfaceStore((state) => state.selectedConversationId);
  const selectedAgentId = useAgentSurfaceStore((state) => state.selectedAgentId);

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
      {selectedConversationId || selectedAgentId ? (
        <SelectionPlaceholder />
      ) : (
        <EmptyState
          title="Select an agent"
          description="Pick an agent from the sidebar to open its conversations."
        />
      )}
    </div>
  );
}

/**
 * The resting state of a selection that has nothing to render yet. Distinct from
 * the "nothing selected" empty state on purpose: a user who just clicked an
 * agent should see that the click landed, not the same prompt telling them to
 * click one.
 */
function SelectionPlaceholder() {
  return (
    <EmptyState
      title="Conversation view coming next"
      description="The chat and shells for this conversation land in the next phase."
    />
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
