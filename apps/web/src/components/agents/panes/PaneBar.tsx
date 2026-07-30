'use client';

/**
 * PaneBar — the universal pane title bar, ported from the machine workspace
 * grid (deleted in the phase-8 teardown) unchanged apart from its one piece of
 * git topology.
 *
 * Every pane wears one slim bar: identity on the left, actions on the right.
 * It replaced BOTH pieces of floating chrome the grid used to carry — the
 * hover-revealed split/close chip, which on chat panes physically covered the
 * chat header's own controls, and the 2px top accent line, since the bar's
 * tint IS the focus state.
 *
 * Actions dim rather than hide (opacity, never display/visibility), so they
 * stay clickable on every pointer type without the coarse-pointer escape hatch
 * an opacity-0 chip needs.
 *
 * Pure presentational by design: no store, no hooks, no network — the caller
 * decides what identity and actions mean, so a terminal pane and a chat pane
 * wear the same bar without either knowing about the other.
 *
 * The only thing dropped in the port is the checkout chip (`scopeLabel`), which
 * named a project/branch. That slot is now the agent label, so a grid holding
 * conversations with several different agents says which is which.
 */

import type { MouseEvent, ReactNode } from 'react';
import { SquareSplitHorizontal, SquareSplitVertical, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export default function PaneBar({
  isActive,
  identity,
  actions,
}: {
  /** The bar tint is the pane's focus indicator — no separate accent line. */
  isActive: boolean;
  /** Left side: who this pane is (bound session, or the picker). */
  identity: ReactNode;
  /** Right side: the pane's controls, dimmed until hover/focus. */
  actions?: ReactNode;
}) {
  return (
    <div
      data-testid="pane-bar"
      data-active={isActive ? 'true' : undefined}
      className={cn(
        'flex h-[30px] min-w-0 shrink-0 items-center gap-1 border-b border-border/60 pl-2 pr-1 transition-colors',
        isActive && 'border-primary/40 bg-primary/10',
      )}
    >
      <div
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium',
          isActive ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {identity}
      </div>
      {actions !== undefined && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity focus-within:opacity-100 group-hover/pane:opacity-100 touch:opacity-100">
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * Swallows the bubble so a control click never re-selects the pane first — the
 * same guard the floating chip's buttons carried.
 */
function guarded(handler: () => void) {
  return (event: MouseEvent) => {
    event.stopPropagation();
    handler();
  };
}

/**
 * The pane-level control handlers every surface shares. Passed as DATA rather
 * than a pre-rendered node so a surface can render them however its bar needs —
 * inline at full width, or folded into an overflow menu when the pane is narrow.
 */
export interface PaneControlProps {
  /** False on narrow viewports — two columns at phone width are unusable slivers. */
  canSplit: boolean;
  /** Close is universal — a view you cannot destroy is not a view. */
  canClose: boolean;
  onSplitRight(): void;
  onSplitDown(): void;
  onClose(): void;
}

/** The shared inline rendering of {@link PaneControlProps}: split right/down + close. */
export function PaneSplitCloseActions({
  canSplit,
  canClose,
  onSplitRight,
  onSplitDown,
  onClose,
}: PaneControlProps) {
  return (
    <>
      {canSplit && (
        <>
          <Button
            variant="ghost"
            size="icon"
            onClick={guarded(onSplitRight)}
            className="size-6 text-muted-foreground hover:text-foreground"
            title="Split right"
          >
            <SquareSplitHorizontal className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={guarded(onSplitDown)}
            className="size-6 text-muted-foreground hover:text-foreground"
            title="Split down"
          >
            <SquareSplitVertical className="size-3.5" />
          </Button>
        </>
      )}
      {canClose && (
        <Button
          variant="ghost"
          size="icon"
          onClick={guarded(onClose)}
          className="size-6 text-muted-foreground hover:text-destructive"
          title="Close pane"
        >
          <X className="size-3.5" />
        </Button>
      )}
    </>
  );
}

/**
 * A bound pane's identity: a live dot, the session name, and an optional label.
 *
 * The dot means "a live session is bound here" — this surface only shows
 * sessions that exist server-side, so bound IS the running state it has. The
 * label carries the agent name for a chat pane, which is what keeps a grid of
 * conversations with different agents readable.
 */
export function PaneSessionIdentity({ name, label }: { name: string; label?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
      <span className="truncate font-mono text-[11px]">{name}</span>
      {label !== undefined && (
        <span className="shrink-0 rounded border border-border px-1 py-px text-[10px] font-normal text-muted-foreground">
          {label}
        </span>
      )}
    </span>
  );
}
