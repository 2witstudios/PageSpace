'use client';

import { useEffect, type ReactNode } from 'react';
import { renderToolPane, type ToolPaneProps } from '../../frame/tool-pane/tool-pane.render';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import AgentsSidebar from '@/retained/components/layout/left-sidebar/AgentsSidebar';
import { ALL_DRIVES } from '@/retained/lib/dashboard/focus';
import { useAgentSurfaceStore } from '@/retained/stores/agents/useAgentSurfaceStore';

/**
 * The Console's pane (C-Drive-Agents): classic's Agents sidebar reused as it is. The drive's
 * environments and its own-sandbox sessions sit side by side, each session expanding to its
 * conversations, page panes and shells. Every row opens into the session's pane grid; nothing
 * here navigates away, so live shells and streaming chats survive every click. On Home, the
 * dashboard, it lists every drive's sessions, as classic's All drives focus does.
 */
export function ConsolePane({ driveId, close, allDrives = false }: ToolPaneProps & { readonly allDrives?: boolean }): ReactNode {
  // A pick here writes its URL from the store's drive scope. The route's AgentsSurface sets it
  // too, but a phone shows this pane as its screen without the route, so the pane sets it itself.
  const scope = allDrives ? null : driveId;
  useEffect(() => {
    useAgentSurfaceStore.setState({ driveId: scope });
  }, [scope]);
  return renderToolPane({
    title: 'Console',
    label: 'Console: sessions',
    close,
    children: (
      <RetainedSurface>
        <AgentsSidebar focus={allDrives ? ALL_DRIVES : undefined} />
      </RetainedSurface>
    ),
  });
}
