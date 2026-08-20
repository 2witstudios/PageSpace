'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Boxes, SquareTerminal, Zap } from 'lucide-react';
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
import { useDriveEnvs } from '@/hooks/drive-envs/useDriveEnvs';
import type { DriveWithAgents } from '@/hooks/page-agents/usePageAgents';
import type { DriveEnvDTO } from '@pagespace/lib/drive-envs/env-contract';

export type SpawnKind = 'agent' | 'shell' | 'assistant';

/** What the palette's first step picked — drives the naming step's placeholder and spawn() call. */
export interface SpawnPick {
  kind: SpawnKind;
  agentPageId: string | null;
  /** The sensible default: the agent's title, "Shell", or "Global Assistant". */
  label: string;
  /**
   * WHERE the session runs, in three states rather than two.
   *
   * `undefined` = not chosen yet, which is what makes the environment step
   * appear; `null` = the ephemeral default (the session owns its own sandbox,
   * gone when it ends); a string = the drive environment it runs INSIDE,
   * sharing that environment's persistent filesystem with every other session
   * in it. The `undefined`/`null` split is load-bearing: "ephemeral" is a real
   * choice a user makes, not the absence of one, so it cannot be the same value
   * as "has not answered yet".
   *
   * A drive with no environments never shows the step, and the pick goes
   * straight to naming with this left unset — the flow is byte-for-byte what it
   * was before environments existed.
   */
  envId?: string | null;
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
    async (input: { driveId: string | null; envId: string | null; agentPageId: string | null; kind: SpawnKind; name: string }) => {
      if (spawning) return;
      setSpawning(true);
      try {
        if (input.kind === 'shell') {
          const created = await post<{ session: { workspaceId: string }; shellId: string; shellName: string }>(
            '/api/agent-workspaces',
            { driveId: input.driveId, envId: input.envId, firstThing: 'shell', name: input.name },
          );
          setSpawnTarget(null);
          setSpawnPick(null);
          onSpawned?.();
          // useAgentSurfaceStore has no shell concept — land by selecting the
          // session there, then placing the node directly on the workspace
          // store. The shell's NAME is no longer passed: a node holds an id and
          // nothing else, and the title is resolved per viewer beside the tree
          // (`targets[]`), so the pane header and the sidebar row now read the
          // same authorized answer instead of two independently-carried copies.
          selectSession(created.session.workspaceId);
          useAgentWorkspaceStore.getState().openShell(created.session.workspaceId, created.shellId);
          return;
        }
        const created = await post<{ session: { workspaceId: string }; conversationId: string }>(
          '/api/agent-workspaces',
          { driveId: input.driveId, envId: input.envId, agentPageId: input.agentPageId, name: input.name },
        );
        setSpawnTarget(null);
        setSpawnPick(null);
        onSpawned?.();
        // Land the user IN the new session's first conversation — no empty
        // state is ever visible.
        selectConversation({
          sessionId: created.session.workspaceId,
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
      void spawn({
        driveId: spawnTarget.driveId,
        // `undefined` (the step was skipped because the drive has none) and
        // `null` (the user chose ephemeral) mean the same thing to the server.
        envId: spawnPick.envId ?? null,
        agentPageId: spawnPick.agentPageId,
        kind: spawnPick.kind,
        name,
      });
    },
    [spawn, spawnTarget, spawnPick],
  );

  // The targeted drive's environments — ONE fetch, keyed on whichever drive the
  // palette is currently open for, and none at all while it is closed or the
  // target is the global assistant (which lives outside any drive and so has no
  // environments to offer). Shares its SWR key with the sidebar's environment
  // rows, so an environment created there is offered here without a second
  // request.
  const { envs: paletteEnvs } = useDriveEnvs(spawnTarget?.driveId ?? null);

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
      envs={paletteEnvs}
      canRunSandbox={canRunSandbox}
      pick={spawnPick}
      spawning={spawning}
      onOpenChange={(open) => {
        if (open) return;
        setSpawnTarget(null);
        setSpawnPick(null);
      }}
      onPickTarget={setSpawnPick}
      onPickEnv={(envId) => setSpawnPick((current) => (current ? { ...current, envId } : current))}
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
  envs,
  canRunSandbox,
  pick,
  spawning,
  onOpenChange,
  onPickTarget,
  onPickEnv,
  onSubmitName,
}: {
  open: boolean;
  driveName: string | null;
  agents: DriveWithAgents['agents'];
  /**
   * The drive's environments. EMPTY IS THE COMMON CASE and it removes the step
   * entirely — a drive that has never made one never sees a question about it.
   */
  envs: DriveEnvDTO[];
  /**
   * Whether the requester can actually run this drive's sandbox (the
   * actor-aware server verdict: kill switch + the payer's tier + the
   * requester's drive edit access). Unlike the in-session PanePicker's Shell
   * button, this item stays keyboard-navigable and selectable when
   * ineligible (cmdk's `disabled` removes an item from roving keyboard focus
   * entirely, which would make a hover-only tooltip unreachable by keyboard)
   * — instead it shows a persistent "Unavailable" label and redirects the
   * pick to a capability-neutral message rather than advancing to the
   * naming step.
   */
  canRunSandbox: boolean;
  pick: SpawnPick | null;
  spawning: boolean;
  onOpenChange: (open: boolean) => void;
  onPickTarget: (pick: SpawnPick) => void;
  /** `null` is the ephemeral default — a real answer, not a cleared one. */
  onPickEnv: (envId: string | null) => void;
  onSubmitName: (name: string) => void;
}) {
  const [name, setName] = useState('');

  // Blank by default every time a new naming step starts — a stale typed
  // value from resolving one spawn must never prefill the next.
  useEffect(() => {
    if (open) setName('');
  }, [open, pick]);

  // WHICH OF THE THREE STEPS IS ON SCREEN, decided in one place rather than by
  // three ternaries that could disagree. The environment step exists only when
  // there is something to choose between: no environments in the drive means
  // `pick.envId` is never asked for and the flow is the original two steps.
  const step: 'target' | 'env' | 'name' =
    pick === null ? 'target' : pick.envId === undefined && envs.length > 0 ? 'env' : 'name';
  const chosenEnv = pick?.envId ? (envs.find((env) => env.id === pick.envId) ?? null) : null;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={step === 'target' ? 'New session' : step === 'env' ? 'Where should it run?' : 'Name your session'}
      description={
        step === 'name'
          ? chosenEnv
            ? `In ${chosenEnv.name} · leave blank to use "${pick?.label ?? 'this session'}"`
            : `Leave blank to use "${pick?.label ?? 'this session'}"`
          : step === 'env'
            ? 'A session in an environment shares that environment’s files, and they stay there when the session ends.'
            : driveName
              ? `Choose an agent to start a session with in ${driveName}`
              : 'Choose an agent to start a session with'
      }
      showCloseButton={false}
      className="max-w-[420px]"
    >
      {step === 'env' ? (
        <>
          <CommandInput placeholder="Search environments…" autoFocus />
          <CommandList>
            <CommandGroup>
              {/* The ephemeral default leads, because it is what every session
                  was before environments existed and what most still should be. */}
              <CommandItem
                value="ephemeral-New sandbox"
                disabled={spawning}
                onSelect={() => onPickEnv(null)}
              >
                <Zap className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">New sandbox</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">Ephemeral</span>
              </CommandItem>
              {envs.map((env) => (
                <CommandItem
                  key={env.id}
                  value={`${env.id}-in ${env.name}`}
                  disabled={spawning}
                  onSelect={() => onPickEnv(env.id)}
                >
                  <Boxes className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">in {env.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </>
      ) : step === 'name' ? (
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
            placeholder={pick?.label ?? 'Session'}
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
                    // Capability-neutral: `canRunSandbox` folds several denial
                    // causes (payer tier, the requester's drive role, the
                    // deployment kill switch) into one boolean, and "upgrade
                    // to Pro" is wrong advice for all but the tier case
                    // (codex round 9, same class as the PanePicker tooltip).
                    toast.error('Sandbox terminals aren\'t available here', {
                      description: 'They need a Pro-plan workspace with edit access.',
                    });
                    return;
                  }
                  onPickTarget({ kind: 'shell', agentPageId: null, label: 'Shell' });
                }}
              >
                <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">Shell</span>
                {!canRunSandbox && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">Unavailable</span>
                )}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </>
      )}
    </CommandDialog>
  );
}
