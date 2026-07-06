"use client";

import { useCallback, useState } from 'react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useSocket } from '@/hooks/useSocket';
import Navigator from './Navigator';
import TerminalPanes, { type TerminalPaneState } from './TerminalPanes';

interface TerminalWorkspaceProps {
  /** The Terminal page's own id — this page IS the Machine (tasks/terminal.md). */
  terminalId: string;
}

function newPane(terminalName: string | null = null): TerminalPaneState {
  return { id: crypto.randomUUID(), terminalName };
}

export default function TerminalWorkspace({ terminalId }: TerminalWorkspaceProps) {
  const socket = useSocket();
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [panes, setPanes] = useState<TerminalPaneState[]>(() => [newPane()]);

  const handleSelectProject = useCallback((name: string) => {
    setSelectedProject((prev) => {
      if (prev === name) return prev;
      setSelectedBranch(null);
      setPanes([newPane()]);
      return name;
    });
  }, []);

  const handleSelectBranch = useCallback((name: string) => {
    setSelectedBranch((prev) => {
      if (prev === name) return prev;
      setPanes([newPane()]);
      return name;
    });
  }, []);

  const handleOpenTerminal = useCallback((name: string) => {
    setPanes((prev) => {
      if (prev.length === 0) return [newPane(name)];
      const next = [...prev];
      next[next.length - 1] = { ...next[next.length - 1], terminalName: name };
      return next;
    });
  }, []);

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full w-full">
      <ResizablePanel defaultSize={75} minSize={30}>
        <TerminalPanes
          terminalId={terminalId}
          projectName={selectedProject}
          branchName={selectedBranch}
          socket={socket}
          panes={panes}
          setPanes={setPanes}
        />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={25} minSize={16} maxSize={40}>
        <Navigator
          terminalId={terminalId}
          selectedProject={selectedProject}
          selectedBranch={selectedBranch}
          onSelectProject={handleSelectProject}
          onSelectBranch={handleSelectBranch}
          onOpenTerminal={handleOpenTerminal}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
