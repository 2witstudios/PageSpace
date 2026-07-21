"use client";

/**
 * PaneBar — the universal pane title bar (pane-chrome redesign, variant B).
 *
 * Every pane in the machine workspace grid — PTY, empty picker, chat — wears
 * one slim bar: identity on the left, actions on the right. It replaces BOTH
 * pieces of floating chrome the grid used to carry:
 *
 * - the hover-revealed split/close chip (`absolute top-right`), which on chat
 *   panes physically covered the chat header's own tabs; and
 * - the 2px top accent line — the bar's tint IS the focus state now.
 *
 * Actions dim instead of hiding (opacity, never display/visibility), so they
 * stay clickable on every pointer type without the `[data-pointer='coarse']`
 * escape hatch the opacity-0 chip needed.
 *
 * Pure presentational by design: no store, no hooks, no network — the caller
 * decides what identity and actions mean. `TerminalPane` renders it for PTY
 * and picker panes; `MachinePaneChat` renders it for chat panes with the
 * pane-level controls merged in after its own (one bar per pane, always).
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
  /** Left side: who this pane is (session name + scope, or the agent picker). */
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

/** Swallows the bubble so a control click never re-selects the pane first —
 * the same guard the floating chip's buttons carried. */
function guarded(handler: () => void) {
  return (event: MouseEvent) => {
    event.stopPropagation();
    handler();
  };
}

/**
 * The pane-level control handlers every surface shares. Passed as DATA (not a
 * pre-rendered node) so a surface can render them however its bar needs —
 * inline buttons at full width, or folded into an overflow menu when the pane
 * is narrow.
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
 * A bound pane's identity: running dot + mono session name + checkout chip.
 * The dot means "a live session is bound here" — this surface only lists
 * sessions that exist server-side, so bound is the running state it has.
 */
export function PaneSessionIdentity({ name, scopeLabel }: { name: string; scopeLabel?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
      <span className="truncate font-mono text-[11px]">{name}</span>
      {scopeLabel !== undefined && (
        <span className="shrink-0 rounded border border-border px-1 py-px text-[10px] font-normal text-muted-foreground">
          {scopeLabel}
        </span>
      )}
    </span>
  );
}
