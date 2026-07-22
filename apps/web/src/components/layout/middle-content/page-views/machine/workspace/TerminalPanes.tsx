"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import type { Socket } from 'socket.io-client';
import { Bot, TerminalSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import PaneBar, { PaneSplitCloseActions, PaneSessionIdentity, type PaneControlProps } from './PaneBar';
import { useMobile } from '@/hooks/useMobile';
import { useAgentTerminals, killAgentTerminal, type AgentTerminal } from '@/hooks/useAgentTerminals';
import { useSyncedWorkspaceActions } from '@/hooks/useMachineWorkspaceSync';
import {
  PICKABLE_AGENT_TYPES,
  agentSurfaceOf,
  isAgentRuntimeType,
  type AgentRuntimeType,
} from '@pagespace/lib/services/machines/agent-terminal-types';
import {
  useMachineWorkspaceStore,
  selectActiveWorkspace,
  selectMachine,
  autoSessionName,
  panesOf,
  workspacesOf,
  sessionWorkspaceId,
  paneTerminalScope,
  MACHINE_NODE_SCOPE,
  type MachineNodeScope,
  type OpenTerminalScope,
  type TerminalPaneState,
} from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { PaneLoading, PaneNotice } from '../tabs/tab-states';
import { resolvePaneSurface, agentTypeLabelOf } from './pane-surface';

const XtermTerminal = dynamic(() => import('../XtermTerminal'), { ssr: false });
// Split out like XtermTerminal and for the same reason in reverse: the chat
// pane is a whole AI-chat subtree, and a workspace holding only PTY panes
// should not pay to load it.
const MachinePaneChat = dynamic(() => import('./MachinePaneChat'), { ssr: false });

const AGENT_TYPES = PICKABLE_AGENT_TYPES;

interface TerminalPanesProps {
  machineId: string;
  socket: Socket | null | undefined;
}

function paneSessionId(machineId: string, scope: OpenTerminalScope): string {
  return `agent-terminal:${machineId}:${scope.projectName ?? ''}:${scope.branchName ?? ''}:${scope.name}`;
}

/** Spawn is one act, so the session name is minted rather than asked for. */
function freshNameSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** The checkout a workspace's agents run in, named for the picker — the promise
 * the picker makes has to be the scope the spawn actually uses. */
function scopeLabelOf(scope: MachineNodeScope): string {
  if (!scope.projectName) return 'the machine';
  if (!scope.branchName) return scope.projectName;
  return `${scope.projectName} / ${scope.branchName}`;
}

export default function TerminalPanes({ machineId, socket }: TerminalPanesProps) {
  // The middle view IS the active workspace's grid — selecting another workspace
  // swaps this whole component's contents for that item's combination of panes.
  const workspace = useMachineWorkspaceStore(selectActiveWorkspace(machineId));
  // Read alongside the active workspace to tell the two "no grid to draw" cases
  // apart: no machine entry yet (one frame, pre-`ensureMachine`) vs an entry
  // with zero workspaces (the user removed them all — a real, legal state).
  const machine = useMachineWorkspaceStore(selectMachine(machineId));
  // Layout-affecting actions push the resulting workspace state to the server
  // (#2048); selectPane/clearPanePrompt/dismissPicker stay local-only (focus
  // and one-shot UI intent, never synced — see useMachineWorkspaceSync's doc).
  const { splitRight, splitDown, closePane, bindPaneTerminal, createWorkspace } =
    useSyncedWorkspaceActions(machineId);
  const selectPane = useMachineWorkspaceStore((state) => state.selectPane);
  const clearPanePrompt = useMachineWorkspaceStore((state) => state.clearPanePrompt);
  const dismissPicker = useMachineWorkspaceStore((state) => state.dismissPicker);
  const isMobile = useMobile();

  // Hooks run before the early return below, so these read through a workspace
  // that may not exist for one render.
  const workspaceId = workspace?.id ?? '';
  // Every agent spawned here runs in the workspace's node scope — a branch
  // workspace's panes all share that branch's checkout.
  const scope = workspace?.scope ?? MACHINE_NODE_SCOPE;
  // `agentTerminals`/`isLoading` feed the per-pane surface decision
  // (`resolvePaneSurface`): a kind-less pane's surface is resolved from this
  // list, and a chat pane finds its conversation ROW id in it.
  const { agentTerminals, isLoading: agentTerminalsLoading, addAgentTerminal, removeAgentTerminal } = useAgentTerminals(
    machineId,
    scope.projectName ?? null,
    scope.branchName ?? null,
  );

  /**
   * Split-and-pick: create the session AND place it, in one act. The session
   * record is a side-effect of picking an agent — auto-named, never prompted
   * for — and the pane it was picked in is bound to it the moment the spawn
   * resolves, so the agent belongs to a pane from the first frame it exists.
   */
  const spawnIntoPane = useCallback(
    async (paneId: string, agentType: AgentRuntimeType) => {
      const created = await addAgentTerminal(autoSessionName(agentType, freshNameSuffix()), agentType);
      const bound = bindPaneTerminal(
        workspaceId,
        paneId,
        {
          projectName: scope.projectName,
          branchName: scope.branchName,
          name: created.name,
          // The surface decision, recorded at the one moment it is KNOWN
          // rather than re-derived from the SWR list on every future mount.
          // Only `chat` is written — an omitted kind already means `terminal`
          // (see OpenTerminalScope), so PTY bindings stay byte-identical to
          // every binding that predates the tag. Judged by the API's OWN
          // answer, not the picked type: a `resumed` upsert hands back an
          // existing session whose agentType can differ (same reasoning as
          // the resumed-prompt guard below), and a retired type the registry
          // no longer knows falls through to the terminal default.
          ...(isAgentRuntimeType(created.agentType) && agentSurfaceOf(created.agentType) === 'chat'
            ? { kind: 'chat' as const }
            : {}),
        },
        // No starting prompt — instant spawn means the prompt is typed in the
        // pane itself, so there is nothing to auto-send.
        undefined,
      );
      if (!bound && !created.resumed) {
        // The pane went away while the Sprite booted (closed, or the page
        // navigated off). The session row exists but now belongs to nothing and
        // nothing will ever show it — so take it back out rather than leave the
        // user a terminal they never asked for and never saw appear.
        //
        // Only one WE created, though. `removeAgentTerminal` KILLS the terminal,
        // and a `resumed` session is one that already existed — quite possibly
        // open in someone else's pane, with an agent halfway through a task. This
        // spawn did not bring it into the world and must not take it out of it.
        await removeAgentTerminal(created.name).catch(() => {});
      }
    },
    [addAgentTerminal, removeAgentTerminal, bindPaneTerminal, workspaceId, scope.projectName, scope.branchName],
  );

  /**
   * Close means close: the pane goes, and its PTY is killed with it — the same
   * meaning `X` has in every terminal emulator. The alternative (detach, leaving
   * the session running) is what MANUFACTURES orphan rows: a terminal outliving
   * the only view of it becomes an "unclaimed" session in the sidebar, which is
   * the unremovable-listing bug this change exists to kill.
   *
   * Not killed when another pane still binds the same session: `openTerminal`'s
   * doc records that a session can legitimately be shown in two panes at once,
   * and closing one of those must not pull the PTY out from under the other.
   * Read from the store rather than this render's `workspace`, since only the
   * machine-wide state can see panes in the workspaces we aren't rendering.
   *
   * The kill is addressed by the session address RE-DERIVED from the closing
   * pane's own workspace (`paneTerminalScope`), not by this component's
   * workspace-scoped hook: the closing pane can belong to a workspace other
   * than the active one, and a DELETE for a bare name would address the
   * machine root — a different same-named terminal, or nothing — while the one
   * the user closed lives on.
   */
  const closePaneAndKill = useCallback(
    (paneId: string) => {
      const current = useMachineWorkspaceStore.getState().machines[machineId];
      // The closing pane is resolved WITHIN its own workspace — a pane id is
      // only unique within its grid (ids arrive from server layouts other
      // clients minted, so nothing guarantees global uniqueness), and a
      // machine-wide id lookup could match a same-id pane in another
      // workspace and kill that pane's session instead.
      const closingWorkspace = current?.workspaces[workspaceId];
      const closingPaneScope = closingWorkspace
        ? (panesOf(closingWorkspace).find((candidate) => candidate.id === paneId)?.scope ?? null)
        : null;
      // The pane holds a name; its checkout is its workspace's. Joined here,
      // once, and that address is what both the kill and the comparison below
      // speak in.
      const closing =
        closingWorkspace && closingPaneScope ? paneTerminalScope(closingWorkspace.scope, closingPaneScope) : null;

      // Compared by `sessionWorkspaceId` — the session's real identity is the
      // (project, branch, name) triple (that is `machine_agent_terminals`' unique
      // index), not the name alone, which two workspaces at different checkouts
      // could legitimately share. Each candidate pane's identity is therefore
      // re-derived through ITS OWN workspace's scope. "Another pane" is the
      // (workspace, pane) TUPLE, for the same reason the lookup above is
      // workspace-scoped.
      const boundElsewhere =
        closing !== null &&
        current !== undefined &&
        workspacesOf(current).some((candidateWorkspace) =>
          panesOf(candidateWorkspace).some(
            (candidate) =>
              (candidateWorkspace.id !== workspaceId || candidate.id !== paneId) &&
              candidate.scope !== null &&
              sessionWorkspaceId(paneTerminalScope(candidateWorkspace.scope, candidate.scope)) ===
                sessionWorkspaceId(closing),
          ),
        );

      closePane(workspaceId, paneId);
      if (closing !== null && !boundElsewhere) {
        // `killAgentTerminal` drops the session from the SWR cache
        // synchronously (optimistic mutation) — the same tick as `closePane`
        // above — so the sidebar never flashes the closing session as an
        // unclaimed row. On a genuine kill failure the mutation ROLLS the row
        // BACK as the unclaimed fallback (still reachable, still removable,
        // with its own remove button) — but the pane is already gone, so the
        // user must be TOLD the agent is still running (and billing) rather
        // than left to notice the sidebar row: toast instead of throwing into
        // the click handler.
        const closingName = closing.name;
        void killAgentTerminal(machineId, closing).catch(() => {
          toast.error(`Failed to stop ${closingName} — it is still running, listed in the sidebar`);
        });
      }
    },
    [machineId, workspaceId, closePane],
  );

  // Briefly undefined between this component's first render and the mounting
  // MachineWorkspace's ensureMachine effect committing. Distinct from "the
  // machine has no workspaces" below — rendering the empty state here would
  // flash "No terminals open" for one frame on every machine open.
  if (!machine) return null;

  // Zero workspaces is a legal, converged state, not a blank view to be repaired
  // by fabricating one. This empty state is what makes removing the LAST view
  // possible: without something to render here, the old code kept a workspace
  // alive purely so the grid had something to draw.
  if (!workspace) {
    return (
      <PaneNotice
        testId="machine-no-terminals"
        title="No terminals open"
        description="Open a terminal to start working on this machine."
        actionLabel="New Terminal"
        onAction={() => createWorkspace(MACHINE_NODE_SCOPE)}
      />
    );
  }

  const { activePaneId, pendingPickerPaneId, columns } = workspace;
  const scopeLabel = scopeLabelOf(scope);
  const panes = panesOf(workspace);

  /** `activeId` is a parameter rather than read from the closure so the narrow
   * branch's fallback (below) drives the focus accent and the pane strip from the
   * SAME id — otherwise a stale activePaneId would show the visible pane as
   * unfocused while the strip highlighted it. */
  const paneProps = (pane: TerminalPaneState, activeId: string | null) => ({
    socket,
    machineId,
    pane,
    // What the pane's surface decision resolves against — the workspace's own
    // session list (see resolvePaneSurface's doc for the foreign-scope rule).
    workspaceScope: scope,
    agentTerminals,
    agentTerminalsLoading,
    isActive: pane.id === activeId,
    // Every pane closes, always. The old rule (`panes.length > 1 || scope !==
    // null`) existed to stop a lone empty pane being closed, because the
    // workspace had nowhere to go — closing the last pane now removes the
    // workspace itself, so there is no such dead end left to guard.
    canClose: true,
    // A split just made this pane, so its picker takes focus — the user asked
    // for a new agent, not for a blank rectangle to go find a control in.
    pickerFocused: pane.id === pendingPickerPaneId,
    scopeLabel,
    // Every pane action names the WORKSPACE this pane was rendered in. A pane id
    // is only unique within its own grid, and an action can land after the user
    // has switched workspaces (a `ready` event, a spawn resolving from a cold
    // boot) — so the target is captured here, not looked up when the write lands.
    onSelect: () => selectPane(machineId, workspaceId, pane.id),
    onSplitRight: () => splitRight(workspaceId, pane.id),
    onSplitDown: () => splitDown(workspaceId, pane.id),
    onClose: () => closePaneAndKill(pane.id),
    onSpawn: (agentType: AgentRuntimeType) => spawnIntoPane(pane.id, agentType),
    onPickerFocused: () => dismissPicker(machineId, workspaceId, pane.id),
    onPromptSent: () => clearPanePrompt(machineId, workspaceId, pane.id),
  });

  // A phone cannot hold a split grid: two columns at 375px give each terminal
  // ~180px, which is narrower than an `ls -l` line and unusable for the agent
  // output this surface exists to show. So on narrow viewports only the ACTIVE
  // pane is VISIBLE, full-bleed, and the split controls are hidden — the store's
  // layout is untouched, so a desktop split is still there and comes back laid
  // out on the next wide render.
  //
  // The inactive panes are HIDDEN, not unmounted. Unmounting an XtermTerminal
  // emits `agent-terminal:disconnect`, which removes this pane's viewer entry —
  // and when it was the last viewer, arms the idle reap — so an agent that
  // finished while its pane was off-screen would lose its final output and exit
  // code, and coming back to that pane would cold-start a fresh PTY instead of
  // showing the completed run.
  //
  // `invisible` (visibility:hidden), NOT `hidden` (display:none). Every pane here
  // is stacked at inset-0, so a hidden one still has the container's real size —
  // which it must, because a pane can MOUNT while inactive. xterm measures its
  // character cell from the DOM at `open()`, and in a display:none box that
  // measurement is 0; FitAddon then proposes no dimensions, so even the refit on
  // re-show is a no-op and the pane stays blank for good. (The keep-alive path can
  // use display:none safely only because it hides terminals that were already
  // opened at a real size.) visibility:hidden also keeps `offsetParent` and
  // `clientWidth` truthy, which is exactly what XtermTerminal's own visibility
  // gate checks before it fits.
  if (isMobile) {
    if (panes.length === 0) return null;
    // The store always points activePaneId at a live pane; fall back anyway rather
    // than render a workspace where nothing is visible.
    const activeId = panes.some((pane) => pane.id === activePaneId) ? activePaneId : panes[0].id;
    return (
      <div className="flex h-full flex-col bg-background">
        {panes.length > 1 && (
          <PaneStrip panes={panes} activePaneId={activeId} onSelect={(id) => selectPane(machineId, workspaceId, id)} />
        )}
        <div className="relative min-h-0 flex-1">
          {panes.map((pane) => (
            <div
              key={pane.id}
              className={cn('absolute inset-0', pane.id !== activeId && 'invisible')}
              data-testid="mobile-pane"
              data-hidden={pane.id !== activeId ? 'true' : undefined}
            >
              <TerminalPane {...paneProps(pane, activeId)} canSplit={false} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full bg-background">
      <ResizablePanelGroup orientation="horizontal" className="h-full">
        {columns.map((column, columnIndex) => (
          <Fragment key={column.id}>
            {columnIndex > 0 && <ResizableHandle variant="chrome-free" />}
            <ResizablePanel defaultSize={100 / columns.length} minSize={15}>
              <ResizablePanelGroup orientation="vertical" className="h-full">
                {column.panes.map((pane, paneIndex) => (
                  <Fragment key={pane.id}>
                    {paneIndex > 0 && <ResizableHandle variant="chrome-free" />}
                    <ResizablePanel defaultSize={100 / column.panes.length} minSize={15}>
                      <TerminalPane {...paneProps(pane, activePaneId)} canSplit />
                    </ResizablePanel>
                  </Fragment>
                ))}
              </ResizablePanelGroup>
            </ResizablePanel>
          </Fragment>
        ))}
      </ResizablePanelGroup>
    </div>
  );
}

/**
 * The narrow-viewport pane switcher. Only rendered when a split layout already
 * exists (it can only have been made on a wider screen), and it is the ONLY way
 * back to those panes once the grid collapses to one — without it they would be
 * silently unreachable, which is the failure mode this whole branch is meant to
 * avoid.
 */
function PaneStrip({
  panes,
  activePaneId,
  onSelect,
}: {
  panes: TerminalPaneState[];
  activePaneId: string | null;
  onSelect(paneId: string): void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1">
      {panes.map((pane, index) => (
        <Button
          key={pane.id}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onSelect(pane.id)}
          aria-current={pane.id === activePaneId ? 'true' : undefined}
          className={cn(
            'h-6 shrink-0 px-2 text-xs text-muted-foreground',
            pane.id === activePaneId && 'bg-accent text-foreground',
          )}
        >
          {pane.scope?.name ?? `Pane ${index + 1}`}
        </Button>
      ))}
    </div>
  );
}

/**
 * Every pane wears a {@link PaneBar}: identity left (session name + checkout),
 * split/close right, bar tint as the focus state. This retired the chrome-free
 * design's floating control chip and 2px accent line — the chip physically
 * covered the chat surface's own header, hover-reveal needed a coarse-pointer
 * escape hatch, and anonymous panes left "which terminal is showing where"
 * unanswerable. A CHAT pane's bar is rendered by {@link MachinePaneChat}
 * instead (its agent picker and tabs merge into the same bar — one bar per
 * pane, never two), so this component only draws the bar for the surfaces
 * that have no header of their own: PTY, picker, loading, and notice panes.
 */
function TerminalPane({
  socket,
  machineId,
  pane,
  workspaceScope,
  agentTerminals,
  agentTerminalsLoading,
  isActive,
  canClose,
  canSplit,
  pickerFocused,
  scopeLabel,
  onSelect,
  onSplitRight,
  onSplitDown,
  onClose,
  onSpawn,
  onPickerFocused,
  onPromptSent,
}: {
  socket: Socket | null | undefined;
  machineId: string;
  pane: TerminalPaneState;
  /** The checkout `agentTerminals` was fetched at — the workspace's scope. */
  workspaceScope: MachineNodeScope;
  agentTerminals: AgentTerminal[];
  agentTerminalsLoading: boolean;
  isActive: boolean;
  canClose: boolean;
  /** False on narrow viewports, where a split would produce two unusable slivers. */
  canSplit: boolean;
  /** This pane's picker should take focus — it was just made by a split. */
  pickerFocused: boolean;
  /** Where an agent spawned here would run — the workspace's checkout. */
  scopeLabel: string;
  onSelect(): void;
  onSplitRight(): void;
  onSplitDown(): void;
  onClose(): void;
  onSpawn(agentType: AgentRuntimeType): Promise<void>;
  onPickerFocused(): void;
  onPromptSent(): void;
}) {
  // The pane's session address: its workspace's checkout plus its own name.
  const sessionScope = pane.scope ? paneTerminalScope(workspaceScope, pane.scope) : null;
  const sessionId = sessionScope ? paneSessionId(machineId, sessionScope) : null;
  // Which surface this pane renders — decided by the pure helper, never by
  // defaulting: an Xterm mounted for what turns out to be a chat session
  // would open (and register a viewer on) a PTY stream that shouldn't exist.
  const resolved = pane.scope
    ? resolvePaneSurface({ scope: pane.scope, agentTerminals, isLoading: agentTerminalsLoading })
    : null;
  const hasControls = canSplit || canClose;
  const paneControls: PaneControlProps | undefined = hasControls
    ? { canSplit, canClose, onSplitRight, onSplitDown, onClose }
    : undefined;
  // MachinePaneChat draws the pane's ONE bar itself (agent picker + tabs +
  // these same controls, merged) — every other surface gets the bar here.
  const chatMounted = pane.scope !== null && resolved?.surface === 'chat' && resolved.terminalId !== null;

  return (
    <div className="group/pane relative flex h-full flex-col" onClick={onSelect}>
      {!chatMounted && (
        <PaneBar
          isActive={isActive}
          identity={
            pane.scope ? (
              // One checkout per workspace, so the chip reads the workspace's
              // label — the same string the picker promises a spawn will run in.
              <PaneSessionIdentity name={pane.scope.name} scopeLabel={scopeLabel} />
            ) : (
              <span className="truncate">New pane</span>
            )
          }
          actions={paneControls && <PaneSplitCloseActions {...paneControls} />}
        />
      )}
      <div className="relative min-h-0 flex-1">
        {!sessionScope || !sessionId || !resolved ? (
          <PaneAgentPicker
            focused={pickerFocused}
            scopeLabel={scopeLabel}
            onSpawn={onSpawn}
            onFocused={onPickerFocused}
          />
        ) : resolved.surface === 'chat' ? (
          // `terminalId` still null means the list hasn't turned the row up:
          // hold while it's still loading (the one thing a chat-bound pane
          // must never do is mount an Xterm), but a LOADED list without the
          // row means the session was killed — say so rather than spin
          // forever; the close control in the bar stays reachable either way.
          resolved.terminalId === null ? (
            agentTerminalsLoading ? (
              <PaneLoading message="Loading session…" />
            ) : (
              <PaneNotice
                title="This session no longer exists"
                description="It may have been closed elsewhere. Close the pane to remove it."
              />
            )
          ) : (
            <MachinePaneChat
              // Re-keyed per conversation row, same reason TerminalPaneStream
              // keys by sessionId: switching sessions is a remount, not a
              // state handoff.
              key={resolved.terminalId}
              machineId={machineId}
              terminalId={resolved.terminalId}
              pendingPrompt={pane.pendingPrompt}
              onPromptSent={onPromptSent}
              isActive={isActive}
              paneControls={paneControls}
            />
          )
        ) : resolved.surface === 'loading' ? (
          <PaneLoading message="Loading session…" />
        ) : (
          <TerminalPaneStream
            key={sessionId}
            socket={socket}
            machineId={machineId}
            scope={sessionScope}
            sessionId={sessionId}
            pendingPrompt={pane.pendingPrompt}
            onPromptSent={onPromptSent}
          />
        )}
      </div>
    </div>
  );
}

/**
 * An empty pane's inline agent picker — two instant-spawn buttons, in the pane
 * the agent will run in. Click Agent or Shell and the agent is created AND
 * placed here in one action: no modal, no name step, no type dropdown, no
 * prompt form — the prompt is typed in the pane once it opens (same instant
 * grammar as NodeActionPalette's spawn options). The buttons come from
 * `PICKABLE_AGENT_TYPES`, so this stays registry-driven.
 */
function PaneAgentPicker({
  focused,
  scopeLabel,
  onSpawn,
  onFocused,
}: {
  focused: boolean;
  scopeLabel: string;
  onSpawn(agentType: AgentRuntimeType): Promise<void>;
  onFocused(): void;
}) {
  const [spawning, setSpawning] = useState(false);
  const firstChoiceRef = useRef<HTMLButtonElement>(null);

  // Consume the focus intent once. Clearing it in the store (onFocused) is what
  // stops a later unrelated re-render from yanking the focus back here while
  // the user is typing in a sibling pane. Focus lands on the FIRST choice
  // (Agent) — the split asked for a new agent, so Enter spawns the default.
  useEffect(() => {
    if (!focused) return;
    firstChoiceRef.current?.focus();
    onFocused();
  }, [focused, onFocused]);

  const spawn = async (agentType: AgentRuntimeType) => {
    setSpawning(true);
    try {
      // A spawned pane re-renders with a terminal in it, unmounting this picker
      // — so `spawning` is only ever cleared on the failure path.
      await onSpawn(agentType);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to spawn agent');
      setSpawning(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <div className="text-center">
        <p className="text-sm font-medium">Spawn an agent</p>
        <p className="text-xs text-muted-foreground">Runs in {scopeLabel}.</p>
      </div>
      <div className="flex gap-2">
        {AGENT_TYPES.map((type, index) => (
          <Button
            key={type}
            ref={index === 0 ? firstChoiceRef : undefined}
            size="sm"
            variant="outline"
            disabled={spawning}
            onClick={() => void spawn(type)}
            className="gap-2"
          >
            {agentSurfaceOf(type) === 'chat' ? <Bot className="size-3.5" /> : <TerminalSquare className="size-3.5" />}
            {agentTypeLabelOf(type)}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * Keyed by `sessionId` at the call site above — switching which terminal a
 * pane shows fully unmounts/remounts this component, so `connected`/`error`
 * reset to their initial values automatically instead of needing a manual
 * effect (which would otherwise briefly show the PREVIOUS terminal's
 * connected state for one render before an effect could catch up).
 */
function TerminalPaneStream({
  socket,
  machineId,
  scope,
  sessionId,
  pendingPrompt,
  onPromptSent,
}: {
  socket: Socket | null | undefined;
  machineId: string;
  scope: OpenTerminalScope;
  sessionId: string;
  /** The picker's starting prompt, typed into the PTY once it's ready. */
  pendingPrompt?: string;
  onPromptSent(): void;
}) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slow = useElapsed(!connected && error === null, COLD_BOOT_MS);

  const handleReady = useCallback(() => setConnected(true), []);
  const handleError = useCallback((message: string) => setError(message), []);

  return (
    <>
      {socket && (
        <XtermTerminal
          socket={socket}
          sessionId={sessionId}
          connectPayload={{ machineId, projectName: scope.projectName, branchName: scope.branchName, name: scope.name }}
          initialInput={pendingPrompt}
          onInitialInputSent={onPromptSent}
          onReady={handleReady}
          onError={handleError}
        />
      )}
      {!connected && (
        <div className="absolute inset-0 bg-background">
          {error ? (
            <PaneNotice tone="destructive" title={error} />
          ) : (
            // Reattaching to a live PTY answers in well under a second; a COLD
            // Sprite has to boot first, and a bare "Connecting…" that sits there
            // for ten seconds reads as a hang. The socket doesn't tell us which
            // of the two is happening, but the clock does — so say the honest
            // thing only once the fast path has demonstrably not taken.
            <PaneLoading message={slow ? 'Starting the sandbox — a cold boot takes a few seconds…' : 'Connecting…'} />
          )}
        </div>
      )}
    </>
  );
}

/** Past a fast reattach, a connect is a cold boot. */
const COLD_BOOT_MS = 1500;

/** True once `ms` has elapsed with `active` still set. Resets whenever it isn't. */
function useElapsed(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);

  return elapsed;
}
