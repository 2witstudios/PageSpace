'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, SquareTerminal } from 'lucide-react';
import { toast } from 'sonner';

import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { post } from '@/lib/auth/auth-fetch';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import type { DriveWithAgents } from '@/hooks/page-agents/usePageAgents';

export type SpawnKind = 'agent' | 'shell' | 'assistant';

/** What the palette's first step picked — drives the naming step's placeholder and spawn() call. */
export interface SpawnPick {
  kind: SpawnKind;
  agentPageId: string | null;
  /** The sensible default: the agent's title, "Shell", or "Global Assistant". */
  label: string;
}

/**
 * The session-spawn flow, shared by every place that starts a new agent
 * session: the sidebar's search-header "+", each drive group's inline "+",
 * and the Agents surface's own "New session" header CTA. Owns the two-step
 * palette (pick a target, then name it) and the POST itself, so none of its
 * callers duplicate the naming/landing/error-toast details.
 *
 * Takes the caller's own `agentsByDrive` (from `usePageAgents`) rather than
 * fetching it internally — callers that already have one (the sidebar) don't
 * pay for a second, differently-scoped fetch, and callers that don't (the
 * header) fetch their own and pass it in.
 *
 * `onSpawned` is for callers that hold their own cache of sessions (the
 * sidebar's `onChanged`) — it fires right before landing in the new session,
 * same timing the sidebar's inline version used.
 */
export function useSpawnSession(agentsByDrive: DriveWithAgents[], onSpawned?: () => void) {
  const selectConversation = useAgentSurfaceStore((state) => state.selectConversation);
  const selectSession = useAgentSurfaceStore((state) => state.selectSession);

  const [spawnTarget, setSpawnTarget] = useState<{ driveId: string | null; driveName: string | null } | null>(null);
  // Set once a target (agent/shell/assistant) is picked in the palette's first
  // step — its presence is what swaps the dialog to the naming step. Null
  // driveId + kind 'assistant' is the only shape `openAssistantSpawn` ever
  // produces (it skips the picker entirely).
  const [spawnPick, setSpawnPick] = useState<SpawnPick | null>(null);
  const [spawning, setSpawning] = useState(false);

  const spawn = useCallback(
    async (input: { driveId: string | null; agentPageId: string | null; kind: SpawnKind; name: string }) => {
      if (spawning) return;
      setSpawning(true);
      try {
        if (input.kind === 'shell') {
          const created = await post<{ session: { sessionId: string }; shellId: string; shellName: string }>(
            '/api/agent-sessions',
            { driveId: input.driveId, firstThing: 'shell', name: input.name },
          );
          setSpawnTarget(null);
          setSpawnPick(null);
          onSpawned?.();
          // useAgentSurfaceStore has no shell concept — land by selecting the
          // session there, then placing the pane directly on the workspace
          // store, mirroring AgentPanes.tsx's handleReattachShell. The shell
          // is named independently server-side (spawnShell, no name passed) —
          // use its own name, not the session label, so the pane title
          // matches the shell row shown in the sidebar.
          selectSession(created.session.sessionId);
          useAgentWorkspaceStore.getState().openConversation(created.session.sessionId, {
            kind: 'terminal',
            name: created.shellName,
            targetId: created.shellId,
            agentPageId: null,
          });
          return;
        }
        const created = await post<{ session: { sessionId: string }; conversationId: string }>(
          '/api/agent-sessions',
          { driveId: input.driveId, agentPageId: input.agentPageId, name: input.name },
        );
        setSpawnTarget(null);
        setSpawnPick(null);
        onSpawned?.();
        // Land the user IN the new session's first conversation — no empty
        // state is ever visible.
        selectConversation({
          sessionId: created.session.sessionId,
          conversationId: created.conversationId,
          agentId: input.agentPageId,
        });
      } catch (error) {
        console.error('Failed to start a session:', error);
        toast.error('Could not start a session', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
      } finally {
        setSpawning(false);
      }
    },
    [spawning, onSpawned, selectConversation, selectSession],
  );

  // A drive group's "+" opens the picker first so the naming step's
  // placeholder can reflect whichever agent/shell was chosen.
  const openSpawn = useCallback((driveId: string, driveName: string | null) => {
    setSpawnTarget({ driveId, driveName });
    setSpawnPick(null);
  }, []);

  // The Assistant group has nothing to pick (the assistant IS the
  // counterpart), so this skips straight to naming.
  const openAssistantSpawn = useCallback(() => {
    setSpawnTarget({ driveId: null, driveName: null });
    setSpawnPick({ kind: 'assistant', agentPageId: null, label: 'Global Assistant' });
  }, []);

  const handleSubmitName = useCallback(
    (name: string) => {
      if (!spawnTarget || !spawnPick) return;
      void spawn({ driveId: spawnTarget.driveId, agentPageId: spawnPick.agentPageId, kind: spawnPick.kind, name });
    },
    [spawn, spawnTarget, spawnPick],
  );

  const paletteAgents = useMemo(
    () => (spawnTarget ? (agentsByDrive.find((entry) => entry.driveId === spawnTarget.driveId)?.agents ?? []) : []),
    [agentsByDrive, spawnTarget],
  );

  // Server-resolved per-drive: the drive OWNER's tier, not the requester's —
  // same rule the in-session PanePicker's `canRunSandbox` follows. Defaults
  // true while the drive group hasn't resolved yet (rides the same
  // `usePageAgents` fetch as `paletteAgents`), so the picker doesn't flash
  // disabled before that data loads.
  const canRunSandbox = useMemo(
    () => (spawnTarget ? (agentsByDrive.find((entry) => entry.driveId === spawnTarget.driveId)?.sandboxEligible ?? true) : true),
    [agentsByDrive, spawnTarget],
  );

  const paletteElement = (
    <SpawnSessionPalette
      open={spawnTarget !== null}
      driveName={spawnTarget?.driveName ?? null}
      agents={paletteAgents}
      canRunSandbox={canRunSandbox}
      pick={spawnPick}
      spawning={spawning}
      onOpenChange={(open) => {
        if (open) return;
        setSpawnTarget(null);
        setSpawnPick(null);
      }}
      onPickTarget={setSpawnPick}
      onSubmitName={handleSubmitName}
    />
  );

  return { openSpawn, openAssistantSpawn, spawning, paletteElement };
}

/**
 * The spawn palette for a new session, Raycast-style: search or arrow-key to
 * a target and hit Enter — the same keyboard-first pattern `QuickCreatePalette`
 * established for page creation, reused here so a future mouseless-navigation
 * pass has one command-palette idiom to build on, not two. Two steps: pick a
 * target (an agent, Shell, or Global Assistant — `openAssistantSpawn` skips
 * straight here since it has nothing else to choose), then name the session.
 * Naming is always the last step, even for a one-click assistant spawn, so
 * every session gets a deliberate name.
 */
function SpawnSessionPalette({
  open,
  driveName,
  agents,
  canRunSandbox,
  pick,
  spawning,
  onOpenChange,
  onPickTarget,
  onSubmitName,
}: {
  open: boolean;
  driveName: string | null;
  agents: DriveWithAgents['agents'];
  /**
   * Whether this drive's owner (the payer) is on a tier that includes the
   * sandbox. Unlike the in-session PanePicker's Shell button, this item
   * stays keyboard-navigable and selectable when ineligible (cmdk's
   * `disabled` removes an item from roving keyboard focus entirely, which
   * would make a hover-only tooltip unreachable by keyboard) — instead it
   * shows a persistent "Upgrade to Pro" label and redirects the pick to an
   * upgrade message rather than advancing to the naming step.
   */
  canRunSandbox: boolean;
  pick: SpawnPick | null;
  spawning: boolean;
  onOpenChange: (open: boolean) => void;
  onPickTarget: (pick: SpawnPick) => void;
  onSubmitName: (name: string) => void;
}) {
  const [name, setName] = useState('');

  // Blank by default every time a new naming step starts — a stale typed
  // value from resolving one spawn must never prefill the next.
  useEffect(() => {
    if (open) setName('');
  }, [open, pick]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={pick ? 'Name your session' : 'New session'}
      description={
        pick
          ? `Leave blank to use "${pick.label}"`
          : driveName
            ? `Choose an agent to start a session with in ${driveName}`
            : 'Choose an agent to start a session with'
      }
      showCloseButton={false}
      className="max-w-[420px]"
    >
      {pick ? (
        <form
          className="p-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitName(name);
          }}
        >
          <input
            autoFocus
            aria-label="Session name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              onSubmitName(name);
            }}
            placeholder={pick.label}
            disabled={spawning}
            className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          />
        </form>
      ) : (
        <>
          <CommandInput placeholder="Search agents…" autoFocus />
          <CommandList>
            <CommandGroup>
              <CommandItem
                value="assistant-Global Assistant"
                disabled={spawning}
                onSelect={() => onPickTarget({ kind: 'assistant', agentPageId: null, label: 'Global Assistant' })}
              >
                <Bot className="size-3.5" aria-hidden="true" />
                <span className="truncate">Global Assistant</span>
              </CommandItem>
              {agents.map((agent) => (
                <CommandItem
                  key={agent.id}
                  value={`${agent.id}-${agent.title ?? 'Agent'}`}
                  disabled={spawning}
                  onSelect={() => onPickTarget({ kind: 'agent', agentPageId: agent.id, label: agent.title ?? 'Agent' })}
                >
                  <Bot className="size-3.5" aria-hidden="true" />
                  <span className="truncate">{agent.title ?? 'Agent'}</span>
                </CommandItem>
              ))}
              <CommandItem
                value="shell-Shell"
                disabled={spawning}
                onSelect={() => {
                  if (!canRunSandbox) {
                    toast.error('Upgrade to Pro to run a sandbox terminal', {
                      description: 'This drive is on a plan that does not include the sandbox.',
                    });
                    return;
                  }
                  onPickTarget({ kind: 'shell', agentPageId: null, label: 'Shell' });
                }}
              >
                <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">Shell</span>
                {!canRunSandbox && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">Upgrade to Pro</span>
                )}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </>
      )}
    </CommandDialog>
  );
}
