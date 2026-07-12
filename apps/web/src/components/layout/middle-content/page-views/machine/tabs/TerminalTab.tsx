"use client";

import { useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useMachineWorkspaceStore, type OpenTerminalScope } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import MachineTree, { type MachineTreeNode } from '../workspace/MachineTree';
import SessionLeaves from '../workspace/SessionLeaves';
import TabSidebar from './TabSidebar';

// MachineWorkspace owns the xterm subtree + socket; it must never SSR.
const MachineWorkspace = dynamic(() => import('../workspace/MachineWorkspace'), { ssr: false });

interface TerminalTabProps {
  /** The Machine page's own id (= pageId). Sessions/panes are keyed by it. */
  machineId: string;
}

/**
 * The Machine page's Terminal tab: the shared {@link TabSidebar} (plain border
 * chrome — deliberately NOT the app's liquid-glass sidebars) rendering the shared
 * {@link MachineTree} with session-terminal leaves injected under every
 * Machine/Project/Branch node, beside the pane workspace. This is the new home of
 * the session navigation that used to live in the right-sidebar Navigator tab —
 * clicking a session opens it in the workspace via the shared machine-workspace
 * store, exactly as before.
 *
 * Opening a session also `close()`s the sidebar, which on a narrow viewport
 * dismisses the sheet the tree is in — the user asked to look at that terminal,
 * and it is behind the sheet.
 */
export default function TerminalTab({ machineId }: TerminalTabProps) {
  return (
    <TabSidebar title="Sessions" pane={<MachineWorkspace machineId={machineId} />}>
      {({ close }) => <SessionTree machineId={machineId} onOpened={close} />}
    </TabSidebar>
  );
}

/**
 * The session tree. A component rather than inline JSX so the open handler — and
 * through it `renderNodeChildren` — can be built with `useCallback` in a scope
 * that has stable inputs: `TabSidebar` hands out a stable `close`, so this memo
 * genuinely holds instead of being invalidated by a fresh closure every render.
 */
function SessionTree({ machineId, onOpened }: { machineId: string; onOpened: () => void }) {
  const openTerminal = useMachineWorkspaceStore((state) => state.openTerminal);

  const onOpenTerminal = useCallback(
    (scope: OpenTerminalScope) => {
      openTerminal(machineId, scope);
      // On a narrow viewport the tree is in a sheet, and the terminal the user
      // just asked for is behind it. A no-op on desktop.
      onOpened();
    },
    [openTerminal, machineId, onOpened],
  );

  const renderNodeChildren = useCallback(
    (node: MachineTreeNode) => (
      <SessionLeaves machineId={machineId} node={node} onOpenTerminal={onOpenTerminal} />
    ),
    [machineId, onOpenTerminal],
  );

  return <MachineTree machineId={machineId} renderNodeChildren={renderNodeChildren} />;
}
