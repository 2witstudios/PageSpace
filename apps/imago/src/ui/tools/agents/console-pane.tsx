'use client';

import { useEffect, type ReactNode } from 'react';
import { renderToolPane, type ToolPaneProps } from '../../frame/tool-pane/tool-pane.render';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import AgentsSidebar from '@/retained/components/layout/left-sidebar/AgentsSidebar';
import { ALL_DRIVES } from '@/retained/lib/dashboard/focus';
import { useAgentSurfaceStore } from '@/retained/stores/agents/useAgentSurfaceStore';
import { dispatch, transactions } from '../../store/transactions';

/**
 * The Console's pane (C-Drive-Agents): classic's Agents sidebar reused as it is. The drive's
 * environments and its own-sandbox sessions sit side by side, each session expanding to its
 * conversations, page panes and shells. Every row opens into the session's pane grid; nothing
 * here navigates away, so live shells and streaming chats survive every click. On Home, the
 * dashboard, it lists every drive's sessions, as classic's All drives focus does.
 */
export function ConsolePane({ driveId, close, variant, scope: scopeSwitch = null, allDrives = false }: ToolPaneProps & { readonly allDrives?: boolean }): ReactNode {
  // A pick here writes its URL from the store's drive scope. The route's AgentsSurface sets it
  // too, but a phone shows this pane as its screen without the route, so the pane sets it itself.
  const scope = allDrives ? null : driveId;
  useEffect(() => {
    useAgentSurfaceStore.setState({ driveId: scope });
  }, [scope]);
  // Every row here selects through the agent surface store, the same session included (a page
  // or shell row reselects it), and changes only the query. Each selection closes the narrow
  // pane sheet, as a navigation does, so the pane it opened is not left covered.
  useEffect(
    () =>
      useAgentSurfaceStore.subscribe((state, previous) => {
        if (state.driveId === previous.driveId) dispatch(transactions.closePaneSheet, undefined);
      }),
    [],
  );
  return renderToolPane({
    title: 'Console',
    label: 'Console: sessions',
    close,
    scope: scopeSwitch,
    variant,
    children: (
      <RetainedSurface>
        <AgentsSidebar focus={allDrives ? ALL_DRIVES : undefined} />
      </RetainedSurface>
    ),
  });
}
