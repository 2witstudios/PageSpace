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
 *
 * Removing a workspace STOPS every agent its panes hold (`removeAgentTerminal`
 * per running pane) before dropping the local grid — this is the only
 * terminal-level stop/remove path left once `SessionLeaves`'s per-session
 * remove button is gone, so it must not merely hide a still-running (and
 * still-billing) agent with no row left to reach it from.
 *
 * A session the SERVER reports at this scope but that isn't yet any local
 * workspace's pane — another browser, a cleared localStorage, a session an
 * agent tool spawned directly — is rendered as an "unclaimed" row too:
 * clicking it materializes (and activates) its own workspace via the store's
 * `openTerminal`, the same reconciliation the old `SessionLeaves` did
 * implicitly by always listing the server's truth. Without this, such a
 * session is unreachable from the sidebar at all — can't be opened, and (since
 * removing a workspace is the only stop path now) can't be stopped either.
 */

import { useEffect, useRef, useState } from 'react';
import { Plus, TerminalSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useMachineWorkspaceStore,
  selectMachine,
  selectRunningPaneCount,
  workspacesOf,
  panesOf,
  isSameNodeScope,
  sessionWorkspaceId,
  type MachineNodeScope,
} from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { useAgentTerminals } from '@/hooks/useAgentTerminals';
import { useSyncedWorkspaceActions } from '@/hooks/useMachineWorkspaceSync';
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
  // Identity/layout-affecting actions push to the server (#2048); local-only
  // UI state (which row is being renamed, which is pending removal) stays here.
  const { removeWorkspace, closePane, openTerminal, renameWorkspace } = useSyncedWorkspaceActions(machineId);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  // Escape/Enter close the input by setting `renamingId` to null, which
  // unmounts it — and in Chromium, unmounting a still-focused element can
  // itself fire a NATIVE blur event that reaches `onBlur` below. Without this
  // guard, Escape's blur would re-commit the very draft the user just
  // cancelled, and Enter's would fire a redundant second commit. Set right
  // before closing, consumed (and reset) by the next `onBlur`; also reset
  // when a fresh rename starts, so a stale `true` can never suppress a later,
  // legitimate blur-to-commit.
  const skipNextBlur = useRef(false);

  const scope = nodeScopeOf(node);
  // Every pane in a workspace runs in the WORKSPACE's own node scope (see
  // newWorkspace), which is this node's scope — so one scoped hook covers
  // every pane (and every server-reported session) this node could hold.
  const { agentTerminals, removeAgentTerminal } = useAgentTerminals(machineId, scope.projectName, scope.branchName);

  if (!machine) return null;

  const workspaces = workspacesOf(machine).filter((workspace) => isSameNodeScope(workspace.scope, scope));
  const pendingWorkspace = workspaces.find((workspace) => workspace.id === pendingRemove);
  const pendingRunningPaneIds = pendingWorkspace
    ? panesOf(pendingWorkspace).filter((pane) => pane.scope !== null).map((pane) => pane.id)
    : [];
  const pendingRunningNames = pendingWorkspace
    ? panesOf(pendingWorkspace)
        .map((pane) => pane.scope?.name)
        .filter((name): name is string => name !== undefined)
    : [];

  const localNames = new Set(
    workspaces.flatMap((workspace) =>
      panesOf(workspace)
        .map((pane) => pane.scope?.name)
        .filter((name): name is string => name !== undefined),
    ),
  );
  const unclaimedSessions = agentTerminals.filter((terminal) => !localNames.has(terminal.name));

  const adopt = (name: string) => {
    openTerminal({ ...scope, name });
    onSelectWorkspace(sessionWorkspaceId({ ...scope, name }));
  };

  const startRename = (workspace: { id: string; name: string }) => {
    skipNextBlur.current = false;
    setRenamingId(workspace.id);
    setDraftName(workspace.name);
  };

  const commitRename = (workspaceId: string, currentName: string) => {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== currentName) renameWorkspace(workspaceId, trimmed);
    setRenamingId(null);
  };

  const cancelRename = () => {
    skipNextBlur.current = true;
    setRenamingId(null);
  };

  const commitRenameViaKey = (workspaceId: string, currentName: string) => {
    skipNextBlur.current = true;
    commitRename(workspaceId, currentName);
  };

  const commitRenameViaBlur = (workspaceId: string, currentName: string) => {
    if (skipNextBlur.current) {
      skipNextBlur.current = false;
      return;
    }
    commitRename(workspaceId, currentName);
  };

  return (
    <div>
      {workspaces.map((workspace) => (
        <div
          key={workspace.id}
          className={cn(
            'group flex items-center gap-1 rounded-sm py-0.5 pr-1 leading-none',
            workspace.id === machine.activeWorkspaceId ? 'bg-accent' : 'hover:bg-accent/50',
          )}
        >
          {renamingId === workspace.id ? (
            <div className="flex flex-1 items-center gap-1">
              <TerminalSquare className="size-3 shrink-0" />
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={() => commitRenameViaBlur(workspace.id, workspace.name)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRenameViaKey(workspace.id, workspace.name);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                aria-label={`Rename workspace ${workspace.name}`}
                className="w-full truncate rounded-sm border border-border bg-background px-1 text-sm font-normal leading-none outline-none"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onSelectWorkspace(workspace.id)}
              onDoubleClick={() => startRename(workspace)}
              aria-current={workspace.id === machine.activeWorkspaceId ? 'true' : undefined}
              className="flex flex-1 items-center gap-1 text-left"
            >
              <TerminalSquare className="size-3 shrink-0" />
              <span className="truncate font-normal text-sm leading-none">{workspace.name}</span>
            </button>
          )}
          <RemoveButton onClick={() => setPendingRemove(workspace.id)} label={`Remove workspace ${workspace.name}`} />
        </div>
      ))}
      {unclaimedSessions.map((session) => (
        <div
          key={`unclaimed-${session.name}`}
          className="group flex items-center gap-1 rounded-sm py-0.5 pr-1 leading-none hover:bg-accent/50"
        >
          <button
            type="button"
            onClick={() => adopt(session.name)}
            title="Running session not yet in this browser's workspace list — click to open it"
            className="flex flex-1 items-center gap-1 text-left"
          >
            <TerminalSquare className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate font-normal text-sm leading-none text-muted-foreground">{session.name}</span>
          </button>
        </div>
      ))}
      <ConfirmRemoveDialog
        open={pendingWorkspace !== undefined}
        onOpenChange={(open) => !open && setPendingRemove(null)}
        title="Remove workspace?"
        description={
          pendingWorkspace
            ? pendingRunningNames.length > 0
              ? `Remove workspace "${pendingWorkspace.name}"? This stops its ${pendingRunningNames.length} running agent${pendingRunningNames.length === 1 ? '' : 's'} — this cannot be undone.`
              : `Remove workspace "${pendingWorkspace.name}"?`
            : ''
        }
        onConfirm={async () => {
          if (pendingRemove === null) return;
          // Stop every running agent this workspace's panes hold BEFORE
          // dropping the local entry — otherwise the agent (and its billing)
          // survives with no sidebar row left to reach it from.
          await Promise.all(pendingRunningNames.map((name) => removeAgentTerminal(name)));
          // removeWorkspace no-ops when this is the machine's ONLY workspace
          // (a machine always keeps at least one) — empty its panes locally
          // instead of dropping the (unchanged) workspace, or it would linger
          // bound to the agent names just killed above.
          if (workspacesOf(machine).length <= 1) {
            pendingRunningPaneIds.forEach((paneId) => closePane(pendingRemove, paneId));
          } else {
            removeWorkspace(pendingRemove);
          }
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
  const { createWorkspace } = useSyncedWorkspaceActions(machineId);

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {runningCount > 0 && (
        <span className="rounded bg-muted px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground" title={`${runningCount} running`}>
          {runningCount} running
        </span>
      )}
      <AddButton
        onClick={() => onWorkspaceCreated(createWorkspace(scope))}
        label="New workspace"
        icon={<Plus className="mx-auto size-3" />}
      />
    </span>
  );
}
