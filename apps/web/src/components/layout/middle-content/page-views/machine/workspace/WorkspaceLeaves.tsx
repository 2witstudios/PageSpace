"use client";

/**
 * Workspace-item leaves injected by {@link MachineTree}'s `renderNodeChildren`
 * under each expanded node (Terminal UX redesign, sub-task 3).
 *
 * A sidebar item is a WORKSPACE — a persistent, auto-named entity owning a pane
 * grid — not a raw `agent_terminals` session. Selecting one switches the middle
 * view to its grid (`setActiveWorkspace`, wired by the caller via
 * `onSelectWorkspace`). A workspace's panes are never listed as their own rows:
 * `workspacesOf` only ever contains real top-level workspaces, since a pane
 * bound by split-and-pick (`bindPaneTerminal`) mutates the workspace it was
 * split into rather than minting a new entry — so child panes are hidden from
 * this list by construction, with nothing extra to filter here.
 *
 * Shared by the Machine page's Terminal tab and the Development surface's
 * sidebar: both hang the same workspace items off the same tree, and differ
 * only in what `onSelectWorkspace`/`onCreateWorkspace` do (activate in place
 * here; route to the machine first, there).
 */

import { useEffect, useState } from 'react';
import { Plus, TerminalSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useMachineWorkspaceStore,
  selectMachine,
  selectRunningPaneCount,
  workspacesOf,
  isSameNodeScope,
  type MachineNodeScope,
} from '@/stores/machine-workspace/useMachineWorkspaceStore';
import type { MachineTreeNode } from './MachineTree';
import ConfirmRemoveDialog from './ConfirmRemoveDialog';
import RemoveButton, { AddButton } from './RemoveButton';

/** A tree node's scope, minus the session/workspace name it might carry. */
export function nodeScopeOf(node: MachineTreeNode): MachineNodeScope {
  switch (node.level) {
    case 'machine':
      return {};
    case 'project':
      return { projectName: node.projectName };
    case 'branch':
      return { projectName: node.projectName, branchName: node.branchName };
  }
}

export default function WorkspaceLeaves({
  machineId,
  node,
  onSelectWorkspace,
}: {
  machineId: string;
  node: MachineTreeNode;
  onSelectWorkspace(workspaceId: string): void;
}) {
  // Idempotent-repair: gives the machine its first workspace if it has none,
  // so a node's leaves are never permanently empty for a machine this browser
  // has simply never opened yet.
  const ensureMachine = useMachineWorkspaceStore((state) => state.ensureMachine);
  useEffect(() => {
    ensureMachine(machineId);
  }, [machineId, ensureMachine]);

  const machine = useMachineWorkspaceStore(selectMachine(machineId));
  const removeWorkspace = useMachineWorkspaceStore((state) => state.removeWorkspace);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  if (!machine) return null;

  const scope = nodeScopeOf(node);
  const workspaces = workspacesOf(machine).filter((workspace) => isSameNodeScope(workspace.scope, scope));
  const pendingWorkspace = workspaces.find((workspace) => workspace.id === pendingRemove);

  return (
    <div>
      {workspaces.map((workspace) => (
        <div
          key={workspace.id}
          className={cn(
            'group flex items-center gap-1 rounded-sm py-1 pr-1',
            workspace.id === machine.activeWorkspaceId ? 'bg-accent' : 'hover:bg-accent/50',
          )}
        >
          <button
            type="button"
            onClick={() => onSelectWorkspace(workspace.id)}
            aria-current={workspace.id === machine.activeWorkspaceId ? 'true' : undefined}
            className="flex flex-1 items-center gap-1 text-left"
          >
            <TerminalSquare className="size-3.5 shrink-0" />
            <span className="truncate">{workspace.name}</span>
          </button>
          <RemoveButton onClick={() => setPendingRemove(workspace.id)} label={`Remove workspace ${workspace.name}`} />
        </div>
      ))}
      <ConfirmRemoveDialog
        open={pendingWorkspace !== undefined}
        onOpenChange={(open) => !open && setPendingRemove(null)}
        title="Remove workspace?"
        description={pendingWorkspace ? `Remove workspace "${pendingWorkspace.name}"? Its running agents keep running server-side; this only closes the local pane grid.` : ''}
        onConfirm={async () => {
          if (pendingRemove === null) return;
          removeWorkspace(machineId, pendingRemove);
        }}
      />
    </div>
  );
}

/**
 * A node's hover-revealed "N running" badge + new-workspace `+` button — the
 * de-bloated replacement for the "Terminals" sub-label and its modal (Sidebar
 * chrome section). Injected via `MachineTree`'s `renderNodeExtra` slot, kept
 * out of `MachineTree` itself: Diff/Files-tab callers reuse the same tree for
 * branch/file navigation and have no workspace to count or create.
 */
export function WorkspaceNodeExtras({
  machineId,
  node,
  onWorkspaceCreated,
}: {
  machineId: string;
  node: MachineTreeNode;
  /** Called with the new workspace's id right after it's created (and made active). */
  onWorkspaceCreated(workspaceId: string): void;
}) {
  const scope = nodeScopeOf(node);
  const runningCount = useMachineWorkspaceStore(selectRunningPaneCount(machineId, scope));
  const createWorkspace = useMachineWorkspaceStore((state) => state.createWorkspace);

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {runningCount > 0 && (
        <span className="rounded bg-muted px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground" title={`${runningCount} running`}>
          {runningCount} running
        </span>
      )}
      <AddButton
        onClick={() => onWorkspaceCreated(createWorkspace(machineId, scope))}
        label="New workspace"
        icon={<Plus className="mx-auto size-3.5" />}
      />
    </span>
  );
}
