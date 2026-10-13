'use client';

import type { ReactNode } from 'react';
import { renderToolPane, type ToolPaneProps } from '../../frame/tool-pane/tool-pane.render';

/** The Activity tool's pane (C-Drive-Activity). */
export function ActivityPane({ close }: ToolPaneProps): ReactNode {
  return renderToolPane({ title: 'Activity', close });
}
