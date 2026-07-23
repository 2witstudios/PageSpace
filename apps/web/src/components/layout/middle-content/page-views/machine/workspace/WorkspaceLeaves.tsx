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
 * Removing a workspace STOPS every agent its panes hold (`killAgentTerminal`
 * per running session, addressed by the checkout re-derived from the OWNING
 * workspace — a pane stores only its name) before dropping the local grid — it must
 * not merely hide a still-running (and still-billing) agent with no row left
 * to reach it from. Sessions another workspace's pane still shows are spared
 * (same rule as TerminalPanes' close-and-kill: never pull a PTY out from under
 * a pane still showing it), and two panes showing one session kill it once.
 * Removal applies to the machine's LAST workspace too: a workspace is a view of
 * terminals, and a view you cannot destroy is not a view. Zero workspaces is a
 * legal state — the middle view renders an empty state for it.
 *
 * A session the SERVER reports at this scope but that isn't yet any local
 * workspace's pane — another browser, or a session an agent tool spawned
 * directly — is rendered as an "unclaimed" row too: clicking it materializes
 * (and activates) its own workspace via the store's `openTerminal`, the same
 * reconciliation the old `SessionLeaves` did implicitly by always listing the
 * server's truth. Without this, such a session is unreachable from the sidebar
 * at all. Every unclaimed row carries its own remove button, since the
 * workspace-level stop path is exactly what it lacks.
 */

import { useEffect, useRef, useState } from 'react';
import { TerminalSquare } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  useMachineWorkspaceStore,
  selectMachine,
  selectRunningPaneCount,
  workspacesOf,
  panesOf,
  isSameNodeScope,
  sessionWorkspaceId,
  paneTerminalScope,
  nodeScopeNames,
  MACHINE_NODE_SCOPE,
  type MachineNodeScope,
  type OpenTerminalScope,
  type WorkspaceState,
} from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { useAgentTerminals, killAgentTerminal } from '@/hooks/useAgentTerminals';
import { useSyncedWorkspaceActions } from '@/hooks/useMachineWorkspaceSync';
import { isAgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';
import type { MachineTreeNode } from './MachineTree';
import ConfirmRemoveDialog from './ConfirmRemoveDialog';
import RemoveButton from './RemoveButton';

/** Every session a workspace's panes hold, as full (project, branch, name)
 * addresses — the pane stores a name, the workspace supplies the checkout. */
function sessionScopesOf(workspace: WorkspaceState): OpenTerminalScope[] {
  return panesOf(workspace).flatMap((pane) => (pane.scope ? [paneTerminalScope(workspace.scope, pane.scope)] : []));
}

/** A tree node's scope, minus the session/workspace name it might carry. The
 * tree node and the node scope now carry the SAME discriminant, so this is a
 * total, mechanical projection rather than a shape translation with an
 * "everything else is machine scope" fallthrough. */
export function nodeScopeOf(node: MachineTreeNode): MachineNodeScope {
  switch (node.level) {
    case 'machine':
      return MACHINE_NODE_SCOPE;
    case 'project':
      return { level: 'project', projectName: node.projectName };
    case 'branch':
      return { level: 'branch', projectName: node.projectName, branchName: node.branchName };
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
  const { removeWorkspace, openTerminal, renameWorkspace } = useSyncedWorkspaceActions(machineId);
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
  // A browser fires BOTH `click` events of a double-click before `dblclick` —
  // so a bare `onClick={() => onSelectWorkspace(...)}` selects the workspace
  // (running whatever side effects the caller's `onSelectWorkspace` has, e.g.
  // DevelopmentSidebar's navigates to the machine) on the way to renaming it,
  // not just on an intentional single click. Deferring the first click and
  // cancelling it if a second one (i.e. a double-click) follows within the
  // window is the standard single/double-click disambiguation for exactly
  // this conflict.
  const pendingSelectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (pendingSelectTimer.current) clearTimeout(pendingSelectTimer.current);
  }, []);

  const scope = nodeScopeOf(node);
  // Lists this node's server-reported sessions, and removes the unclaimed ones
  // — both genuinely AT this node's scope. Kills of a workspace's panes go
  // through `killAgentTerminal` instead: the workspace being removed need not
  // be one of THIS node's (the machine-wide sweep below spans every node), and
  // a DELETE under the wrong scope kills a different same-named terminal, or
  // nothing.
  const scopeNames = nodeScopeNames(scope);
  const { agentTerminals, removeAgentTerminal } = useAgentTerminals(machineId, scopeNames.projectName, scopeNames.branchName);

  if (!machine) return null;

  const workspaces = workspacesOf(machine).filter((workspace) => isSameNodeScope(workspace.scope, scope));
  const pendingWorkspace = workspaces.find((workspace) => workspace.id === pendingRemove);
  // What confirming the pending removal will actually stop: the workspace's
  // panes' sessions, each addressed by the checkout re-derived from the
  // workspace that owns the pane, deduped by session identity (two panes can
  // legitimately show one session — kill it once), and sparing any session a
  // pane of ANOTHER workspace still shows — the same rule as TerminalPanes'
  // close-and-kill, which must never pull a PTY out from under a pane still
  // showing it.
  const shownElsewhere = new Set(
    workspacesOf(machine)
      .filter((workspace) => workspace.id !== pendingWorkspace?.id)
      .flatMap(sessionScopesOf)
      .map(sessionWorkspaceId),
  );
  const pendingKillScopes = pendingWorkspace
    ? [...new Map(sessionScopesOf(pendingWorkspace).map((session) => [sessionWorkspaceId(session), session] as const))]
        .filter(([id]) => !shownElsewhere.has(id))
        .map(([, session]) => session)
    : [];

  // "Claimed" compares full session identity — the (project, branch, name)
  // triple via `sessionWorkspaceId` — against every pane on the MACHINE, not
  // pane names at this node alone: a same-named session at another checkout
  // must not mask this one, and a session shown by a pane of a workspace at
  // ANOTHER node is not unclaimed.
  const localSessionIds = new Set(workspacesOf(machine).flatMap(sessionScopesOf).map(sessionWorkspaceId));
  const sessionAt = (name: string): OpenTerminalScope => paneTerminalScope(scope, { name });
  const unclaimedSessions = agentTerminals.filter(
    (terminal) => !localSessionIds.has(sessionWorkspaceId(sessionAt(terminal.name))),
  );

  const adopt = (name: string) => {
    openTerminal(sessionAt(name));
    onSelectWorkspace(sessionWorkspaceId(sessionAt(name)));
  };

  const startRename = (workspace: { id: string; name: string }) => {
    skipNextBlur.current = false;
    setRenamingId(workspace.id);
    setDraftName(workspace.name);
  };

  // Deferred so a double-click's first `click` doesn't select the workspace
  // on its way to renaming it (see `pendingSelectTimer`'s doc above).
  const handleRowClick = (workspaceId: string) => {
    if (pendingSelectTimer.current) clearTimeout(pendingSelectTimer.current);
    pendingSelectTimer.current = setTimeout(() => {
      pendingSelectTimer.current = null;
      onSelectWorkspace(workspaceId);
    }, 250);
  };

  const handleRowDoubleClick = (workspace: { id: string; name: string }) => {
    if (pendingSelectTimer.current) {
      clearTimeout(pendingSelectTimer.current);
      pendingSelectTimer.current = null;
    }
    startRename(workspace);
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

  /** Unlike removing a live workspace (routed through {@link ConfirmRemoveDialog}, which
   * surfaces a thrown error as a toast), this is a one-click cleanup of a row with no
   * workspace behind it — no confirmation step, but a failed DELETE must still be
   * reported rather than silently no-op'ing (the row would otherwise look un-removable
   * with no feedback why). */
  const removeUnclaimedSession = async (name: string) => {
    try {
      await removeAgentTerminal(name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove session');
    }
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
              onClick={() => handleRowClick(workspace.id)}
              onDoubleClick={() => handleRowDoubleClick(workspace)}
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
      {unclaimedSessions.map((session) => {
        // A row whose agentType predates a since-retired AGENT_LAUNCH_SPECS entry
        // (e.g. the removed 'pagespace-cli') can't be adopted — resolving it
        // server-side would just come back not_found. Still shown (not dropped
        // from the list), because removing it is the only way to reclaim its
        // name and stop billing on any PTY still running under it.
        const launchable = isAgentRuntimeType(session.agentType);
        return (
          <div
            key={`unclaimed-${session.name}`}
            className="group flex items-center gap-1 rounded-sm py-0.5 pr-1 leading-none hover:bg-accent/50"
          >
            <button
              type="button"
              onClick={launchable ? () => adopt(session.name) : undefined}
              disabled={!launchable}
              title={
                launchable
                  ? "Running session not yet in this browser's workspace list — click to open it"
                  : "This session's agent type is no longer supported — it can't be opened, only removed"
              }
              className={cn('flex flex-1 items-center gap-1 text-left', !launchable && 'cursor-default')}
            >
              <TerminalSquare className={cn('size-3 shrink-0', launchable ? 'text-muted-foreground' : 'text-muted-foreground/60')} />
              <span
                className={cn(
                  'truncate font-normal text-sm leading-none',
                  launchable ? 'text-muted-foreground' : 'text-muted-foreground/60 italic',
                )}
              >
                {session.name}
              </span>
            </button>
            {/* EVERY unclaimed row is removable, not just the unlaunchable ones.
                A `shell`/`claude`/`codex` orphan used to have no remove button
                at all: the only stop path was "remove the workspace holding it",
                which by definition is the thing an unclaimed session doesn't
                have. It was a listing you could not get rid of. */}
            <RemoveButton
              onClick={() => void removeUnclaimedSession(session.name)}
              label={`Remove session ${session.name}`}
            />
          </div>
        );
      })}
      <ConfirmRemoveDialog
        open={pendingWorkspace !== undefined}
        onOpenChange={(open) => !open && setPendingRemove(null)}
        title="Remove workspace?"
        description={
          pendingWorkspace
            ? pendingKillScopes.length > 0
              ? `Remove workspace "${pendingWorkspace.name}"? This stops its ${pendingKillScopes.length} running agent${pendingKillScopes.length === 1 ? '' : 's'} — this cannot be undone.`
              : `Remove workspace "${pendingWorkspace.name}"?`
            : ''
        }
        onConfirm={async () => {
          if (pendingRemove === null) return;
          // Stop every running agent this workspace's panes hold BEFORE
          // dropping the local entry — otherwise the agent (and its billing)
          // survives with no sidebar row left to reach it from. Addressed by
          // each pane's OWN scope (see pendingKillScopes' doc above).
          await Promise.all(pendingKillScopes.map((paneScope) => killAgentTerminal(machineId, paneScope)));
          // Unconditional, including the machine's last workspace. This used to
          // branch: `removeWorkspace` no-op'd on the last one, so the row was
          // emptied in place instead — which left it in the sidebar, unremovable
          // no matter how many times the user confirmed, and `+ New terminal`
          // then added a SECOND row beside the zombie.
          removeWorkspace(pendingRemove);
        }}
      />
    </div>
  );
}

/**
 * A node's hover-revealed "N running" badge — the de-bloated replacement for
 * the "Terminals" sub-label and its modal (Sidebar chrome section). Injected
 * via `MachineTree`'s `renderNodeExtra` slot, kept out of `MachineTree`
 * itself: Diff/Files-tab callers reuse the same tree for branch/file
 * navigation and have no workspace to count.
 *
 * The new-workspace `+` that used to live here has moved into the node row's
 * single "+" action palette (`NodeActionPalette`, via `MachineTree`'s
 * `onWorkspaceCreated` prop) — a row previously carried this trigger AND the
 * structural Add project/Add branch trigger as two separate plus icons.
 */
export function WorkspaceNodeExtras({
  machineId,
  node,
}: {
  machineId: string;
  node: MachineTreeNode;
}) {
  const scope = nodeScopeOf(node);
  const runningCount = useMachineWorkspaceStore(selectRunningPaneCount(machineId, scope));

  if (runningCount === 0) return null;

  return (
    <span className="rounded bg-muted px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground" title={`${runningCount} running`}>
      {runningCount} running
    </span>
  );
}
