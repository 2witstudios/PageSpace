"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import type { Socket } from 'socket.io-client';
import { SquareSplitHorizontal, SquareSplitVertical, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useMobile } from '@/hooks/useMobile';
import { useAgentTerminals, killAgentTerminal, type AgentTerminal } from '@/hooks/useAgentTerminals';
import { useSyncedWorkspaceActions } from '@/hooks/useMachineWorkspaceSync';
import { PICKABLE_AGENT_TYPES, agentSurfaceOf, type AgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';
import {
  useMachineWorkspaceStore,
  selectActiveWorkspace,
  selectMachine,
  autoSessionName,
  panesOf,
  workspacesOf,
  sessionWorkspaceId,
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
    async (paneId: string, agentType: AgentRuntimeType, prompt?: string) => {
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
          // every binding that predates the tag.
          ...(agentSurfaceOf(agentType) === 'chat' ? { kind: 'chat' as const } : {}),
        },
        // `spawnAgentTerminal` is an upsert: `resumed` means it handed back a session
        // that ALREADY EXISTED rather than creating one. An agent that was already
        // running must never be typed at, and the API says so right here — relying on
        // the auto-name's entropy to make this unreachable would leave the invariant
        // resting on luck instead of on the answer we were given.
        created.resumed ? undefined : prompt,
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
   * The kill is addressed by the PANE's own scope (`killAgentTerminal`), not
   * through this component's workspace-scoped hook — a pane's checkout can
   * differ from its workspace's, and a DELETE under the workspace scope would
   * target a different same-named terminal (or nothing) while the one the user
   * closed lives on.
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
      const closing = closingWorkspace
        ? (panesOf(closingWorkspace).find((candidate) => candidate.id === paneId)?.scope ?? null)
        : null;

      // Compared by `sessionWorkspaceId` — the session's real identity is the
      // (project, branch, name) triple (that is `machine_agent_terminals`' unique
      // index), not the name alone, which two branches could legitimately share.
      // "Another pane" is the (workspace, pane) TUPLE, for the same reason the
      // lookup above is workspace-scoped.
      const boundElsewhere =
        closing !== null &&
        current !== undefined &&
        workspacesOf(current).some((candidateWorkspace) =>
          panesOf(candidateWorkspace).some(
            (candidate) =>
              (candidateWorkspace.id !== workspaceId || candidate.id !== paneId) &&
              candidate.scope !== null &&
              sessionWorkspaceId(candidate.scope) === sessionWorkspaceId(closing),
          ),
        );

      closePane(workspaceId, paneId);
      if (closing !== null && !boundElsewhere) {
        void killAgentTerminal(machineId, closing).catch(() => {
          // The pane is already gone locally; a failed kill leaves the session
          // discoverable as an unclaimed row (which now carries its own remove
          // button), so this must not throw into the click handler.
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
    onSpawn: (agentType: AgentRuntimeType, prompt?: string) => spawnIntoPane(pane.id, agentType, prompt),
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
 * Chrome-free by design (no per-pane header, ever, verified against
 * PurePoint's real chrome-free pane design) — a top accent bar shows focus
 * and hover-revealed controls handle splitting/closing without permanent
 * chrome. Known tradeoff: with 2+ panes open the Machine tree sidebar does not
 * yet indicate which open terminal is showing in which pane — that's tree
 * sidebar work, out of scope for this theming-foundation round.
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
  onSpawn(agentType: AgentRuntimeType, prompt?: string): Promise<void>;
  onPickerFocused(): void;
  onPromptSent(): void;
}) {
  const sessionId = pane.scope ? paneSessionId(machineId, pane.scope) : null;
  // Which surface this pane renders — decided by the pure helper, never by
  // defaulting: an Xterm mounted for what turns out to be a chat session
  // would open (and register a viewer on) a PTY stream that shouldn't exist.
  const resolved = pane.scope
    ? resolvePaneSurface({ scope: pane.scope, workspaceScope, agentTerminals, isLoading: agentTerminalsLoading })
    : null;
  // With neither a split nor a close to offer (a lone pane on a phone), the
  // control chip has nothing in it — and since it is opacity-100 on touch, an
  // empty bordered box would just sit in the corner forever.
  const hasControls = canSplit || canClose;

  return (
    <div className="group/pane relative flex h-full flex-col" onClick={onSelect}>
      <div className={`absolute inset-x-0 top-0 z-10 h-0.5 ${isActive ? 'bg-primary' : 'bg-transparent'}`} />
      {/* Hover-revealed from `md:` up. On a coarse pointer there is nothing to
          hover with, so the global `[data-pointer='coarse']` rule in globals.css
          keeps this exact opacity-0/group-hover shape visible — the controls must
          not be unreachable on a device that cannot hover. */}
      {hasControls && (
      <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-md border border-border bg-card/90 p-0.5 opacity-100 shadow-sm backdrop-blur-sm transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover/pane:opacity-100">
        {canSplit && (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                onSplitRight();
              }}
              className="size-6 text-muted-foreground hover:text-foreground"
              title="Split right"
            >
              <SquareSplitHorizontal className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                onSplitDown();
              }}
              className="size-6 text-muted-foreground hover:text-foreground"
              title="Split down"
            >
              <SquareSplitVertical className="size-3.5" />
            </Button>
          </>
        )}
        {canClose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="size-6 text-muted-foreground hover:text-destructive"
            title="Close pane"
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>
      )}
      <div className="relative min-h-0 flex-1">
        {!pane.scope || !sessionId || !resolved ? (
          <PaneAgentPicker
            focused={pickerFocused}
            scopeLabel={scopeLabel}
            onSpawn={onSpawn}
            onFocused={onPickerFocused}
          />
        ) : resolved.surface === 'chat' ? (
          // `terminalId` still null means the list hasn't turned the row up
          // yet — hold, exactly like the kind-less loading branch below; the
          // one thing a chat-bound pane must never do is mount an Xterm.
          resolved.terminalId === null ? (
            <PaneLoading message="Loading session…" />
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
            />
          )
        ) : resolved.surface === 'loading' ? (
          <PaneLoading message="Loading session…" />
        ) : (
          <TerminalPaneStream
            key={sessionId}
            socket={socket}
            machineId={machineId}
            scope={pane.scope}
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
 * An empty pane's inline agent picker — the whole spawn flow, in the pane the
 * agent will run in. Pick a type, optionally say what it should start on, and
 * the agent is created AND placed here in one action: no modal, no name step,
 * no separate "now assign it to a pane" click.
 *
 * The starting prompt is optional on purpose — Enter on the type is the fast
 * path (the agent boots to its own prompt), and the textarea is there for when
 * the user already knows the first thing to say.
 */
function PaneAgentPicker({
  focused,
  scopeLabel,
  onSpawn,
  onFocused,
}: {
  focused: boolean;
  scopeLabel: string;
  onSpawn(agentType: AgentRuntimeType, prompt?: string): Promise<void>;
  onFocused(): void;
}) {
  const [agentType, setAgentType] = useState<AgentRuntimeType>(AGENT_TYPES[0]);
  const [prompt, setPrompt] = useState('');
  const [spawning, setSpawning] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Consume the focus intent once. Clearing it in the store (onFocused) is what
  // stops a later unrelated re-render from yanking the caret back here while
  // the user is typing in a sibling pane.
  useEffect(() => {
    if (!focused) return;
    promptRef.current?.focus();
    onFocused();
  }, [focused, onFocused]);

  const submit = async () => {
    setSpawning(true);
    try {
      // A spawned pane re-renders with a terminal in it, unmounting this picker
      // — so `spawning` is only ever cleared on the failure path.
      await onSpawn(agentType, prompt.trim() || undefined);
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
      <div className="flex w-full max-w-xs flex-col gap-2">
        <Select value={agentType} onValueChange={(value) => setAgentType(value as AgentRuntimeType)}>
          <SelectTrigger aria-label="Agent type" className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AGENT_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {agentTypeLabelOf(type)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Textarea
          ref={promptRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Starting prompt (optional)"
          aria-label="Starting prompt"
          rows={2}
          className="resize-none text-sm"
          // Enter submits; Shift+Enter is a newline — the prompt is usually one
          // line, and reaching for the button to spawn would put the click back
          // into a flow whose whole point is not having one.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!spawning) void submit();
            }
          }}
        />
        <Button size="sm" disabled={spawning} onClick={() => void submit()}>
          {spawning ? 'Spawning…' : 'Spawn agent'}
        </Button>
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
