/**
 * Agent sessions: spawn / end / list (IO, dependency-injected).
 *
 * The lifecycle orchestration around `agent_workspaces`, split from the Sprite
 * provisioning (`agent-workspace-sprite.ts`) because they answer different
 * questions: this module is about the ROW — does this session exist, is it
 * ended, what does a client see — while that one is about the VM.
 *
 * A session is a drive-level workspace with its own id (contract invariant 1),
 * so there is no ensure-by-conversation here any more: SPAWNING a session is an
 * explicit act that mints a fresh row, and a conversation finds its session
 * through `conversations.workspaceId` (`store.findByConversation`), never by
 * being one. The old semantics — every conversation lazily "ensuring" a
 * session of its own on first sandbox touch — are exactly the conflation the
 * un-conflation removed: they minted one environment per chat thread.
 *
 * Every lifecycle decision here comes from `planSpriteHolderLifecycle`; this
 * module executes verdicts and writes what they say to write.
 */

import type { SandboxHost } from '../sandbox/sandbox-host';
import { SandboxSpriteReplacedError } from '../sandbox/sandbox-host';
import { planSpriteHolderLifecycle, type SpriteHolderLifecyclePlan } from '../../agent-workspaces/plan-workspace-lifecycle';
import type { AgentSessionDTO } from '../../agent-workspaces/session-contract';
import { deriveSandboxStatus } from './workspace-status';
import type {
  AgentSessionListFilter,
  AgentSessionRecord,
  AgentSessionStore,
  DriveEnvSpritePointers,
} from './agent-workspaces-store';

export interface SpawnAgentSessionDeps {
  store: Pick<AgentSessionStore, 'createIfUnderLimit'>;
  now: () => Date;
  /**
   * Resolve the ENVIRONMENT a session is being spawned into — the drive it
   * belongs to, or null when there is no such env.
   *
   * REQUIRED even though a spawn without `envId` never calls it, for the same
   * reason `maxActiveSessions` is required: an env binding that skipped this
   * lookup would write an `envId` nothing proved belongs to the caller's
   * drive, and routing provisioning at that env would put a member's session
   * onto ANOTHER drive's shared filesystem through an authorization path that
   * never looked at that drive. A dep cannot be forgotten; a call-site check
   * can.
   */
  findEnv: (envId: string) => Promise<{ driveId: string } | null>;
  /**
   * The most NOT-ENDED sessions this owner may hold. REQUIRED, mirroring
   * `checkConcurrency` in `agent-workspace-sprite.ts`: the ceiling used to be a
   * pre-check at ONE call site (the web route), which a future caller could
   * simply forget to run. Folding it into this function's dependencies makes
   * it a property of spawning a session at all, not a habit each call site
   * has to remember (review #2261/2).
   */
  maxActiveSessions: number;
}

export type SpawnAgentSessionResult =
  | { ok: true; session: AgentSessionRecord }
  /** The drive does not exist (FK refused) or the insert failed outright. */
  | { ok: false; reason: 'spawn_failed'; detail?: string }
  /** The owner is already at `maxActiveSessions` not-ended sessions. */
  | { ok: false; reason: 'session_limit_reached' }
  /**
   * No such environment, OR it belongs to a different drive than the session
   * being spawned. ONE reason for both, deliberately — the same collapse
   * `resolveEnvInDrive` makes: a caller who may not see a drive must not learn
   * from the error which of its envs exist, so both answer 404.
   */
  | { ok: false; reason: 'env_not_found' };

/**
 * Spawn a session: mint the workspace row.
 *
 * Does NOT touch a Sprite (acquiring the sandbox is `ensureAgentSessionSandbox`'s
 * job, on first real use — spawn must be instant and free), and does NOT create
 * conversations: the caller binds the session's first conversation through the
 * squat-guarded conversation path with `workspaceId` set at creation. A session
 * is never empty — its spawner gives it that first conversation in the same
 * user-visible act — but that composition lives at the surface, not here,
 * because this module cannot claim conversation ids.
 *
 * No idempotency and nothing to race: the id is minted here, so two spawns are
 * two sessions, which is precisely what two spawns mean.
 *
 * **`envId` binds the session to a persistent ENVIRONMENT**, and the validation
 * is deliberately three facts and no more: the env exists, it belongs to THIS
 * session's drive, and the actor passed the drive gate — which the caller has
 * already established by choosing `driveId` (that is what choosing it IS, the
 * same rule `listAgentSessions` states about its filter). There is nothing else
 * to check: envs carry no kind and no substrate, so there is no shape of env
 * that refuses sessions.
 *
 * The drive agreement is what makes that sufficient. `drive_envs.driveId` is NOT
 * NULL, so requiring `env.driveId === driveId` also refuses a global-assistant
 * spawn (`driveId === null`) into any env at all — structurally, with no
 * separate branch — which is the same state
 * `agent_workspaces_env_needs_drive_check` forbids in the database. A session
 * that could carry an env and no drive would route work into a drive's shared
 * filesystem through `decideAgentSessionAccess`, which derives access from
 * `driveId` alone and would therefore never look at that drive.
 *
 * Nothing here touches the env's Sprite: an env provisions LAZILY, on the first
 * ensure of a session inside it, so spawning into an environment stays as
 * instant and as free as spawning outside one.
 */
export async function spawnAgentSession({
  ownerId,
  driveId,
  envId,
  name,
  deps,
}: {
  ownerId: string;
  /** null = a global-assistant session (user-scoped, outside any drive). */
  driveId: string | null;
  /**
   * The persistent environment to run inside, or null/absent for the ordinary
   * ephemeral session that owns its own Sprite.
   */
  envId?: string | null;
  /** Display label only. Absent leaves it null. */
  name?: string | null;
  deps: SpawnAgentSessionDeps;
}): Promise<SpawnAgentSessionResult> {
  const boundEnvId = envId ?? null;
  if (boundEnvId !== null) {
    const env = await deps.findEnv(boundEnvId);
    // Both misses collapse to one answer — see `SpawnAgentSessionResult`. Note
    // that `driveId === null` can never satisfy this comparison, because
    // `drive_envs.driveId` is NOT NULL: a global-assistant session is refused
    // an env here without a branch of its own.
    if (!env || env.driveId !== driveId) return { ok: false, reason: 'env_not_found' };
  }
  try {
    const result = await deps.store.createIfUnderLimit({
      ownerId,
      driveId,
      name: name ?? null,
      envId: boundEnvId,
      now: deps.now(),
      maxActive: deps.maxActiveSessions,
    });
    if (!result.ok) return { ok: false, reason: 'session_limit_reached' };
    return { ok: true, session: result.session };
  } catch (error) {
    return {
      ok: false,
      reason: 'spawn_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface EndAgentSessionDeps {
  store: Pick<AgentSessionStore, 'findById' | 'applyStamps' | 'requestTeardown' | 'stampSpriteTornDown'>;
  host: SandboxHost;
  now: () => Date;
}

export type EndAgentSessionResult =
  | { ok: true; spriteTornDown: boolean }
  | { ok: false; reason: 'not_found' | 'teardown_failed'; detail?: string };

/**
 * Bounded retries for the never-provisioned-noop's CAS (see below). A stale
 * plan re-reads and re-plans against the fresh row rather than clobbering it,
 * so contention resolves in a handful of attempts under any realistic race;
 * this is a backstop against pathological, sustained contention, not the
 * normal path.
 */
const MAX_END_ATTEMPTS = 5;

/**
 * End a session: kill its Sprite (instance-guarded) and stamp the row.
 *
 * THE ROW IS KEPT. That is the point of the whole design — a later `ensure`
 * re-provisions under the SAME `spriteKey`, giving the conversation back its
 * name and identity with a fresh filesystem. Deleting the row would also delete
 * the conversation's only durable link to the Sprite it used to own.
 *
 * Never gated on authorization: the planner decides `end` before it looks at
 * `canRun`, because an actor who has just LOST the right to a session must still
 * be able to release its compute, and so must every automated cleanup path.
 */
export async function endAgentSession({
  workspaceId,
  deps,
}: {
  workspaceId: string;
  deps: EndAgentSessionDeps;
}): Promise<EndAgentSessionResult> {
  // Bounded retry: the never-provisioned noop's plan is only valid while
  // `sandboxId` stays null between the read and the write below. A concurrent
  // `ensure` can provision in that window; re-reading and re-planning turns
  // that race into a REAL teardown of the newly-live session instead of a
  // stale `endedAt` stamp landing on it (review #2261/1).
  for (let attempt = 0; attempt < MAX_END_ATTEMPTS; attempt += 1) {
    const row = await deps.store.findById(workspaceId);
    const now = deps.now();
    const plan = planSpriteHolderLifecycle({
      row: row === null ? null : { ...row, holderId: row.id },
      intent: 'end',
      // Ignored for `end` — the planner handles cleanup BEFORE the authorization
      // gate. Passing `true` documents that this path deliberately does not gate.
      canRun: true,
      now,
    });

    if (plan.action === 'noop') {
      if (plan.reason === 'no_session') return { ok: false, reason: 'not_found' };
      if (plan.reason === 'already_ended') {
        // Nothing to write (plan.stamps is {}) — no race to guard against.
        await deps.store.applyStamps({ workspaceId, stamps: plan.stamps });
        return { ok: true, spriteTornDown: false };
      }
      // `no_sandbox`: this plan is only valid while the row's `sandboxId`
      // stays null. CAS-guard the `endedAt` stamp on that pointer — if a
      // concurrent `ensure` provisioned in between, the stamp must not land on
      // a now-live session; re-read and re-plan against what it actually is.
      const applied = await deps.store.applyStamps({
        workspaceId,
        stamps: plan.stamps,
        cas: { sandboxId: null },
      });
      if (!applied) continue;
      return { ok: true, spriteTornDown: false };
    }

    if (plan.action !== 'teardown') {
      // Unreachable: `end` yields only `teardown` or `noop`.
      return { ok: false, reason: 'teardown_failed', detail: `unexpected_lifecycle_verdict:${plan.action}` };
    }

    return endProvisionedSession({ workspaceId, plan, now, deps });
  }
  // Sustained contention exhausted every retry — a transient condition the
  // caller can simply retry, not a genuine failure of this session.
  return { ok: false, reason: 'teardown_failed', detail: 'concurrent_modification' };
}

async function endProvisionedSession({
  workspaceId,
  plan,
  now,
  deps,
}: {
  workspaceId: string;
  plan: Extract<SpriteHolderLifecyclePlan, { action: 'teardown' }>;
  now: Date;
  deps: EndAgentSessionDeps;
}): Promise<EndAgentSessionResult> {
  // Record the teardown INTENT before the kill, so a crash in between still
  // leaves the Sprite reclaimable by the orphan reconciler. CAS-guarded on the
  // pointer we are about to kill: if a concurrent ensure has already revived
  // this session onto a NEW VM, the stamp must not land — a live session
  // carrying a teardown request is exactly what the reconciler would destroy.
  await deps.store.requestTeardown({
    workspaceId,
    sandboxId: plan.sandboxId,
    spriteInstanceId: plan.expectedInstanceId,
    at: now,
  });

  try {
    await deps.host.kill({ sandboxId: plan.sandboxId, expectedInstanceId: plan.expectedInstanceId });
  } catch (error) {
    // A DIFFERENT VM holds this name now, so the one we targeted is already gone
    // — a confirmed-enough death to stamp (the CAS below still refuses if the row
    // has moved on to that replacement).
    if (!(error instanceof SandboxSpriteReplacedError)) {
      // A real failure: the VM may still be running. The row keeps its teardown
      // request, so the orphan reconciler retries — which is why this is reported
      // rather than swallowed.
      return { ok: false, reason: 'teardown_failed', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  // Stamp under a CAS on the INSTANCE we killed. Losing it means a concurrent
  // ensure re-provisioned this session onto a live replacement between our kill
  // and now: those stamps are not ours to write, and marking that VM as torn down
  // would hide a billing Sprite from the reconciler forever.
  const stamped = await deps.store.stampSpriteTornDown({
    workspaceId,
    sandboxId: plan.sandboxId,
    spriteInstanceId: plan.expectedInstanceId,
    stamps: plan.stamps,
  });
  // Report the CAS outcome honestly (review #2261/3): when a concurrent
  // ensure revived this session onto a new instance, the CAS correctly
  // refused, and the caller must not be told the session ended — it is live
  // again, on a Sprite this call never touched.
  return { ok: true, spriteTornDown: stamped };
}

/**
 * Project a stored row onto the wire DTO (pure).
 *
 * `Date` never crosses the boundary (ISO-8601 strings only — see `contract.ts`),
 * and `name` coalesces to empty rather than null because it is a LABEL: a
 * session with no label still renders, it just renders unlabelled.
 *
 * `sandboxStatus` is the one field that is not a projection of this row alone:
 * an env-bound session's machine belongs to its ENV's row, so the env's
 * pointers are passed in beside it.
 */
export function toAgentSessionDTO(
  row: AgentSessionRecord,
  /**
   * The env's Sprite pointers when `row.envId` is set; `null` otherwise. See
   * `deriveSandboxStatus` for why this is a required argument rather than an
   * optional one — an env-bound session's own Sprite columns are permanently
   * null, so a forgotten argument reports a live machine as `'none'`.
   */
  env: DriveEnvSpritePointers | null,
): AgentSessionDTO {
  return {
    workspaceId: row.id,
    // Rolling-deploy compat, one release only: the same value under the
    // pre-rename name so a pre-rename browser bundle keeps working. Dropped by
    // the contract PR.
    sessionId: row.id,
    driveId: row.driveId,
    ownerId: row.ownerId,
    name: row.name ?? '',
    envId: row.envId,
    sandboxStatus: deriveSandboxStatus(row, env),
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

export interface ListAgentSessionsDeps {
  store: Pick<AgentSessionStore, 'list'>;
}

/**
 * List sessions by drive or owner.
 *
 * The filter type requires at least one narrowing key, so there is no
 * "everything" query to accidentally issue. Access is NOT checked here — the
 * caller has already established which scope the requester may enumerate (that
 * is what choosing the filter IS); per-row access is
 * `agent-workspace-access.ts`'s question.
 */
export async function listAgentSessions({
  filter,
  deps,
}: {
  filter: AgentSessionListFilter;
  deps: ListAgentSessionsDeps;
}): Promise<AgentSessionDTO[]> {
  const rows = await deps.store.list(filter);
  // The env's pointers ride along on each row (the store's LEFT JOIN), so this
  // stays ONE query no matter how many of the listed sessions are env-bound —
  // and never a per-row lookup fired from a projection.
  return rows.map((row) => toAgentSessionDTO(row, row.env));
}
