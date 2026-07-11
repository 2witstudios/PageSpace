"use client";

import { Fragment, useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { Socket } from 'socket.io-client';
import { SquareSplitHorizontal, SquareSplitVertical, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useMobile } from '@/hooks/useMobile';
import { useTerminalWorkspaceStore, selectWorkspace, type OpenTerminalScope, type TerminalPaneState } from '@/stores/terminal-workspace/useTerminalWorkspaceStore';
import { PaneLoading, PaneNotice } from '../tabs/tab-states';

const XtermTerminal = dynamic(() => import('../XtermTerminal'), { ssr: false });

export type { TerminalPaneState };

interface TerminalPanesProps {
  machineId: string;
  socket: Socket | null | undefined;
}

function paneSessionId(machineId: string, scope: OpenTerminalScope): string {
  return `agent-terminal:${machineId}:${scope.projectName ?? ''}:${scope.branchName ?? ''}:${scope.name}`;
}

export default function TerminalPanes({ machineId, socket }: TerminalPanesProps) {
  const workspace = useTerminalWorkspaceStore(selectWorkspace(machineId));
  const splitRight = useTerminalWorkspaceStore((state) => state.splitRight);
  const splitDown = useTerminalWorkspaceStore((state) => state.splitDown);
  const closePane = useTerminalWorkspaceStore((state) => state.closePane);
  const selectPane = useTerminalWorkspaceStore((state) => state.selectPane);
  const isMobile = useMobile();

  // Briefly undefined between this component's first render and the
  // mounting TerminalWorkspace's ensureWorkspace effect committing.
  if (!workspace) return null;

  const { columns, activePaneId } = workspace;
  const panes = columns.flatMap((column) => column.panes);
  const canClose = panes.length > 1;

  /** `activeId` is a parameter rather than read from the closure so the narrow
   * branch's fallback (below) drives the focus accent and the pane strip from the
   * SAME id — otherwise a stale activePaneId would show the visible pane as
   * unfocused while the strip highlighted it. */
  const paneProps = (pane: TerminalPaneState, activeId: string | null) => ({
    socket,
    machineId,
    pane,
    isActive: pane.id === activeId,
    canClose,
    onSelect: () => selectPane(machineId, pane.id),
    onSplitRight: () => splitRight(machineId, pane.id),
    onSplitDown: () => splitDown(machineId, pane.id),
    onClose: () => closePane(machineId, pane.id),
  });

  // A phone cannot hold a split grid: two columns at 375px give each terminal
  // ~180px, which is narrower than an `ls -l` line and unusable for the agent
  // output this surface exists to show. So on narrow viewports only the ACTIVE
  // pane is VISIBLE, full-bleed, and the split controls are hidden — the store's
  // layout is untouched, so a desktop split is still there and comes back laid
  // out on the next wide render.
  //
  // The inactive panes are HIDDEN, not unmounted. Unmounting an XtermTerminal
  // emits `agent-terminal:disconnect`, which nulls the session's `closedFn` and
  // arms the idle reap — so an agent that finished while its pane was off-screen
  // would lose its final output and exit code, and coming back to that pane would
  // cold-start a fresh PTY instead of showing the completed run.
  //
  // `invisible` (visibility:hidden), NOT `hidden` (display:none). Every pane here
  // is stacked at inset-0, so a hidden one still has the container's real size —
  // which it must, because a pane can MOUNT while inactive. xterm measures its
  // character cell from the DOM at `open()`, and in a display:none box that
  // measurement is 0; FitAddon then proposes no dimensions, so even the refit on
  // re-show is a no-op and the pane stays blank for good. (The keep-alive path can
  // use display:none safely only because it hides terminals that were already
  // opened at a real size.) visibility:hidden also keeps `offsetParent` and
  // `clientWidth` truthy, which is exactly what XtermTerminal's own visibility
  // gate checks before it fits.
  if (isMobile) {
    if (panes.length === 0) return null;
    // The store always points activePaneId at a live pane; fall back anyway rather
    // than render a workspace where nothing is visible.
    const activeId = panes.some((pane) => pane.id === activePaneId) ? activePaneId : panes[0].id;
    return (
      <div className="flex h-full flex-col bg-background">
        {panes.length > 1 && (
          <PaneStrip panes={panes} activePaneId={activeId} onSelect={(id) => selectPane(machineId, id)} />
        )}
        <div className="relative min-h-0 flex-1">
          {panes.map((pane) => (
            <div
              key={pane.id}
              className={cn('absolute inset-0', pane.id !== activeId && 'invisible')}
              data-testid="mobile-pane"
              data-hidden={pane.id !== activeId ? 'true' : undefined}
            >
              <TerminalPane {...paneProps(pane, activeId)} canSplit={false} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full bg-background">
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
                      <TerminalPane {...paneProps(pane, activePaneId)} canSplit />
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
 * exists (it can only have been made on a wider screen), and it is the ONLY way
 * back to those panes once the grid collapses to one — without it they would be
 * silently unreachable, which is the failure mode this whole branch is meant to
 * avoid.
 */
function PaneStrip({
  panes,
  activePaneId,
  onSelect,
}: {
  panes: TerminalPaneState[];
  activePaneId: string | null;
  onSelect(paneId: string): void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1">
      {panes.map((pane, index) => (
        <Button
          key={pane.id}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onSelect(pane.id)}
          aria-current={pane.id === activePaneId ? 'true' : undefined}
          className={cn(
            'h-6 shrink-0 px-2 text-xs text-muted-foreground',
            pane.id === activePaneId && 'bg-accent text-foreground',
          )}
        >
          {pane.scope?.name ?? `Pane ${index + 1}`}
        </Button>
      ))}
    </div>
  );
}

/**
 * Chrome-free by design (no per-pane header, ever, verified against
 * PurePoint's real chrome-free pane design) — a top accent bar shows focus
 * and hover-revealed controls handle splitting/closing without permanent
 * chrome. Known tradeoff: with 2+ panes open the Machine tree sidebar does not
 * yet indicate which open terminal is showing in which pane — that's tree
 * sidebar work, out of scope for this theming-foundation round.
 */
function TerminalPane({
  socket,
  machineId,
  pane,
  isActive,
  canClose,
  canSplit,
  onSelect,
  onSplitRight,
  onSplitDown,
  onClose,
}: {
  socket: Socket | null | undefined;
  machineId: string;
  pane: TerminalPaneState;
  isActive: boolean;
  canClose: boolean;
  /** False on narrow viewports, where a split would produce two unusable slivers. */
  canSplit: boolean;
  onSelect(): void;
  onSplitRight(): void;
  onSplitDown(): void;
  onClose(): void;
}) {
  const sessionId = pane.scope ? paneSessionId(machineId, pane.scope) : null;
  // With neither a split nor a close to offer (a lone pane on a phone), the
  // control chip has nothing in it — and since it is opacity-100 on touch, an
  // empty bordered box would just sit in the corner forever.
  const hasControls = canSplit || canClose;

  return (
    <div className="group/pane relative flex h-full flex-col" onClick={onSelect}>
      <div className={`absolute inset-x-0 top-0 z-10 h-0.5 ${isActive ? 'bg-primary' : 'bg-transparent'}`} />
      {/* Hover-revealed on a mouse; a touch device has no hover, so the controls
          stay visible there rather than being unreachable. */}
      {hasControls && (
      <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-md border border-border bg-card/90 p-0.5 opacity-100 shadow-sm backdrop-blur-sm transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover/pane:opacity-100">
        {canSplit && (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                onSplitRight();
              }}
              className="size-6 text-muted-foreground hover:text-foreground"
              title="Split right"
            >
              <SquareSplitHorizontal className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                onSplitDown();
              }}
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
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="size-6 text-muted-foreground hover:text-destructive"
            title="Close pane"
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>
      )}
      <div className="relative min-h-0 flex-1">
        {!pane.scope || !sessionId ? (
          <PaneNotice
            title="No terminal open"
            description="Pick a session from the Sessions sidebar, or add one from any node in the tree."
          />
        ) : (
          <TerminalPaneStream key={sessionId} socket={socket} machineId={machineId} scope={pane.scope} sessionId={sessionId} />
        )}
      </div>
    </div>
  );
}

/**
 * Keyed by `sessionId` at the call site above — switching which terminal a
 * pane shows fully unmounts/remounts this component, so `connected`/`error`
 * reset to their initial values automatically instead of needing a manual
 * effect (which would otherwise briefly show the PREVIOUS terminal's
 * connected state for one render before an effect could catch up).
 */
function TerminalPaneStream({
  socket,
  machineId,
  scope,
  sessionId,
}: {
  socket: Socket | null | undefined;
  machineId: string;
  scope: OpenTerminalScope;
  sessionId: string;
}) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slow = useElapsed(!connected && error === null, COLD_BOOT_MS);

  const handleReady = useCallback(() => setConnected(true), []);
  const handleError = useCallback((message: string) => setError(message), []);

  return (
    <>
      {socket && (
        <XtermTerminal
          socket={socket}
          sessionId={sessionId}
          connectPayload={{ machineId, projectName: scope.projectName, branchName: scope.branchName, name: scope.name }}
          onReady={handleReady}
          onError={handleError}
        />
      )}
      {!connected && (
        <div className="absolute inset-0 bg-background">
          {error ? (
            <PaneNotice tone="destructive" title={error} />
          ) : (
            // Reattaching to a live PTY answers in well under a second; a COLD
            // Sprite has to boot first, and a bare "Connecting…" that sits there
            // for ten seconds reads as a hang. The socket doesn't tell us which
            // of the two is happening, but the clock does — so say the honest
            // thing only once the fast path has demonstrably not taken.
            <PaneLoading message={slow ? 'Starting the sandbox — a cold boot takes a few seconds…' : 'Connecting…'} />
          )}
        </div>
      )}
    </>
  );
}

/** Past a fast reattach, a connect is a cold boot. */
const COLD_BOOT_MS = 1500;

/** True once `ms` has elapsed with `active` still set. Resets whenever it isn't. */
function useElapsed(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);

  return elapsed;
}
