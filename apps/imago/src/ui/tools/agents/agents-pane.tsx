'use client';

import type { ReactNode } from 'react';
import { renderToolPane, type ToolPaneProps } from '../../frame/tool-pane/tool-pane.render';

/** The Agents tool's pane (C-Drive-Agents). */
export function AgentsPane({ close }: ToolPaneProps): ReactNode {
  return renderToolPane({ title: 'Agents', close });
}
