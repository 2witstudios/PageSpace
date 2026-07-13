"use client";

import { useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useMachineWorkspaceStore } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import MachineTree, { type MachineTreeNode } from '../workspace/MachineTree';
import WorkspaceLeaves, { WorkspaceNodeExtras } from '../workspace/WorkspaceLeaves';
import TabSidebar from './TabSidebar';

// MachineWorkspace owns the xterm subtree + socket; it must never SSR.
const MachineWorkspace = dynamic(() => import('../workspace/MachineWorkspace'), { ssr: false });

interface TerminalTabProps {
  /** The Machine page's own id (= pageId). Workspaces/panes are keyed by it. */
  machineId: string;
  /**
   * Set when this tab is hosted inside the Development surface rather than the
   * standalone Machine page. There, `DevelopmentSidebar` already renders the
   * SAME shared tree with the SAME workspace items one level up — so the inner
   * sidebar here would be a redundant second copy. Embedded, this renders just
   * the active workspace's grid; standalone (default), it keeps its own tree,
   * the only workspace nav on that page.
   */
  embedded?: boolean;
}

/**
 * The Machine page's Terminal tab: the shared {@link TabSidebar} (plain border
 * chrome — deliberately NOT the app's liquid-glass sidebars) rendering the shared
 * {@link MachineTree} with workspace-item leaves injected under every
 * Machine/Project/Branch node, beside the pane workspace. This is the new home of
 * the session navigation that used to live in the right-sidebar Navigator tab —
 * clicking a workspace switches the ENTIRE middle view to its grid, via the
 * shared machine-workspace store.
 *
 * Selecting a workspace also `close()`s the sidebar, which on a narrow viewport
 * dismisses the sheet the tree is in — the user asked to look at that grid, and
 * it is behind the sheet.
 */
export default function TerminalTab({ machineId, embedded = false }: TerminalTabProps) {
  const workspacePane = <MachineWorkspace machineId={machineId} />;
  if (embedded) return workspacePane;

  return (
    <TabSidebar title="Sessions" pane={workspacePane}>
      {({ close }) => <WorkspaceTree machineId={machineId} onSelected={close} />}
    </TabSidebar>
  );
}

/**
 * The workspace tree. A component rather than inline JSX so the select handler
 * — and through it `renderNodeChildren`/`renderNodeExtra` — can be built with
 * `useCallback` in a scope that has stable inputs: `TabSidebar` hands out a
 * stable `close`, so this memo genuinely holds instead of being invalidated by
 * a fresh closure every render.
 */
function WorkspaceTree({ machineId, onSelected }: { machineId: string; onSelected: () => void }) {
  const setActiveWorkspace = useMachineWorkspaceStore((state) => state.setActiveWorkspace);

  const onSelectWorkspace = useCallback(
    (workspaceId: string) => {
      setActiveWorkspace(machineId, workspaceId);
      // On a narrow viewport the tree is in a sheet, and the grid the user just
      // asked for is behind it. A no-op on desktop.
      onSelected();
    },
    [setActiveWorkspace, machineId, onSelected],
  );

  const renderNodeChildren = useCallback(
    (node: MachineTreeNode) => (
      <WorkspaceLeaves machineId={machineId} node={node} onSelectWorkspace={onSelectWorkspace} />
    ),
    [machineId, onSelectWorkspace],
  );

  const renderNodeExtra = useCallback(
    (node: MachineTreeNode) => (
      <WorkspaceNodeExtras machineId={machineId} node={node} onWorkspaceCreated={onSelectWorkspace} />
    ),
    [machineId, onSelectWorkspace],
  );

  return <MachineTree machineId={machineId} renderNodeChildren={renderNodeChildren} renderNodeExtra={renderNodeExtra} />;
}
