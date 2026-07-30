/**
 * Agent sessions: spawn / end / list (IO, dependency-injected).
 *
 * The lifecycle orchestration around `agent_sessions`, split from the Sprite
 * provisioning (`agent-session-sprite.ts`) because they answer different
 * questions: this module is about the ROW — does this session exist, is it
 * ended, what does a client see — while that one is about the VM.
 *
 * A session is a drive-level workspace with its own id (contract invariant 1),
 * so there is no ensure-by-conversation here any more: SPAWNING a session is an
 * explicit act that mints a fresh row, and a conversation finds its session
 * through `conversations.sessionId` (`store.findByConversation`), never by
 * being one. The old semantics — every conversation lazily "ensuring" a
 * session of its own on first sandbox touch — are exactly the conflation the
 * un-conflation removed: they minted one environment per chat thread.
 *
 * Every lifecycle decision here comes from `planAgentSessionLifecycle`; this
 * module executes verdicts and writes what they say to write.
 */

import type { SandboxHost } from '../sandbox/sandbox-host';
import { SandboxSpriteReplacedError } from '../sandbox/sandbox-host';
import { planAgentSessionLifecycle } from '../../agent-sessions/plan-session-lifecycle';
import type { AgentSessionDTO } from '../../agent-sessions/contract';
import { deriveSandboxStatus } from './session-status';
import type { AgentSessionListFilter, AgentSessionRecord, AgentSessionStore } from './agent-sessions-store';

export interface SpawnAgentSessionDeps {
  store: Pick<AgentSessionStore, 'create'>;
  now: () => Date;
}

export type SpawnAgentSessionResult =
  | { ok: true; session: AgentSessionRecord }
  /** The drive does not exist (FK refused) or the insert failed outright. */
  | { ok: false; reason: 'spawn_failed'; detail?: string };

/**
 * Spawn a session: mint the workspace row.
 *
 * Does NOT touch a Sprite (acquiring the sandbox is `ensureAgentSessionSandbox`'s
 * job, on first real use — spawn must be instant and free), and does NOT create
 * conversations: the caller binds the session's first conversation through the
 * squat-guarded conversation path with `sessionId` set at creation. A session
 * is never empty — its spawner gives it that first conversation in the same
 * user-visible act — but that composition lives at the surface, not here,
 * because this module cannot claim conversation ids.
 *
 * No idempotency and nothing to race: the id is minted here, so two spawns are
 * two sessions, which is precisely what two spawns mean.
 */
export async function spawnAgentSession({
  ownerId,
  driveId,
  name,
  deps,
}: {
  ownerId: string;
  /** null = a global-assistant session (user-scoped, outside any drive). */
  driveId: string | null;
  /** Display label only. Absent leaves it null. */
  name?: string | null;
  deps: SpawnAgentSessionDeps;
}): Promise<SpawnAgentSessionResult> {
  try {
    const session = await deps.store.create({ ownerId, driveId, name: name ?? null, now: deps.now() });
    return { ok: true, session };
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
 * End a session: kill its Sprite (instance-guarded) and stamp the row.
 *
 * THE ROW IS KEPT. That is the point of the whole design — a later `ensure`
 * re-provisions under the SAME `sessionKey`, giving the conversation back its
 * name and identity with a fresh filesystem. Deleting the row would also delete
 * the conversation's only durable link to the Sprite it used to own.
 *
 * Never gated on authorization: the planner decides `end` before it looks at
 * `canRun`, because an actor who has just LOST the right to a session must still
 * be able to release its compute, and so must every automated cleanup path.
 */
export async function endAgentSession({
  sessionId,
  deps,
}: {
  sessionId: string;
  deps: EndAgentSessionDeps;
}): Promise<EndAgentSessionResult> {
  const row = await deps.store.findById(sessionId);
  const now = deps.now();
  const plan = planAgentSessionLifecycle({
    row: row === null ? null : { ...row, sessionId: row.id },
    intent: 'end',
    // Ignored for `end` — the planner handles cleanup BEFORE the authorization
    // gate. Passing `true` documents that this path deliberately does not gate.
    canRun: true,
    now,
  });

  if (plan.action === 'noop') {
    if (plan.reason === 'no_session') return { ok: false, reason: 'not_found' };
    // Either already ended (nothing stamped) or a session that never acquired a
    // sandbox, which still ends.
    await deps.store.applyStamps({ sessionId, stamps: plan.stamps });
    return { ok: true, spriteTornDown: false };
  }

  if (plan.action !== 'teardown') {
    // Unreachable: `end` yields only `teardown` or `noop`.
    return { ok: false, reason: 'teardown_failed', detail: `unexpected_lifecycle_verdict:${plan.action}` };
  }

  // Record the teardown INTENT before the kill, so a crash in between still
  // leaves the Sprite reclaimable by the orphan reconciler. CAS-guarded on the
  // pointer we are about to kill: if a concurrent ensure has already revived
  // this session onto a NEW VM, the stamp must not land — a live session
  // carrying a teardown request is exactly what the reconciler would destroy.
  await deps.store.requestTeardown({
    sessionId,
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
  await deps.store.stampSpriteTornDown({
    sessionId,
    sandboxId: plan.sandboxId,
    spriteInstanceId: plan.expectedInstanceId,
    stamps: plan.stamps,
  });
  return { ok: true, spriteTornDown: true };
}

/**
 * Project a stored row onto the wire DTO (pure).
 *
 * `Date` never crosses the boundary (ISO-8601 strings only — see `contract.ts`),
 * and `name` coalesces to empty rather than null because it is a LABEL: a
 * session with no label still renders, it just renders unlabelled.
 */
export function toAgentSessionDTO(row: AgentSessionRecord): AgentSessionDTO {
  return {
    sessionId: row.id,
    driveId: row.driveId,
    ownerId: row.ownerId,
    name: row.name ?? '',
    sandboxStatus: deriveSandboxStatus(row),
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
 * `agent-session-access.ts`'s question.
 */
export async function listAgentSessions({
  filter,
  deps,
}: {
  filter: AgentSessionListFilter;
  deps: ListAgentSessionsDeps;
}): Promise<AgentSessionDTO[]> {
  const rows = await deps.store.list(filter);
  return rows.map(toAgentSessionDTO);
}
