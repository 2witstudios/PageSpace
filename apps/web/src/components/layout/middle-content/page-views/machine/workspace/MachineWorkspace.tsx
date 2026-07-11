"use client";

import { useEffect } from 'react';
import { useSocket } from '@/hooks/useSocket';
import { useMachineWorkspaceStore } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import TerminalPanes from './TerminalPanes';

interface MachineWorkspaceProps {
  /** The Machine page's own id — this page IS the Machine (tasks/terminal.md). */
  machineId: string;
}

export default function MachineWorkspace({ machineId }: MachineWorkspaceProps) {
  const socket = useSocket();
  const ensureWorkspace = useMachineWorkspaceStore((state) => state.ensureWorkspace);
  const disposeWorkspace = useMachineWorkspaceStore((state) => state.disposeWorkspace);

  // The Machine tree sidebar (Terminal tab) and TerminalPanes (here) share this
  // workspace by composition through the store — no common parent to hold
  // local state now that they live in different parts of the layout.
  useEffect(() => {
    ensureWorkspace(machineId);
    return () => disposeWorkspace(machineId);
  }, [machineId, ensureWorkspace, disposeWorkspace]);

  return <TerminalPanes machineId={machineId} socket={socket} />;
}
