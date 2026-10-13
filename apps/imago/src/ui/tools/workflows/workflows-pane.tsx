'use client';

import type { ReactNode } from 'react';
import { renderToolPane, type ToolPaneProps } from '../../frame/tool-pane/tool-pane.render';

/** The Workflows tool's pane (C-Drive-Workflows). */
export function WorkflowsPane({ close }: ToolPaneProps): ReactNode {
  return renderToolPane({ title: 'Workflows', close });
}
