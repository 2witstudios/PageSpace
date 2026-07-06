"use client";

import { Fragment, useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import type { Socket } from 'socket.io-client';
import { SquareSplitHorizontal, X } from 'lucide-react';
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

function scopeLabel(scope: OpenTerminalScope): string {
  return [scope.projectName, scope.branchName, scope.name].filter(Boolean).join('/');
}

function paneSessionId(terminalId: string, scope: OpenTerminalScope): string {
  return `agent-terminal:${terminalId}:${scope.projectName ?? ''}:${scope.branchName ?? ''}:${scope.name}`;
}

export default function TerminalPanes({ terminalId, socket }: TerminalPanesProps) {
  const workspace = useTerminalWorkspaceStore(selectWorkspace(terminalId));
  const split = useTerminalWorkspaceStore((state) => state.split);
  const closePane = useTerminalWorkspaceStore((state) => state.closePane);
  const selectPane = useTerminalWorkspaceStore((state) => state.selectPane);

  // Briefly undefined between this component's first render and the
  // mounting TerminalWorkspace's ensureWorkspace effect committing.
  if (!workspace) return null;

  const { panes, activePaneId } = workspace;

  return (
    <div className="flex h-full flex-col bg-black">
      <div className="flex items-center justify-end gap-1 border-b border-white/10 px-2 py-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => split(terminalId)}
          className="h-6 gap-1 px-2 text-xs text-white/70 hover:text-white"
        >
          <SquareSplitHorizontal className="size-3.5" />
          Split
        </Button>
      </div>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        {panes.map((pane, i) => (
          <Fragment key={pane.id}>
            {i > 0 && <ResizableHandle />}
            <ResizablePanel defaultSize={100 / panes.length} minSize={20}>
              <TerminalPane
                socket={socket}
                terminalId={terminalId}
                pane={pane}
                isActive={pane.id === activePaneId}
                canClose={panes.length > 1}
                onSelect={() => selectPane(terminalId, pane.id)}
                onClose={() => closePane(terminalId, pane.id)}
              />
            </ResizablePanel>
          </Fragment>
        ))}
      </ResizablePanelGroup>
    </div>
  );
}

function TerminalPane({
  socket,
  terminalId,
  pane,
  isActive,
  canClose,
  onSelect,
  onClose,
}: {
  socket: Socket | null | undefined;
  terminalId: string;
  pane: TerminalPaneState;
  isActive: boolean;
  canClose: boolean;
  onSelect(): void;
  onClose(): void;
}) {
  const sessionId = pane.scope ? paneSessionId(terminalId, pane.scope) : null;

  return (
    <div
      className={`flex h-full flex-col ${isActive ? 'ring-1 ring-inset ring-emerald-500/50' : ''}`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-1 border-b border-white/10 bg-white/5 px-1.5 py-1">
        <span className="flex-1 truncate px-1 text-xs text-white/80">
          {pane.scope ? scopeLabel(pane.scope) : 'No terminal open — click to make this pane active, then pick a terminal in the navigator'}
        </span>
        {canClose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="size-5 text-white/60 hover:text-white"
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
        <div className="absolute inset-0 flex items-center justify-center bg-black">
          {error ? (
            <span className="text-sm text-red-400">{error}</span>
          ) : (
            <div className="flex items-center gap-2">
              <div className="size-4 animate-spin rounded-full border-2 border-green-400 border-t-transparent" />
              <span className="text-sm text-green-400">Connecting…</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
