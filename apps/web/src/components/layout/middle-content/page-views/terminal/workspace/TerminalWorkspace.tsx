"use client";

import { useCallback, useState } from 'react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useSocket } from '@/hooks/useSocket';
import Navigator, { type OpenTerminalScope } from './Navigator';
import TerminalPanes, { type TerminalPaneState } from './TerminalPanes';

interface TerminalWorkspaceProps {
  /** The Terminal page's own id — this page IS the Machine (tasks/terminal.md). */
  terminalId: string;
}

function newPane(scope: OpenTerminalScope | null = null): TerminalPaneState {
  return { id: crypto.randomUUID(), scope };
}

export default function TerminalWorkspace({ terminalId }: TerminalWorkspaceProps) {
  const socket = useSocket();
  const [panes, setPanes] = useState<TerminalPaneState[]>(() => [newPane()]);

  const handleOpenTerminal = useCallback((scope: OpenTerminalScope) => {
    setPanes((prev) => {
      if (prev.length === 0) return [newPane(scope)];
      const next = [...prev];
      next[next.length - 1] = { ...next[next.length - 1], scope };
      return next;
    });
  }, []);

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full w-full">
      <ResizablePanel defaultSize={75} minSize={30}>
        <TerminalPanes terminalId={terminalId} socket={socket} panes={panes} setPanes={setPanes} />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={25} minSize={16} maxSize={40}>
        <Navigator terminalId={terminalId} onOpenTerminal={handleOpenTerminal} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
