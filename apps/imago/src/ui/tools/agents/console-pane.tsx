'use client';

import type { ReactNode } from 'react';
import { renderToolPane, type ToolPaneProps } from '../../frame/tool-pane/tool-pane.render';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import AgentsSidebar from '@/retained/components/layout/left-sidebar/AgentsSidebar';

/**
 * The Console's pane (C-Drive-Agents): classic's Agents sidebar reused as it is. The drive's
 * environments and its own-sandbox sessions sit side by side, each session expanding to its
 * conversations, page panes and shells. Every row opens into the session's pane grid; nothing
 * here navigates away, so live shells and streaming chats survive every click.
 */
export function ConsolePane({ close }: ToolPaneProps): ReactNode {
  return renderToolPane({
    title: 'Console',
    label: 'Console: sessions',
    close,
    children: (
      <RetainedSurface>
        <AgentsSidebar />
      </RetainedSurface>
    ),
  });
}
