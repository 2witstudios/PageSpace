'use client';

import type { ReactNode } from 'react';
import { renderToolPane, type ToolPaneProps } from '../../frame/tool-pane/tool-pane.render';

/** The Calendar tool's pane (C-Drive-Calendar). */
export function CalendarPane({ close }: ToolPaneProps): ReactNode {
  return renderToolPane({ title: 'Calendar', close });
}
