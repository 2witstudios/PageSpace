'use client';

/**
 * ConversationHeader — THE header for a hosted chat surface, in either
 * situation: full-width (dashboard assistant) or inside a resizable pane.
 *
 * One slot contract with {@link PaneBar} — identity on the left, actions on
 * the right, optional pane controls — at two densities:
 *
 *  - `compact`   IS PaneBar: the 30px pane bar, hover-dimmed actions. Panes
 *                (and the agent page's session-less chat) wear it today.
 *  - `comfortable` the dashboard-scale face of the same contract: a slim
 *                h-11 bar whose actions stay visible, roomy enough for the
 *                assistant's labeled controls (agent picker, New, History…).
 *
 * The point of one component is the migration it makes boring: when the
 * dashboard itself becomes a splittable pane grid, its assistant pane swaps
 * `comfortable` for `compact` and passes `paneControls` — same identity, same
 * actions, zero new chrome. Until then, the dashboard header can never drift
 * into a differently-shaped copy of what panes wear.
 *
 * `paneControls` is DATA (see {@link PaneControlProps}), not a rendered node —
 * each density lays the split/close controls out for its own height.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import PaneBar, { PaneSplitCloseActions, type PaneControlProps } from './PaneBar';

export interface ConversationHeaderProps {
  /** `compact` delegates to PaneBar; `comfortable` is the dashboard-scale bar. Defaults to `comfortable`. */
  density?: 'comfortable' | 'compact';
  /** Only meaningful at `compact` — the bar tint is the pane's focus indicator. */
  isActive?: boolean;
  /** Left side: who this surface is (agent picker, avatar + name + scope crumb). */
  identity: ReactNode;
  /** Right side: the surface's own controls (New, History, Plan chip, …). */
  actions?: ReactNode;
  /** Split right/down + close — pass when this surface is hosted as a pane. */
  paneControls?: PaneControlProps;
  className?: string;
}

export function ConversationHeader({
  density = 'comfortable',
  isActive = false,
  identity,
  actions,
  paneControls,
  className,
}: ConversationHeaderProps) {
  if (density === 'compact') {
    return (
      <PaneBar
        isActive={isActive}
        identity={identity}
        className={className}
        actions={
          <>
            {actions}
            {paneControls && <PaneSplitCloseActions {...paneControls} />}
          </>
        }
      />
    );
  }

  return (
    <div
      data-testid="conversation-header"
      className={cn(
        'flex h-11 min-w-0 shrink-0 items-center gap-2 border-b border-border/60 px-3',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{identity}</div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {paneControls && (
          <div className="ml-1 flex items-center gap-0.5 border-l border-border/60 pl-1.5">
            <PaneSplitCloseActions {...paneControls} />
          </div>
        )}
      </div>
    </div>
  );
}
