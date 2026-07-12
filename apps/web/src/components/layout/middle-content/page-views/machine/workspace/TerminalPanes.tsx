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
import { useAgentTerminals } from '@/hooks/useAgentTerminals';
import { AGENT_LAUNCH_SPECS, type AgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';
import {
  useMachineWorkspaceStore,
  selectWorkspace,
  selectActiveNode,
  autoSessionName,
  type OpenTerminalScope,
  type TerminalPaneState,
} from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { PaneLoading, PaneNotice } from '../tabs/tab-states';

const XtermTerminal = dynamic(() => import('../XtermTerminal'), { ssr: false });

export type { TerminalPaneState };

const AGENT_TYPES = Object.keys(AGENT_LAUNCH_SPECS) as AgentRuntimeType[];

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

export default function TerminalPanes({ machineId, socket }: TerminalPanesProps) {
  const workspace = useMachineWorkspaceStore(selectWorkspace(machineId));
  // The node whose grid is on screen — machine, project, or branch. Everything
  // a pane here spawns runs at THIS node's scope (a branch node's panes all
  // share that branch's checkout).
  const node = useMachineWorkspaceStore(selectActiveNode(machineId));
  const splitRight = useMachineWorkspaceStore((state) => state.splitRight);
  const splitDown = useMachineWorkspaceStore((state) => state.splitDown);
  const closePane = useMachineWorkspaceStore((state) => state.closePane);
  const selectPane = useMachineWorkspaceStore((state) => state.selectPane);
  const bindPaneTerminal = useMachineWorkspaceStore((state) => state.bindPaneTerminal);
  const clearPanePrompt = useMachineWorkspaceStore((state) => state.clearPanePrompt);
  const dismissPicker = useMachineWorkspaceStore((state) => state.dismissPicker);
  const { addAgentTerminal } = useAgentTerminals(machineId, node.projectName ?? null, node.branchName ?? null);
  const isMobile = useMobile();

  /**
   * Split-and-pick: create the session AND place it, in one act. The session
   * record is a side-effect of picking an agent — auto-named, never prompted
   * for — and the pane it was picked in is bound to it the moment the spawn
   * resolves, so the agent belongs to a pane from the first frame it exists.
   */
  const spawnIntoPane = useCallback(
    async (paneId: string, agentType: AgentRuntimeType, prompt?: string) => {
      const created = await addAgentTerminal(autoSessionName(agentType, freshNameSuffix()), agentType);
      bindPaneTerminal(
        machineId,
        paneId,
        { projectName: node.projectName, branchName: node.branchName, name: created.name },
        prompt,
      );
    },
    [addAgentTerminal, bindPaneTerminal, machineId, node.projectName, node.branchName],
  );

  // Briefly undefined between this component's first render and the
  // mounting MachineWorkspace's ensureWorkspace effect committing.
  if (!workspace) return null;

  const { columns, activePaneId, pendingPickerPaneId } = workspace;
  const panes = columns.flatMap((column) => column.panes);
  const canClose = panes.length > 1;

  /** `activeId` is a parameter rather than read from the closure so the narrow
   * branch's fallback (below) drives the focus accent and the pane strip from the
   * SAME id — otherwise a stale activePaneId would show the visible pane as
   * unfocused while the strip highlighted it. */
  const paneProps = (pane: TerminalPaneState, activeId: string | null) => ({
    socket,
    machineId,
    pane,
    isActive: pane.id === activeId,
    canClose,
    // A split just made this pane, so its picker takes focus — the user asked
    // for a new agent, not for a blank rectangle to go find a control in.
    pickerFocused: pane.id === pendingPickerPaneId,
    onSelect: () => selectPane(machineId, pane.id),
    onSplitRight: () => splitRight(machineId, pane.id),
    onSplitDown: () => splitDown(machineId, pane.id),
    onClose: () => closePane(machineId, pane.id),
    onSpawn: (agentType: AgentRuntimeType, prompt?: string) => spawnIntoPane(pane.id, agentType, prompt),
    onPickerFocused: () => dismissPicker(machineId, pane.id),
    onPromptSent: () => clearPanePrompt(machineId, pane.id),
  });

  // A phone cannot hold a split grid: two columns at 375px give each terminal
  // ~180px, which is narrower than an `ls -l` line and unusable for the agent
  // output this surface exists to show. So on narrow viewports only the ACTIVE
  // pane is VISIBLE, full-bleed, and the split controls are hidden — the store's
  // layout is untouched, so a desktop split is still there and comes back laid
  // out on the next wide render.
  //
  // The inactive panes are HIDDEN, not unmounted. Unmounting an XtermTerminal
  // emits `agent-terminal:disconnect`, which nulls the session's `closedFn` and
  // arms the idle reap — so an agent that finished while its pane was off-screen
  // would lose its final output and exit code, and coming back to that pane would
  // cold-start a fresh PTY instead of showing the completed run.
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
          <PaneStrip panes={panes} activePaneId={activeId} onSelect={(id) => selectPane(machineId, id)} />
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
  isActive,
  canClose,
  canSplit,
  pickerFocused,
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
  isActive: boolean;
  canClose: boolean;
  /** False on narrow viewports, where a split would produce two unusable slivers. */
  canSplit: boolean;
  /** This pane's picker should take focus — it was just made by a split. */
  pickerFocused: boolean;
  onSelect(): void;
  onSplitRight(): void;
  onSplitDown(): void;
  onClose(): void;
  onSpawn(agentType: AgentRuntimeType, prompt?: string): Promise<void>;
  onPickerFocused(): void;
  onPromptSent(): void;
}) {
  const sessionId = pane.scope ? paneSessionId(machineId, pane.scope) : null;
  // With neither a split nor a close to offer (a lone pane on a phone), the
  // control chip has nothing in it — and since it is opacity-100 on touch, an
  // empty bordered box would just sit in the corner forever.
  const hasControls = canSplit || canClose;

  return (
    <div className="group/pane relative flex h-full flex-col" onClick={onSelect}>
      <div className={`absolute inset-x-0 top-0 z-10 h-0.5 ${isActive ? 'bg-primary' : 'bg-transparent'}`} />
      {/* Hover-revealed on a mouse; a touch device has no hover, so the controls
          stay visible there rather than being unreachable. */}
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
        {!pane.scope || !sessionId ? (
          <PaneAgentPicker focused={pickerFocused} onSpawn={onSpawn} onFocused={onPickerFocused} />
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
  onSpawn,
  onFocused,
}: {
  focused: boolean;
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
        <p className="text-xs text-muted-foreground">It runs in this node&apos;s filesystem.</p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2">
        <Select value={agentType} onValueChange={(value) => setAgentType(value as AgentRuntimeType)}>
          <SelectTrigger aria-label="Agent type" className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AGENT_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
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
