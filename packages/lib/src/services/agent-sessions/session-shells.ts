/**
 * Session shells: spawn / resolve / kill / list the named PTYs inside a
 * session's ONE shared sandbox (IO, dependency-injected).
 *
 * The gutted successor to the terminal half of
 * `services/machines/agent-terminals.ts`. Everything that made that module 1075
 * lines was scope: three tiers to dispatch between, a shared-Sprite fallback, a
 * promotion trigger, a stranded-live-session probe, a `(scope, name)` reservation
 * with its own uniqueness race, and a by-name resolve/kill pair kept beside the
 * by-id one. None of it survives, because a shell has exactly one address (its
 * id) and exactly one place to run (its session's sandbox, at `$HOME`).
 *
 * **Spawning reserves the ROW ONLY.** No Sprite is provisioned and no PTY is
 * opened: the realtime bridge creates the PTY lazily on first connect, and
 * persists the discovered Sprite exec-session id back so a reconnect reattaches
 * instead of spawning a duplicate process. A shell row is therefore cheap and
 * inert until someone actually looks at it.
 *
 * Naming and kill-target policy come from `plan-spawn-session.ts` (pure); this
 * module executes those verdicts.
 */

import type { SandboxHost } from '../sandbox/sandbox-host';
import { SANDBOX_ROOT } from '../sandbox/sandbox-paths';
import { planSpawnShell, planKillTarget } from '../../agent-sessions/plan-spawn-session';
import type { ShellAgentType, ShellDTO } from '../../agent-sessions/contract';
import { isShellAgentType, isValidShellCommand } from './shell-types';
import {
  isUniqueViolation,
  type SessionShellRecord,
  type SessionShellStore,
} from './session-shells-store';

/** The default (and, today, only) PTY type — see `shell-types.ts`. */
const DEFAULT_SHELL_AGENT_TYPE: ShellAgentType = 'shell';

/** Project a stored row onto the wire DTO (pure). `Date` never crosses the boundary. */
export function toShellDTO(row: SessionShellRecord): ShellDTO {
  return {
    shellId: row.id,
    sessionId: row.sessionId,
    ownerId: row.ownerId,
    name: row.name,
    // A row written by an older/looser path could carry an unrecognized type;
    // it is reported as the default rather than crashing a whole listing, and
    // the launch path (`resolveShellLaunchSpec`) still refuses to launch one.
    agentType: isShellAgentType(row.agentType) ? row.agentType : DEFAULT_SHELL_AGENT_TYPE,
    command: row.command,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface SpawnSessionShellDeps {
  store: Pick<SessionShellStore, 'list' | 'create'>;
  now: () => Date;
}

export type SpawnSessionShellResult =
  | { ok: true; shell: ShellDTO }
  | { ok: false; reason: 'invalid_name' | 'name_taken' | 'invalid_agent_type' | 'invalid_command' | 'error' };

/**
 * Reserve a shell row in a session.
 *
 * `name` is optional because opening a shell is ONE act, not a naming step: an
 * absent name gets the `shell-N` auto-label from `planSpawnShell`, which counts
 * the existing shells and scans past collisions so it cannot trip the
 * `(sessionId, name)` unique index. A REQUESTED duplicate is rejected rather
 * than silently renamed — the caller asked for a specific tab label.
 */
export async function spawnSessionShell({
  sessionId,
  ownerId,
  name,
  agentType,
  command,
  deps,
}: {
  sessionId: string;
  ownerId: string;
  name?: string;
  agentType?: string;
  command?: string;
  deps: SpawnSessionShellDeps;
}): Promise<SpawnSessionShellResult> {
  const resolvedType = agentType ?? DEFAULT_SHELL_AGENT_TYPE;
  if (!isShellAgentType(resolvedType)) return { ok: false, reason: 'invalid_agent_type' };
  if (command !== undefined && !isValidShellCommand(command)) return { ok: false, reason: 'invalid_command' };

  const existing = await deps.store.list(sessionId);
  const plan = planSpawnShell({ existingNames: existing.map((shell) => shell.name), requestedName: name });
  if (!plan.ok) return { ok: false, reason: plan.reason };

  try {
    const row = await deps.store.create({
      sessionId,
      ownerId,
      name: plan.name,
      agentType: resolvedType,
      command: command ?? null,
      now: deps.now(),
    });
    return { ok: true, shell: toShellDTO(row) };
  } catch (error) {
    // Lost the `(sessionId, name)` race to a concurrent spawn. Reported as
    // `name_taken` rather than retried with a new auto-label: a retry loop here
    // would hide a genuinely duplicated request, and the caller reopening a shell
    // is one click.
    if (isUniqueViolation(error)) return { ok: false, reason: 'name_taken' };
    return { ok: false, reason: 'error' };
  }
}

export interface ResolveSessionShellDeps {
  store: Pick<SessionShellStore, 'findById'>;
}

export type ResolveSessionShellResult =
  | {
      ok: true;
      shell: ShellDTO;
      /** The PTY's working directory. Always the sandbox home: a session's filesystem has no scope-specific checkout to land in. */
      cwd: string;
      /** Set once the realtime bridge has opened a PTY, so a reconnect reattaches instead of spawning a second process. */
      streamSessionId: string | null;
    }
  | { ok: false; reason: 'not_found' };

/**
 * Resolve a shell by its id — the ONLY lookup, because the id is the only
 * address (the predecessor's `(machineId, projectName, branchName, name)` tuple
 * has no successor).
 *
 * PERFORMS NO ACCESS CHECK and resolves NO Sprite. A caller learns which session
 * a shell belongs to only from the result, so it must authorize against that
 * (`checkAgentSessionAccess`) before acting; and acquiring the session's sandbox
 * is `ensureAgentSessionSandbox`'s job, kept separate so that a cheap
 * re-validation (the bridge's periodic re-auth tick) never wakes a hibernating
 * VM just to answer "does this still exist".
 */
export async function resolveSessionShellById({
  shellId,
  deps,
}: {
  shellId: string;
  deps: ResolveSessionShellDeps;
}): Promise<ResolveSessionShellResult> {
  const row = await deps.store.findById(shellId);
  if (!row) return { ok: false, reason: 'not_found' };
  return { ok: true, shell: toShellDTO(row), cwd: SANDBOX_ROOT, streamSessionId: row.streamSessionId };
}

export interface KillSessionShellDeps {
  store: Pick<SessionShellStore, 'findById' | 'remove'>;
  /** Resolves the OWNING session's live Sprite pointer — a shell has none of its own. `null` when the session has no sandbox (then there is no PTY to kill). */
  resolveSessionSandboxId: (sessionId: string) => Promise<string | null>;
  host: SandboxHost;
}

export type KillSessionShellResult =
  /** `killed: false` means there was nothing left to kill — see the 404-as-success note below. */
  | { ok: true; killed: boolean }
  | { ok: false; reason: 'error' };

/**
 * Kill a shell: terminate its PTY process (if one was ever launched) and drop
 * the row. The session's SANDBOX is untouched — every other shell in it keeps
 * running, and the filesystem is the session's, not this shell's.
 *
 * **Killing something already gone is SUCCESS.** `planKillTarget` says so, and
 * the callers are why: closing a tab, ending a session and unwinding a failed
 * spawn all retry, and making "already gone" an error forces every one of them
 * to special-case it — which is exactly what the predecessor's in-flight-kill
 * bookkeeping (`killsInFlight`) existed to paper over.
 */
export async function killSessionShellById({
  shellId,
  deps,
}: {
  shellId: string;
  deps: KillSessionShellDeps;
}): Promise<KillSessionShellResult> {
  const row = await deps.store.findById(shellId);
  const plan = planKillTarget({ knownIds: row ? [row.id] : [], targetId: shellId });
  if (!plan.ok) return { ok: false, reason: 'error' };
  if (plan.action === 'noop' || !row) return { ok: true, killed: false };

  if (row.streamSessionId !== null) {
    const sandboxId = await deps.resolveSessionSandboxId(row.sessionId);
    if (sandboxId !== null) {
      let handle;
      try {
        handle = await deps.host.attach({ sandboxId });
      } catch {
        // The control plane itself is unreachable — we learned NOTHING about the
        // process. Keep the row so a retry can find it again; dropping it now
        // would leave a possibly-running process with nothing pointing at it.
        return { ok: false, reason: 'error' };
      }
      if (handle) {
        try {
          // The kill-by-id endpoint reaches this session whether or not we hold a
          // live stream to it, and is idempotent against an already-dead id — so
          // anything that throws here is a real unknown, not "already gone".
          await handle.killSession(row.streamSessionId);
        } catch {
          return { ok: false, reason: 'error' };
        }
      }
      // A vanished sandbox has nothing left running; the row is still dropped.
    }
  }

  await deps.store.remove(row.id);
  return { ok: true, killed: true };
}

export interface ListSessionShellsDeps {
  store: Pick<SessionShellStore, 'list'>;
}

/** Every shell in a session, as DTOs. Deliberately unfiltered — a row with an unrecognized `agentType` is still listed, or it would be undiscoverable and therefore unkillable. */
export async function listSessionShells({
  sessionId,
  deps,
}: {
  sessionId: string;
  deps: ListSessionShellsDeps;
}): Promise<ShellDTO[]> {
  const rows = await deps.store.list(sessionId);
  return rows.map(toShellDTO);
}
