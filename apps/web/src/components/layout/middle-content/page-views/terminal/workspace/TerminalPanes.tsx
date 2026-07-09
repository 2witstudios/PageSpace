"use client";

import { Fragment, useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import type { Socket } from 'socket.io-client';
import { SquareSplitHorizontal, SquareSplitVertical, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useTerminalWorkspaceStore, selectWorkspace, type OpenTerminalScope, type TerminalPaneState } from '@/stores/terminal-workspace/useTerminalWorkspaceStore';
import EmptyState from './EmptyState';

const XtermTerminal = dynamic(() => import('../XtermTerminal'), { ssr: false });

export type { TerminalPaneState };

interface TerminalPanesProps {
  terminalId: string;
  socket: Socket | null | undefined;
}

function paneSessionId(terminalId: string, scope: OpenTerminalScope): string {
  return `agent-terminal:${terminalId}:${scope.projectName ?? ''}:${scope.branchName ?? ''}:${scope.name}`;
}

export default function TerminalPanes({ terminalId, socket }: TerminalPanesProps) {
  const workspace = useTerminalWorkspaceStore(selectWorkspace(terminalId));
  const splitRight = useTerminalWorkspaceStore((state) => state.splitRight);
  const splitDown = useTerminalWorkspaceStore((state) => state.splitDown);
  const closePane = useTerminalWorkspaceStore((state) => state.closePane);
  const selectPane = useTerminalWorkspaceStore((state) => state.selectPane);

  // Briefly undefined between this component's first render and the
  // mounting TerminalWorkspace's ensureWorkspace effect committing.
  if (!workspace) return null;

  const { columns, activePaneId } = workspace;
  const canClose = columns.reduce((sum, column) => sum + column.panes.length, 0) > 1;

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
                      <TerminalPane
                        socket={socket}
                        terminalId={terminalId}
                        pane={pane}
                        isActive={pane.id === activePaneId}
                        canClose={canClose}
                        onSelect={() => selectPane(terminalId, pane.id)}
                        onSplitRight={() => splitRight(terminalId, pane.id)}
                        onSplitDown={() => splitDown(terminalId, pane.id)}
                        onClose={() => closePane(terminalId, pane.id)}
                      />
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
 * Chrome-free by design (no per-pane header, ever, verified against
 * PurePoint's real chrome-free pane design) — a top accent bar shows focus
 * and hover-revealed controls handle splitting/closing without permanent
 * chrome. Known tradeoff: with 2+ panes open the Navigator sidebar does not
 * yet indicate which open terminal is showing in which pane — that's
 * sidebar/Navigator work, out of scope for this theming-foundation round.
 */
function TerminalPane({
  socket,
  terminalId,
  pane,
  isActive,
  canClose,
  onSelect,
  onSplitRight,
  onSplitDown,
  onClose,
}: {
  socket: Socket | null | undefined;
  terminalId: string;
  pane: TerminalPaneState;
  isActive: boolean;
  canClose: boolean;
  onSelect(): void;
  onSplitRight(): void;
  onSplitDown(): void;
  onClose(): void;
}) {
  const sessionId = pane.scope ? paneSessionId(terminalId, pane.scope) : null;

  return (
    <div className="group/pane relative flex h-full flex-col" onClick={onSelect}>
      <div className={`absolute inset-x-0 top-0 z-10 h-0.5 ${isActive ? 'bg-primary' : 'bg-transparent'}`} />
      <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-md border border-border bg-card/90 p-0.5 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover/pane:opacity-100 group-focus-within/pane:opacity-100">
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
      <div className="relative min-h-0 flex-1">
        {!pane.scope || !sessionId ? (
          <EmptyState title="No terminal open" description="Select a terminal from the navigator, or add one from any node." />
        ) : (
          <TerminalPaneStream key={sessionId} socket={socket} terminalId={terminalId} scope={pane.scope} sessionId={sessionId} />
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
  terminalId,
  scope,
  sessionId,
}: {
  socket: Socket | null | undefined;
  terminalId: string;
  scope: OpenTerminalScope;
  sessionId: string;
}) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReady = useCallback(() => setConnected(true), []);
  const handleError = useCallback((message: string) => setError(message), []);

  return (
    <>
      {socket && (
        <XtermTerminal
          socket={socket}
          sessionId={sessionId}
          connectPayload={{ terminalId, projectName: scope.projectName, branchName: scope.branchName, name: scope.name }}
          onReady={handleReady}
          onError={handleError}
        />
      )}
      {!connected && (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          {error ? (
            <span className="text-sm text-destructive">{error}</span>
          ) : (
            <div className="flex items-center gap-2">
              <div className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-sm text-muted-foreground">Connecting…</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
