'use client';

import type { ReactNode } from 'react';
import { renderToolPane, type ToolPaneProps } from '../../frame/tool-pane/tool-pane.render';

/** The Members tool's pane (C-Members). */
export function MembersPane({ close }: ToolPaneProps): ReactNode {
  return renderToolPane({ title: 'Members', close });
}
