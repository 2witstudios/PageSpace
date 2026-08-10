'use client';

/**
 * The pane grid — one rendering of the workspace's node tree.
 *
 * **It is recursive now, and that REMOVED a special case rather than adding
 * one.** The two-level version already nested a vertical `ResizablePanelGroup`
 * inside a horizontal one; what it could not do was nest a third time, so
 * "column of panes" and "row of columns" were two hard-coded levels with their
 * own loops, their own sizing call and their own key scheme. A container renders
 * its children the same way at every depth, so there is one loop, and the depth
 * cap is `validateTree`'s rather than this file's.
 *
 * Surfaces are INJECTED (`renderPane`) rather than resolved here. The grid then
 * knows nothing about chat or terminals — which is what lets the same grid serve
 * the console and the agent page, and lets these tests run without mounting an
 * xterm.
 *
 * **An empty grid renders as empty.** A root holding nothing is a legal resting
 * state (closing the last pane parks it and leaves the workspace alive), so this
 * draws the empty frame and says so, instead of treating zero panes as a
 * workspace that has ended.
 */

import { Fragment, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useMobile } from '@/hooks/useMobile';
import {
  childrenOf,
  rootOf,
  type NodeAxis,
  type PaneNode,
  type SplitNode,
  type WorkspaceNode,
} from '@pagespace/lib/agent-workspaces/workspace-node';
import { gridPanesOf } from '@/stores/agent-workspace/workspace-tree-view';

export interface SessionPanesProps {
  /** The workspace's whole flat list — attached and detached. Only the grid is drawn here. */
  nodes: readonly WorkspaceNode[];
  /** `null` on an empty grid. */
  activeNodeId: string | null;
  /** Focus a pane. Needed here because the narrow-viewport strip is the grid's own. */
  onSelectPane(nodeId: string): void;
  /**
   * Renders one pane's body and bar.
   *
   * Split/close handlers are deliberately NOT props: the caller already closes
   * over them to build the pane's bar, so taking them here would be a second
   * copy of the same wiring this component never calls. `canSplit` is false on
   * narrow viewports, where a split grid is unusable — that is a layout fact, so
   * it does come from here.
   */
  renderPane(args: { node: PaneNode; isActive: boolean; canSplit: boolean }): ReactNode;
  /** A short label for a pane in the narrow-viewport strip. */
  paneLabel(node: PaneNode): string;
}

export default function SessionPanes({
  nodes,
  activeNodeId,
  onSelectPane,
  renderPane,
  paneLabel,
}: SessionPanesProps) {
  const isMobile = useMobile();
  const root = useMemo(() => rootOf(nodes), [nodes]);
  const panes = useMemo(() => gridPanesOf(nodes), [nodes]);

  // A phone cannot hold a split grid: two columns at 375px give each pane
  // ~180px, narrower than an `ls -l` line and unusable for the agent output this
  // surface exists to show. So on narrow viewports only the ACTIVE pane is
  // VISIBLE, full-bleed, and the split controls are hidden — the stored tree is
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
    if (panes.length === 0) return <EmptyGrid />;
    // The store always points `activeNodeId` at a live pane; fall back anyway
    // rather than render a grid where nothing is visible.
    const activeId = panes.find((pane) => pane.id === activeNodeId)?.id ?? panes[0].id;
    return (
      <div className="flex h-full flex-col bg-background">
        {panes.length > 1 && (
          <PaneStrip panes={panes} activeNodeId={activeId} onSelect={onSelectPane} paneLabel={paneLabel} />
        )}
        <div className="relative min-h-0 flex-1">
          {panes.map((pane) => (
            <div
              key={pane.id}
              className={cn('absolute inset-0', pane.id !== activeId && 'invisible')}
              data-testid="mobile-pane"
              data-hidden={pane.id !== activeId ? 'true' : undefined}
            >
              {renderPane({ node: pane, isActive: pane.id === activeId, canSplit: false })}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // No root at all: the workspace has never been written. Same frame as an empty
  // grid — there is nothing to draw either way, and distinguishing them here
  // would be this component inventing a lifecycle opinion it does not hold.
  if (root === undefined || panes.length === 0) return <EmptyGrid />;

  // The same fallback the mobile branch has. Every pane still renders its own
  // content here (unlike mobile, where only the active one is visible) — this
  // only decides which one gets the "active" styling, so falling back to the
  // first pane rather than leaving NONE active is strictly better.
  const activeId = panes.find((pane) => pane.id === activeNodeId)?.id ?? panes[0].id;

  return (
    <div className="h-full bg-background" data-testid="session-panes">
      <ContainerGroup
        nodes={nodes}
        parentId={root.id}
        axis={root.axis}
        activeNodeId={activeId}
        renderPane={renderPane}
      />
    </div>
  );
}

/**
 * ONE CONTAINER'S CHILDREN — the recursion.
 *
 * A child that is a pane renders its surface; a child that is a split renders
 * its own group at its own axis. That is the whole difference between depth 1
 * and depth 5, and it is why the two-level version's separate column and pane
 * loops collapse into this.
 */
function ContainerGroup({
  nodes,
  parentId,
  axis,
  activeNodeId,
  renderPane,
}: {
  nodes: readonly WorkspaceNode[];
  parentId: string;
  axis: NodeAxis;
  activeNodeId: string;
  renderPane: SessionPanesProps['renderPane'];
}) {
  // The root is a child of nothing — its parent is null by its own type — so
  // this filter removes a case that cannot arise. It is a filter rather than a
  // cast deliberately: `childrenOf` answers over an untrusted flat list, and a
  // second root arriving in one would be dropped from the render instead of
  // being asserted away and then read for a `fraction` it does not have.
  const children = childrenOf(nodes, parentId).filter(
    (child): child is PaneNode | SplitNode => child.nodeType !== 'root',
  );
  if (children.length === 0) return null;

  return (
    <ResizablePanelGroup orientation={axis === 'row' ? 'horizontal' : 'vertical'} className="h-full">
      {children.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 && <ResizableHandle variant="chrome-free" />}
          <SizedPanel fraction={child.fraction} evenShare={100 / children.length}>
            {child.nodeType === 'pane' ? (
              renderPane({ node: child, isActive: child.id === activeNodeId, canSplit: true })
            ) : (
              <ContainerGroup
                nodes={nodes}
                parentId={child.id}
                axis={child.axis}
                activeNodeId={activeNodeId}
                renderPane={renderPane}
              />
            )}
          </SizedPanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}

/**
 * The empty grid — a resting state, not a failure.
 *
 * Closing the last pane parks it and leaves the workspace alive. Under the model
 * this replaces, that state could not be represented (a two-level grid had no
 * spelling for zero columns), so the reducer no-oped on the last close and
 * browser code ended the session instead. The workspace's members are all still
 * there, in the sidebar, one click from being shown again — which is what this
 * says.
 */
function EmptyGrid() {
  return (
    <div className="flex h-full items-center justify-center bg-background" data-testid="empty-grid">
      <p className="max-w-xs text-center text-sm text-muted-foreground">
        Nothing is open here. Pick a conversation, shell or page from this workspace in the sidebar.
      </p>
    </div>
  );
}

/**
 * A panel laid out at its PERSISTED share when the tree has one, and at the even
 * split when it does not.
 *
 * Two mechanisms, because react-resizable-panels v4 has no controlled `size`
 * prop — `defaultSize` is read once at mount and never again:
 *
 *  - `defaultSize` seats the share on the first render, so a tree opened on
 *    another device (or an hour later) comes back laid out the way it was left,
 *    straight from the node rows.
 *  - the imperative `resize()` applies a share that CHANGES while the grid is
 *    already mounted — an agent's resize, or another device's, arriving over
 *    `workspace:nodes-updated`. Re-keying the group would achieve the same thing
 *    by remounting, which is exactly what must not happen here: a remounted
 *    terminal pane drops its PTY viewer and cold-starts a new shell.
 *
 * Deliberately ONE-WAY: dragging a separator is still local to the panel group
 * and posts nothing. Writing drags back needs a debounce plus a story for the
 * two panels one drag resizes, and getting that wrong shows up as visible
 * jitter — so it is left out rather than half-built.
 */
function SizedPanel({
  fraction,
  evenShare,
  children,
}: {
  fraction: number | undefined;
  evenShare: number;
  children: ReactNode;
}) {
  const panelRef = usePanelRef();
  const sized = typeof fraction === 'number';
  const percentage = sized ? fraction * 100 : evenShare;
  // What we last pushed imperatively. Seeded with the mount value so the first
  // effect run is a no-op — `defaultSize` already did that job, and re-applying
  // it would fight the group's own initial layout pass.
  const applied = useRef(percentage);

  useEffect(() => {
    // ONLY an explicitly persisted share is ever pushed. On an unsized group the
    // even split is the panel group's OWN default, and re-asserting it
    // imperatively is both redundant and harmful: `evenShare` changes on every
    // split and close, so the effect would fire mid-reconciliation against a
    // group whose panel set React has not finished updating — which is exactly
    // the "Panel constraints not found for index -1" throw.
    if (!sized || applied.current === percentage) return;
    try {
      panelRef.current?.resize(`${percentage}%`);
      applied.current = percentage;
    } catch {
      // Best-effort visual sync. A share that could not be applied right now (a
      // panel being removed in the same commit) is not worth failing a render
      // over — `applied` deliberately stays behind so a later commit retries,
      // and a remount reads the same share from `defaultSize` anyway.
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
  activeNodeId,
  onSelect,
  paneLabel,
}: {
  panes: PaneNode[];
  activeNodeId: string;
  onSelect(nodeId: string): void;
  paneLabel(node: PaneNode): string;
}) {
  return (
    <div
      data-testid="pane-strip"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1"
    >
      {panes.map((pane) => (
        <Button
          key={pane.id}
          size="sm"
          variant={pane.id === activeNodeId ? 'secondary' : 'ghost'}
          className="h-6 shrink-0 px-2 text-xs"
          onClick={() => onSelect(pane.id)}
          aria-current={pane.id === activeNodeId ? 'true' : undefined}
        >
          {paneLabel(pane)}
        </Button>
      ))}
    </div>
  );
}
