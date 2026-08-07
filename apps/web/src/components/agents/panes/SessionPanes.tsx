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

import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { usePanelRef } from 'react-resizable-panels';
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
            <SizedPanel fraction={column.widthFraction} evenShare={100 / columns.length}>
              <ResizablePanelGroup orientation="vertical" className="h-full">
                {column.panes.map((pane, paneIndex) => (
                  <Fragment key={pane.id}>
                    {paneIndex > 0 && <ResizableHandle variant="chrome-free" />}
                    <SizedPanel fraction={pane.heightFraction} evenShare={100 / column.panes.length}>
                      {renderPane({ pane, isActive: pane.id === activeId, canSplit: true })}
                    </SizedPanel>
                  </Fragment>
                ))}
              </ResizablePanelGroup>
            </SizedPanel>
          </Fragment>
        ))}
      </ResizablePanelGroup>
    </div>
  );
}

/**
 * A panel laid out at its PERSISTED share when the grid has one (issue #2208),
 * and at the even split when it does not.
 *
 * Two mechanisms, because react-resizable-panels v4 has no controlled `size`
 * prop — `defaultSize` is read once at mount and never again:
 *
 *  - `defaultSize` seats the share on the first render, so a grid opened on
 *    another device (or an hour later) comes back laid out the way it was
 *    left, straight from the pane rows.
 *  - the imperative `resize()` applies a share that CHANGES while the grid is
 *    already mounted — an agent's `resize_pane`, or another device's, arriving
 *    over `workspace:updated`. Re-keying the group would achieve the same
 *    thing by remounting, which is exactly what must not happen here: a
 *    remounted terminal pane drops its PTY viewer and cold-starts a new shell.
 *
 * Deliberately ONE-WAY: dragging a separator is still local to the panel
 * group and posts no verb. Writing drags back needs a debounce plus a story
 * for the two panels one drag resizes (two verbs whose renormalizations do
 * not compose to what the user sees), and getting that wrong shows up as
 * visible jitter — so it is left out rather than half-built. Nothing
 * regresses: a drag behaves exactly as it did before this change.
 */
function SizedPanel({
  fraction,
  evenShare,
  children,
}: {
  fraction: number | null | undefined;
  evenShare: number;
  children: ReactNode;
}) {
  const panelRef = usePanelRef();
  const sized = typeof fraction === 'number';
  const percentage = sized ? fraction * 100 : evenShare;
  // What we last pushed imperatively. Seeded with the mount value so the
  // first effect run is a no-op — `defaultSize` already did that job, and
  // re-applying it would fight the group's own initial layout pass.
  const applied = useRef(percentage);

  useEffect(() => {
    // ONLY an explicitly persisted share is ever pushed. On an unsized grid
    // the even split is the panel group's OWN default, and re-asserting it
    // imperatively is both redundant and harmful: `evenShare` changes on every
    // split and close, so the effect would fire mid-reconciliation against a
    // group whose panel set React has not finished updating — which is exactly
    // the "Panel constraints not found for index -1" throw.
    if (!sized || applied.current === percentage) return;
    try {
      panelRef.current?.resize(`${percentage}%`);
      applied.current = percentage;
    } catch {
      // Best-effort visual sync. A share that could not be applied right now
      // (a panel being removed in the same commit) is not worth failing a
      // render over — `applied` deliberately stays behind so a later commit
      // retries, and a remount reads the same share from `defaultSize` anyway.
    }
  }, [sized, percentage, panelRef]);

  return (
    <ResizablePanel panelRef={panelRef} defaultSize={`${percentage}%`} minSize={15}>
      {children}
    </ResizablePanel>
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
