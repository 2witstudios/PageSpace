"use client";

import { Fragment, useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import dynamic from 'next/dynamic';
import type { Socket } from 'socket.io-client';
import { SquareSplitHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import EmptyState from './EmptyState';
import type { OpenTerminalScope } from './Navigator';

const XtermTerminal = dynamic(() => import('../XtermTerminal'), { ssr: false });

export interface TerminalPaneState {
  id: string;
  scope: OpenTerminalScope | null;
}

interface TerminalPanesProps {
  terminalId: string;
  socket: Socket | null | undefined;
  panes: TerminalPaneState[];
  setPanes: Dispatch<SetStateAction<TerminalPaneState[]>>;
}

function scopeLabel(scope: OpenTerminalScope): string {
  return [scope.projectName, scope.branchName, scope.name].filter(Boolean).join('/');
}

function paneSessionId(terminalId: string, scope: OpenTerminalScope): string {
  return `agent-terminal:${terminalId}:${scope.projectName ?? ''}:${scope.branchName ?? ''}:${scope.name}`;
}

export default function TerminalPanes({ terminalId, socket, panes, setPanes }: TerminalPanesProps) {
  const handleSplit = () => setPanes((prev) => [...prev, { id: crypto.randomUUID(), scope: null }]);
  const handleClosePane = (id: string) => setPanes((prev) => (prev.length <= 1 ? prev : prev.filter((p) => p.id !== id)));

  return (
    <div className="flex h-full flex-col bg-black">
      <div className="flex items-center justify-end gap-1 border-b border-white/10 px-2 py-1">
        <Button variant="ghost" size="sm" onClick={handleSplit} className="h-6 gap-1 px-2 text-xs text-white/70 hover:text-white">
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
                canClose={panes.length > 1}
                onClose={() => handleClosePane(pane.id)}
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
  canClose,
  onClose,
}: {
  socket: Socket | null | undefined;
  terminalId: string;
  pane: TerminalPaneState;
  canClose: boolean;
  onClose(): void;
}) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionId = pane.scope ? paneSessionId(terminalId, pane.scope) : null;

  // Opening a different terminal in this pane re-mounts XtermTerminal (keyed by
  // sessionId below) — reset the local connection-status UI to match.
  useEffect(() => {
    setConnected(false);
    setError(null);
  }, [sessionId]);

  const handleReady = useCallback(() => setConnected(true), []);
  const handleError = useCallback((message: string) => setError(message), []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-white/10 bg-white/5 px-1.5 py-1">
        <span className="flex-1 truncate px-1 text-xs text-white/80">
          {pane.scope ? scopeLabel(pane.scope) : 'No terminal open'}
        </span>
        {canClose && (
          <Button variant="ghost" size="icon" onClick={onClose} className="size-5 text-white/60 hover:text-white">
            <X className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {!pane.scope || !sessionId ? (
          <EmptyState title="No terminal open" description="Select a terminal from the navigator, or add one from any node." />
        ) : (
          <>
            {socket && (
              <XtermTerminal
                key={sessionId}
                socket={socket}
                sessionId={sessionId}
                connectPayload={{
                  terminalId,
                  projectName: pane.scope.projectName,
                  branchName: pane.scope.branchName,
                  name: pane.scope.name,
                }}
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
        )}
      </div>
    </div>
  );
}
