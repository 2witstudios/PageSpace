"use client";

import { useEffect } from 'react';
import { useSocket } from '@/hooks/useSocket';
import { useMachineWorkspaceStore } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import TerminalPanes from './TerminalPanes';

interface MachineWorkspaceProps {
  /** The Machine page's own id — this page IS the Machine (tasks/terminal.md). */
  machineId: string;
}

/**
 * The Machine page's middle view. It always renders the ACTIVE workspace's pane
 * grid, so selecting a different workspace switches the entire view to that
 * item's combination of terminals.
 */
export default function MachineWorkspace({ machineId }: MachineWorkspaceProps) {
  const socket = useSocket();
  const ensureMachine = useMachineWorkspaceStore((state) => state.ensureMachine);

  // Give the machine its first workspace, once. Nothing is disposed on unmount:
  // the store is persisted precisely so a workspace's grid survives navigation
  // and a reload, and comes back reattached to the PTYs still running in it.
  useEffect(() => {
    ensureMachine(machineId);
  }, [machineId, ensureMachine]);

  return <TerminalPanes machineId={machineId} socket={socket} />;
}
