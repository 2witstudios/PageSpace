'use client';

/**
 * The pane grid — ported from the machine workspace's `TerminalPanes`
 * (623e632e7^) with its layout and its two hard-won viewport rules intact.
 *
 * Layout is two levels, never a recursive tree: a horizontal group of columns,
 * each a vertical group of panes. `splitRight` adds a column, `splitDown` adds
 * to one.
 *
 * Surfaces are INJECTED (`renderPane`) rather than resolved here. The grid then
 * knows nothing about chat or terminals — which is what lets the same grid serve
 * the console and the agent page, and lets these tests run without mounting an
 * xterm.
 */

import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useMobile } from '@/hooks/useMobile';
import { panesOf, type PaneState, type WorkspaceState } from '@/stores/agent-workspace/pane-reducer';

export interface SessionPanesProps {
  workspace: WorkspaceState;
  /** Focus a pane. Needed here because the narrow-viewport strip is the grid's own. */
  onSelectPane(paneId: string): void;
  /**
   * Renders one pane's body and bar.
   *
   * Split/close handlers are deliberately NOT props of this component: the
   * caller already closes over them to build the pane's bar, so taking them
   * here would be a second copy of the same wiring that this component never
   * calls. `canSplit` is false on narrow viewports, where a split grid is
   * unusable — it is a layout fact, so it does come from here.
   */
  renderPane(args: { pane: PaneState; isActive: boolean; canSplit: boolean }): ReactNode;
}

export default function SessionPanes({ workspace, onSelectPane, renderPane }: SessionPanesProps) {
  const isMobile = useMobile();
  const { columns, activePaneId } = workspace;
  const panes = panesOf(workspace);

  // A phone cannot hold a split grid: two columns at 375px give each pane
  // ~180px, narrower than an `ls -l` line and unusable for the agent output this
  // surface exists to show. So on narrow viewports only the ACTIVE pane is
  // VISIBLE, full-bleed, and the split controls are hidden — the stored layout is
  // untouched, so a desktop split is still there and comes back laid out on the
  // next wide render.
  //
  // The inactive panes are HIDDEN, not unmounted. Unmounting a terminal emits a
  // disconnect, which removes this pane's viewer entry — and when it was the last
  // viewer, arms the idle reap — so an agent that finished while its pane was
  // off-screen would lose its final output and exit code, and returning to that
  // pane would cold-start a fresh PTY instead of showing the completed run.
  //
  // `invisible` (visibility:hidden), NOT `hidden` (display:none). Every pane here
  // is stacked at inset-0, so a hidden one still has the container's real size —
  // which it must, because a pane can MOUNT while inactive. xterm measures its
  // character cell from the DOM at `open()`, and in a display:none box that
  // measurement is 0; the fit addon then proposes no dimensions, so even the
  // refit on re-show is a no-op and the pane stays blank for good.
  // visibility:hidden also keeps `offsetParent` and `clientWidth` truthy, which
  // is exactly what the terminal's own visibility gate checks before it fits.
  if (isMobile) {
    if (panes.length === 0) return null;
    // The store always points activePaneId at a live pane; fall back anyway
    // rather than render a grid where nothing is visible.
    const activeId = panes.some((pane) => pane.id === activePaneId) ? activePaneId : panes[0].id;
    return (
      <div className="flex h-full flex-col bg-background">
        {panes.length > 1 && <PaneStrip panes={panes} activePaneId={activeId} onSelect={onSelectPane} />}
        <div className="relative min-h-0 flex-1">
          {panes.map((pane) => (
            <div
              key={pane.id}
              className={cn('absolute inset-0', pane.id !== activeId && 'invisible')}
              data-testid="mobile-pane"
              data-hidden={pane.id !== activeId ? 'true' : undefined}
            >
              {renderPane({ pane, isActive: pane.id === activeId, canSplit: false })}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Same fallback the mobile branch above already has — `activePaneId` should
  // always name a live pane, but a saved grid restored from the server isn't
  // guaranteed to (the persisted-workspace schema doesn't cross-validate that
  // reference). Every pane still renders its own content either way here
  // (unlike mobile, where only the active one is visible) — this only
  // decides which one gets the "active" styling/focus, so falling back to
  // the first pane rather than leaving NONE active is strictly better.
  const activeId = panes.some((pane) => pane.id === activePaneId) ? activePaneId : panes[0]?.id;

  return (
    <div className="h-full bg-background" data-testid="session-panes">
      <ResizablePanelGroup orientation="horizontal" className="h-full">
        {columns.map((column, columnIndex) => (
          <Fragment key={column.id}>
            {columnIndex > 0 && <ResizableHandle variant="chrome-free" />}
            <ResizablePanel defaultSize={100 / columns.length} minSize={15}>
              <ResizablePanelGroup orientation="vertical" className="h-full">
                {column.panes.map((pane, paneIndex) => (
                  <Fragment key={pane.id}>
                    {paneIndex > 0 && <ResizableHandle variant="chrome-free" />}
                    <ResizablePanel defaultSize={100 / column.panes.length} minSize={15}>
                      {renderPane({ pane, isActive: pane.id === activeId, canSplit: true })}
                    </ResizablePanel>
                  </Fragment>
                ))}
              </ResizablePanelGroup>
            </ResizablePanel>
          </Fragment>
        ))}
      </ResizablePanelGroup>
    </div>
  );
}

/**
 * The narrow-viewport pane switcher. Only rendered when a split layout already
 * exists — it can only have been made on a wider screen — and it is the ONLY way
 * back to those panes once the grid collapses to one. Without it they are
 * silently unreachable, which is the failure mode the whole mobile branch exists
 * to avoid.
 */
function PaneStrip({
  panes,
  activePaneId,
  onSelect,
}: {
  panes: PaneState[];
  activePaneId: string;
  onSelect(paneId: string): void;
}) {
  return (
    <div
      data-testid="pane-strip"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1"
    >
      {panes.map((pane, index) => (
        <Button
          key={pane.id}
          size="sm"
          variant={pane.id === activePaneId ? 'secondary' : 'ghost'}
          className="h-6 shrink-0 px-2 text-xs"
          onClick={() => onSelect(pane.id)}
          aria-current={pane.id === activePaneId ? 'true' : undefined}
        >
          {pane.scope?.name ?? `Pane ${index + 1}`}
        </Button>
      ))}
    </div>
  );
}
