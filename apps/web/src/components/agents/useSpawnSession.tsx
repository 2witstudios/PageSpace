'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Boxes, Plus, SquareTerminal, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { useSWRConfig } from 'swr';

import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { post } from '@/lib/auth/auth-fetch';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import { useDriveEnvs, driveEnvsKey } from '@/hooks/drive-envs/useDriveEnvs';
import { reportDriveEnvWriteFailure } from '@/hooks/drive-envs/drive-env-writes';
import { useDriveStore } from '@/hooks/useDrive';
import { canManageDrive } from '@/hooks/usePermissions';
import type { DriveWithAgents } from '@/hooks/page-agents/usePageAgents';
import { MAX_DRIVE_ENV_NAME_LENGTH, type DriveEnvDTO } from '@pagespace/lib/drive-envs/env-contract';

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
  /**
   * An environment the CALLER already chose, before any target was picked —
   * set only by `openSpawnInEnv` (the sidebar's per-environment "+"). It cannot
   * live on `spawnPick`, which is null until the target step is answered, so it
   * waits here and is merged into the pick the moment one exists. The step
   * machine then reads `envId !== undefined` and skips straight to naming: the
   * row the user clicked already answered "where should it run?".
   */
  const [presetEnvId, setPresetEnvId] = useState<string | null>(null);
  /**
   * Which step asked for a new environment, or null when none did.
   *
   * It is both the "is the create step on screen" flag and the return address:
   * from the target step, creating one returns THERE (the environment now
   * exists and the env step will offer it); from the env step, the newly
   * created environment is the answer to the question that step was asking, so
   * the flow goes straight on to naming with it selected.
   */
  const [newEnvFrom, setNewEnvFrom] = useState<'target' | 'env' | null>(null);

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
    setPresetEnvId(null);
    setNewEnvFrom(null);
  }, []);

  /**
   * The same flow, opened from one ENVIRONMENT's row — its "+" in the sidebar.
   * The row is the answer to "where should it run?", so that step never appears
   * and the user picks a target and names it, exactly as they would in a drive
   * with no environments at all.
   */
  const openSpawnInEnv = useCallback((driveId: string, driveName: string | null, envId: string) => {
    setSpawnTarget({ driveId, driveName });
    setSpawnPick(null);
    setPresetEnvId(envId);
    setNewEnvFrom(null);
  }, []);

  // The Assistant group has nothing to pick (the assistant IS the
  // counterpart), so this skips straight to naming.
  const openAssistantSpawn = useCallback(() => {
    setSpawnTarget({ driveId: null, driveName: null });
    setSpawnPick({ kind: 'assistant', agentPageId: null, label: 'Global Assistant' });
    setPresetEnvId(null);
    setNewEnvFrom(null);
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
  // `isLoading` is consumed, not discarded, and that is load-bearing rather
  // than tidy: `envs` is `[]` BOTH while the listing is in flight and when the
  // drive genuinely has none, so a step decision that reads only `.length`
  // cannot tell "no environments" from "not answered yet". See `step` below.
  const {
    envs: paletteEnvs,
    isLoading: paletteEnvsLoading,
    error: paletteEnvsError,
    mutate: retryPaletteEnvs,
  } = useDriveEnvs(spawnTarget?.driveId ?? null);

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

  /**
   * Whether the requester may create an environment in the targeted drive.
   *
   * Resolved HERE rather than passed in, from the same two facts the sidebar's
   * own environment affordances used before this moved: environment CRUD is
   * drive OWNER/ADMIN, and a drive on its way to deletion is not offered new
   * infrastructure inside it. Computing it in the hook is what lets every
   * caller (the sidebar, the Agents header) get the entry point without
   * threading a permission through. A drive the store does not hold — the
   * driveless Assistant target, an orphan group — resolves to `false`, which is
   * the right answer for both.
   */
  const drives = useDriveStore((state) => state.drives);
  const canCreateEnv = useMemo(() => {
    if (!spawnTarget?.driveId) return false;
    const drive = drives.find((entry) => entry.id === spawnTarget.driveId);
    if (!drive || drive.isTrashed) return false;
    return canManageDrive(drive);
  }, [drives, spawnTarget]);

  const { mutate: globalMutate } = useSWRConfig();

  /**
   * Create an environment from inside the palette, and answer what the palette
   * should do next — `'retry'` on the one refusal retyping fixes (a name
   * already taken), which keeps the step open with the user's text.
   *
   * On success it publishes the new environment into the SHARED environments
   * key, so the sidebar's rows show it without knowing this happened — and so
   * this palette's own next step is reading a listing that contains it.
   */
  const createEnvironment = useCallback(
    async (name: string): Promise<'retry' | 'failed' | { envId: string }> => {
      const driveId = spawnTarget?.driveId;
      if (!driveId) return 'failed';
      let created: { env: DriveEnvDTO };
      try {
        created = await post<{ env: DriveEnvDTO }>(`/api/drives/${encodeURIComponent(driveId)}/envs`, { name });
      } catch (error) {
        // `'retry'` is the one refusal retyping fixes; everything else has been
        // toasted and is `'failed'`.
        return reportDriveEnvWriteFailure(error, 'Could not create the environment') === 'retry' ? 'retry' : 'failed';
      }
      // PUBLISHED, not merely re-asked for. A bare `mutate(key)` is only a
      // revalidation: the cache goes on holding the PREVIOUS listing until the
      // network answers, and `isLoading` stays false throughout because data is
      // already loaded (it flags a first load, not a refresh). So for the whole
      // width of that request the step machine — which decides on `envs.length`
      // and `isLoading` — reads "this drive has no environments" about a drive
      // that just got one, and the two ways that lands are both silent: a quick
      // pick goes straight to naming and spawns EPHEMERALLY into a drive whose
      // environment the user just deliberately made, or the response arrives
      // while they are typing a name and the form is swapped for the env step
      // mid-keystroke. Writing the row in first means the answer is already
      // true when the next render asks; the revalidation behind it only
      // confirms it, and settles the ordering the server sorts by.
      globalMutate(
        driveEnvsKey(driveId),
        (current?: { envs: DriveEnvDTO[] }) => {
          const known = current?.envs ?? [];
          // A revalidation already in flight may have brought it in first.
          return known.some((env) => env.id === created.env.id)
            ? { envs: known }
            : { envs: [...known, created.env] };
        },
        { revalidate: true },
      );
      return { envId: created.env.id };
    },
    [spawnTarget, globalMutate],
  );

  const handleCreateEnv = useCallback(
    async (name: string) => {
      const from = newEnvFrom;
      const result = await createEnvironment(name);
      // Retryable: hold the step, with what the user typed still in it.
      if (result === 'retry') return;
      // Not retryable: hand them back the step they came from rather than
      // stranding them on a form that will refuse the same way again.
      if (result === 'failed') {
        setNewEnvFrom(null);
        return;
      }
      if (from === 'env') {
        // The environment the env step was asking about now exists, and it is
        // the answer: go on to naming with it selected rather than making the
        // user pick the thing they just created.
        setSpawnPick((current) => (current ? { ...current, envId: result.envId } : current));
      } else {
        // From the TARGET step, where a preset may be in play: this flow can
        // have been opened by one environment's "+" in the sidebar, which
        // pre-answered "where should it run?". Making a NEW environment is a
        // newer intent than that row's, and silently spawning into the row's
        // environment anyway would be the palette quietly overruling the thing
        // the user just did. Dropping the preset lets the env step ask once,
        // now with both to choose between.
        setPresetEnvId(null);
      }
      setNewEnvFrom(null);
    },
    [createEnvironment, newEnvFrom],
  );

  const paletteElement = (
    <SpawnSessionPalette
      open={spawnTarget !== null}
      driveName={spawnTarget?.driveName ?? null}
      agents={paletteAgents}
      envs={paletteEnvs}
      envsLoading={paletteEnvsLoading}
      envsError={paletteEnvsError}
      onRetryEnvs={retryPaletteEnvs}
      canRunSandbox={canRunSandbox}
      canCreateEnv={canCreateEnv}
      newEnvFrom={newEnvFrom}
      onStartNewEnv={setNewEnvFrom}
      onCancelNewEnv={() => setNewEnvFrom(null)}
      onCreateEnv={handleCreateEnv}
      pick={spawnPick}
      spawning={spawning}
      onOpenChange={(open) => {
        if (open) return;
        setSpawnTarget(null);
        setSpawnPick(null);
        setPresetEnvId(null);
        setNewEnvFrom(null);
      }}
      onPickTarget={(pick) => setSpawnPick({ ...pick, ...(presetEnvId !== null && { envId: presetEnvId }) })}
      onPickEnv={(envId) => setSpawnPick((current) => (current ? { ...current, envId } : current))}
      onSubmitName={handleSubmitName}
    />
  );

  return { openSpawn, openSpawnInEnv, openAssistantSpawn, spawning, paletteElement };
}

/**
 * The spawn palette for a new session, Raycast-style: search or arrow-key to
 * a target and hit Enter — the same keyboard-first pattern `QuickCreatePalette`
 * established for page creation, reused here so a future mouseless-navigation
 * pass has one command-palette idiom to build on, not two. Pick a target (an
 * agent, Shell, or Global Assistant — `openAssistantSpawn` skips straight past
 * this since it has nothing else to choose), say where it runs when the drive
 * has environments, then name the session. Naming is always the last step, even
 * for a one-click assistant spawn, so every session gets a deliberate name.
 *
 * CREATING an environment is here too, on both of the steps that talk about
 * them, and that is the whole reason it stopped being an icon button in the
 * sidebar: the selector that offers environments as somewhere to run is the
 * selector that should offer making one. From the target step it is reachable
 * even in a drive with none (where the env step never renders at all); from the
 * env step the environment just created becomes the answer to the question that
 * step was asking.
 */
function SpawnSessionPalette({
  open,
  driveName,
  agents,
  envs,
  envsLoading,
  envsError,
  onRetryEnvs,
  canRunSandbox,
  canCreateEnv,
  newEnvFrom,
  onStartNewEnv,
  onCancelNewEnv,
  onCreateEnv,
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
   *
   * Always read together with `envsLoading`: an empty array on its own does not
   * mean "this drive has none".
   */
  envs: DriveEnvDTO[];
  /**
   * Whether that listing is still in flight. The step machine WAITS on this
   * rather than treating a not-yet-arrived listing as an answer — see `step`.
   */
  envsLoading: boolean;
  /**
   * Whether that listing FAILED. The third fact `[]` collapses, and the one
   * that survives after `envsLoading` goes false — so it needs its own step
   * for the same reason loading did.
   */
  envsError: unknown;
  onRetryEnvs: () => void;
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
  /** Whether to offer creating one at all — drive OWNER/ADMIN, on a live drive. */
  canCreateEnv: boolean;
  /**
   * Which step asked to create an environment, or null when none did. Doubles
   * as the create step's on-screen flag and its return address.
   */
  newEnvFrom: 'target' | 'env' | null;
  onStartNewEnv: (from: 'target' | 'env') => void;
  onCancelNewEnv: () => void;
  onCreateEnv: (name: string) => Promise<void>;
  pick: SpawnPick | null;
  spawning: boolean;
  onOpenChange: (open: boolean) => void;
  onPickTarget: (pick: SpawnPick) => void;
  /** `null` is the ephemeral default — a real answer, not a cleared one. */
  onPickEnv: (envId: string | null) => void;
  onSubmitName: (name: string) => void;
}) {
  const [name, setName] = useState('');
  // The environment's name, kept apart from the session's: the create step can
  // be refused (a name already taken) and hold its text while the session name
  // below is still blank, and neither must ever prefill the other.
  const [envName, setEnvName] = useState('');
  const [creatingEnv, setCreatingEnv] = useState(false);

  // Blank by default every time a new naming step starts — a stale typed
  // value from resolving one spawn must never prefill the next.
  useEffect(() => {
    if (open) setName('');
  }, [open, pick]);

  // Cleared when the create step OPENS, not when it closes: a 409 keeps the
  // step open with what the user typed, so only a fresh opening may blank it.
  useEffect(() => {
    if (newEnvFrom !== null) setEnvName('');
  }, [newEnvFrom]);

  // WHICH OF THE FOUR STEPS IS ON SCREEN, decided in one place rather than by
  // ternaries that could disagree. The environment step exists only when there
  // is something to choose between: no environments in the drive means
  // `pick.envId` is never asked for and the flow is the original two steps.
  //
  // `'pending'` is the step that stops a race, and it is not cosmetic. The
  // listing is `[]` while it is still in flight, so a step machine reading only
  // `envs.length` treats "not answered yet" as "this drive has none" — and the
  // two failure modes that follows are both silent. A fast pick lands straight
  // on the name step and spawns with `envId: null`, quietly ephemeral in a
  // drive that HAS environments; or the listing arrives while the user is
  // already typing a name, the step recomputes to `'env'`, and the name form is
  // replaced mid-keystroke (with `setName('')` wiping what they wrote). Both
  // are likeliest from a cold cache — opening the palette from a header that
  // never rendered the sidebar's environment rows and so never warmed the key.
  //
  // Waiting is therefore the only honest answer while the question is open. It
  // costs a beat exactly once per drive, and never once the SWR key is warm.
  //
  // `'error'` is the same argument one step further. A FAILED listing also
  // leaves `envs` at `[]`, and unlike loading it never resolves on its own —
  // so without its own step the palette would sail past a question it could
  // not ask and spawn ephemerally into a drive whose environments it simply
  // failed to read. That is the silent-wrong-answer case again, just reached
  // by a different route.
  //
  // `'new-env'` PRE-EMPTS all of them, because it is a question asked ON TOP of
  // whichever step asked it — the target step and the env step both open it,
  // and `newEnvFrom` is what each of them returns to.
  const step: 'target' | 'pending' | 'error' | 'env' | 'name' | 'new-env' =
    newEnvFrom !== null
      ? 'new-env'
      : pick === null
        ? 'target'
        : pick.envId !== undefined
          ? 'name'
          : envsLoading
            ? 'pending'
            : envsError != null
              ? 'error'
              : envs.length > 0
                ? 'env'
                : 'name';
  const chosenEnv = pick?.envId ? (envs.find((env) => env.id === pick.envId) ?? null) : null;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        step === 'new-env'
          ? 'New environment'
          : step === 'target'
            ? 'New session'
            : step === 'env' || step === 'pending' || step === 'error'
              ? 'Where should it run?'
              : 'Name your session'
      }
      description={
        step === 'new-env'
          ? `A persistent machine ${driveName ? `${driveName}'s` : 'this drive’s'} sessions can run inside, sharing one filesystem that survives every session that ends. Name it for what it is for — “dev”, “staging”, “data-import”.`
        : step === 'name'
          ? chosenEnv
            ? `In ${chosenEnv.name} · leave blank to use "${pick?.label ?? 'this session'}"`
            : `Leave blank to use "${pick?.label ?? 'this session'}"`
          : step === 'pending'
            ? 'Checking this drive for environments…'
            : step === 'error'
              ? 'This drive’s environments could not be loaded.'
            : step === 'env'
              ? 'A session in an environment shares that environment’s files, and they stay there when the session ends.'
              : driveName
                ? `Choose an agent to start a session with in ${driveName}`
                : 'Choose an agent to start a session with'
      }
      showCloseButton={false}
      className="max-w-[420px]"
    >
      {step === 'new-env' ? (
        /* The create form lives IN the palette rather than in a dialog over it:
           this is one continuous keyboard flow, and a second Radix layer would
           put two focus traps on screen at once. Cancel returns to whichever
           step asked. */
        <form
          className="space-y-3 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = envName.trim();
            if (!trimmed || creatingEnv) return;
            setCreatingEnv(true);
            void onCreateEnv(trimmed).finally(() => setCreatingEnv(false));
          }}
        >
          <input
            autoFocus
            aria-label="Environment name"
            value={envName}
            onChange={(event) => setEnvName(event.target.value)}
            maxLength={MAX_DRIVE_ENV_NAME_LENGTH}
            placeholder="dev"
            disabled={creatingEnv}
            className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              disabled={creatingEnv || envName.trim().length === 0}
            >
              {creatingEnv ? 'Creating…' : 'Create environment'}
            </button>
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              onClick={onCancelNewEnv}
              disabled={creatingEnv}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : step === 'pending' ? (
        /* Deliberately inert — no input to focus and nothing selectable. The
           question ("where should it run?") is already on screen; only its
           options are missing, so this holds the user's place rather than
           showing them a form that is about to be replaced. */
        <div className="p-4 text-sm text-muted-foreground" role="status">
          Looking for environments in this drive…
        </div>
      ) : step === 'error' ? (
        /* Not a hard block. The user came here to start a session and may
           genuinely want an ephemeral one — but that has to be a CHOICE they
           make knowing the environment list is missing, not a default they
           fall into because a request failed. Retry first, escape hatch
           second, both spelled out. */
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            We could not check which environments this drive has. Try again, or start a session in a
            new sandbox of its own.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent"
              onClick={onRetryEnvs}
              disabled={spawning}
            >
              Try again
            </button>
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              onClick={() => onPickEnv(null)}
              disabled={spawning}
            >
              Use a new sandbox
            </button>
          </div>
        </div>
      ) : step === 'env' ? (
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
            {/* Creating one is an answer to the question this step is asking —
                the new environment becomes the pick and the flow goes on to
                naming. Only shown to someone who may create one; a member sees
                the environments they can use and nothing they cannot do. */}
            {canCreateEnv && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="new-environment-New environment"
                    disabled={spawning}
                    onSelect={() => onStartNewEnv('env')}
                  >
                    <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate">New environment…</span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
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
            {/* Its own group, below a separator, because it does not belong to
                the list above it: everything there is something to start a
                session WITH, and this is infrastructure to start sessions IN.
                It replaced an icon button in the sidebar — a named row in the
                selector that already offers environments is where the act
                belongs, and it is reachable here even in a drive that has none
                (where the env step never appears). */}
            {canCreateEnv && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="new-environment-New environment"
                    disabled={spawning}
                    onSelect={() => onStartNewEnv('target')}
                  >
                    <Boxes className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate">New environment</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">Setup</span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </>
      )}
    </CommandDialog>
  );
}
