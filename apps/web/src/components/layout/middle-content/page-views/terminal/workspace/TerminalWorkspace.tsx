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
  const [activePaneId, setActivePaneId] = useState<string>(() => panes[0].id);

  // Opening a terminal from the Navigator always targets the pane the user
  // last clicked/split into — an explicit "active pane" rather than guessing
  // from array position, which silently overwrote the wrong pane whenever a
  // second pane existed.
  const handleOpenTerminal = useCallback(
    (scope: OpenTerminalScope) => {
      setPanes(panes.map((p) => (p.id === activePaneId ? { ...p, scope } : p)));
    },
    [panes, activePaneId],
  );

  const handleSplit = useCallback(() => {
    const pane = newPane();
    setPanes([...panes, pane]);
    setActivePaneId(pane.id);
  }, [panes]);

  const handleClosePane = useCallback(
    (id: string) => {
      if (panes.length <= 1) return;
      const next = panes.filter((p) => p.id !== id);
      setPanes(next);
      if (activePaneId === id) setActivePaneId(next[0].id);
    },
    [panes, activePaneId],
  );

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full w-full">
      <ResizablePanel defaultSize={75} minSize={30}>
        <TerminalPanes
          terminalId={terminalId}
          socket={socket}
          panes={panes}
          activePaneId={activePaneId}
          onSelectPane={setActivePaneId}
          onSplit={handleSplit}
          onClosePane={handleClosePane}
        />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={25} minSize={16} maxSize={40}>
        <Navigator terminalId={terminalId} onOpenTerminal={handleOpenTerminal} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
