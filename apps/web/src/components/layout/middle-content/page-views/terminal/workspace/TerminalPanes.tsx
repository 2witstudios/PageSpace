"use client";

import { Fragment, useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import dynamic from 'next/dynamic';
import type { Socket } from 'socket.io-client';
import { SquareSplitHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useAgentTerminals } from '@/hooks/useAgentTerminals';
import EmptyState from './EmptyState';

const XtermTerminal = dynamic(() => import('../XtermTerminal'), { ssr: false });

export interface TerminalPaneState {
  id: string;
  terminalName: string | null;
}

interface TerminalPanesProps {
  terminalId: string;
  projectName: string | null;
  branchName: string | null;
  socket: Socket | null | undefined;
  panes: TerminalPaneState[];
  setPanes: Dispatch<SetStateAction<TerminalPaneState[]>>;
}

export default function TerminalPanes({ terminalId, projectName, branchName, socket, panes, setPanes }: TerminalPanesProps) {
  const { agentTerminals } = useAgentTerminals(terminalId, projectName, branchName);

  if (!projectName || !branchName) {
    return <EmptyState title="No branch selected" description="Select a branch in the navigator to open a terminal." />;
  }

  const handleSplit = () => setPanes((prev) => [...prev, { id: crypto.randomUUID(), terminalName: null }]);
  const handleClosePane = (id: string) => setPanes((prev) => (prev.length <= 1 ? prev : prev.filter((p) => p.id !== id)));
  const handleSelectPaneTerminal = (id: string, name: string | null) =>
    setPanes((prev) => prev.map((p) => (p.id === id ? { ...p, terminalName: name } : p)));

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
                projectName={projectName}
                branchName={branchName}
                pane={pane}
                agentTerminalNames={agentTerminals.map((t) => t.name)}
                canClose={panes.length > 1}
                onClose={() => handleClosePane(pane.id)}
                onSelectTerminal={(name) => handleSelectPaneTerminal(pane.id, name)}
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
  projectName,
  branchName,
  pane,
  agentTerminalNames,
  canClose,
  onClose,
  onSelectTerminal,
}: {
  socket: Socket | null | undefined;
  terminalId: string;
  projectName: string;
  branchName: string;
  pane: TerminalPaneState;
  agentTerminalNames: string[];
  canClose: boolean;
  onClose(): void;
  onSelectTerminal(name: string | null): void;
}) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Switching which terminal this pane shows re-mounts XtermTerminal (keyed by
  // sessionId below) — reset the local connection-status UI to match.
  useEffect(() => {
    setConnected(false);
    setError(null);
  }, [pane.terminalName]);

  const handleReady = useCallback(() => setConnected(true), []);
  const handleError = useCallback((message: string) => setError(message), []);

  const sessionId = `agent-terminal:${terminalId}:${projectName}:${branchName}:${pane.terminalName ?? ''}`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-white/10 bg-white/5 px-1.5 py-1">
        <Select value={pane.terminalName ?? undefined} onValueChange={(value) => onSelectTerminal(value)}>
          <SelectTrigger size="sm" className="h-6 flex-1 border-none bg-transparent text-xs text-white/80 shadow-none">
            <SelectValue placeholder="Select a terminal…" />
          </SelectTrigger>
          <SelectContent>
            {agentTerminalNames.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canClose && (
          <Button variant="ghost" size="icon" onClick={onClose} className="size-5 text-white/60 hover:text-white">
            <X className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {!pane.terminalName ? (
          <EmptyState title="No terminal open" description="Choose a terminal above, or add one from the navigator." />
        ) : (
          <>
            {socket && (
              <XtermTerminal
                key={sessionId}
                socket={socket}
                sessionId={sessionId}
                eventPrefix="agent-terminal"
                connectPayload={{ terminalId, projectName, branchName, name: pane.terminalName }}
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
