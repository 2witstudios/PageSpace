"use client";

import { useEffect } from 'react';
import { useSocket } from '@/hooks/useSocket';
import { useTerminalWorkspaceStore } from '@/stores/terminal-workspace/useTerminalWorkspaceStore';
import TerminalPanes from './TerminalPanes';

interface TerminalWorkspaceProps {
  /** The Terminal page's own id — this page IS the Machine (tasks/terminal.md). */
  machineId: string;
}

export default function TerminalWorkspace({ machineId }: TerminalWorkspaceProps) {
  const socket = useSocket();
  const ensureWorkspace = useTerminalWorkspaceStore((state) => state.ensureWorkspace);
  const disposeWorkspace = useTerminalWorkspaceStore((state) => state.disposeWorkspace);

  // The Navigator (right sidebar) and TerminalPanes (here) share this
  // workspace by composition through the store — no common parent to hold
  // local state now that they live in different parts of the layout.
  useEffect(() => {
    ensureWorkspace(machineId);
    return () => disposeWorkspace(machineId);
  }, [machineId, ensureWorkspace, disposeWorkspace]);

  return <TerminalPanes machineId={machineId} socket={socket} />;
}
