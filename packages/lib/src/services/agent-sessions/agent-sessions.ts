/**
 * Agent sessions: ensure / end / list (IO, dependency-injected).
 *
 * The lifecycle orchestration around `agent_sessions`, split from the Sprite
 * provisioning (`agent-session-sprite.ts`) because they answer different
 * questions: this module is about the ROW — does this conversation have a
 * session, is it ended, what does a client see — while that one is about the VM.
 * A conversation gets a row the first time anything sandbox-shaped happens in
 * it; most conversations never get one at all.
 *
 * Successor to the session half of `services/machines/agent-terminals.ts`, with
 * the whole scope-dispatch apparatus gone. There is no
 * `(machineId, projectName, branchName)` tuple to resolve, no `resolveScopeKey`,
 * no `resolveLocationForRow`, no shared-Sprite fallback, and no `name_in_use`
 * idempotency contract — because a session is addressed by the conversation id
 * the caller already holds. That single change is what makes `ensure` a PK
 * conflict instead of a scope lookup plus a name reservation plus a race
 * reconciliation.
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

/**
 * Create the `conversations` row this session's FK depends on.
 *
 * Injected rather than imported because the squat-guarded creation path lives in
 * the app's conversation repository (it has to consult `chat_messages` ownership
 * to refuse claiming a legacy conversation someone else already wrote in), and
 * because that guard must remain the ONLY way a conversation id is claimed. A
 * store that could insert conversations itself would be a second, unguarded
 * door: `chat_messages.conversationId` has no FK, so an unguarded insert would
 * let one user's session row take permanent ownership of another user's history.
 *
 * Must be idempotent — it runs on every ensure.
 */
export type EnsureConversationFn = (input: {
  conversationId: string;
  userId: string;
  /** null for a global-assistant session, whose conversation is not anchored to a page. */
  agentPageId: string | null;
}) => Promise<void>;

export interface EnsureAgentSessionDeps {
  store: Pick<AgentSessionStore, 'findById' | 'insertIfAbsent'>;
  ensureConversation: EnsureConversationFn;
  now: () => Date;
}

export type EnsureAgentSessionResult =
  | { ok: true; session: AgentSessionRecord }
  /**
   * This conversation id cannot host a session: it does not exist and could not
   * be created, or the squat guard refused to claim it because someone else's
   * messages already live under it. Both collapse to one reason on purpose —
   * they are the same fact to a caller, and distinguishing them would leak
   * whether an id is taken.
   */
  | { ok: false; reason: 'conversation_unavailable'; detail?: string };

/**
 * Get (or lazily create) the session row for a conversation.
 *
 * Does NOT touch a Sprite: acquiring the sandbox is `ensureAgentSessionSandbox`'s
 * job, called separately by whichever surface actually needs compute. Splitting
 * them is what lets a session row exist for a conversation that has never run
 * anything, and lets the two concurrent first-touches (a sandbox tool call and a
 * shell open) share one row without either waiting on the other's VM.
 *
 * Concurrency-safe by the primary key: the row IS keyed on the conversation id,
 * so a double ensure inserts once and both callers re-select the same row.
 */
export async function ensureAgentSession({
  userId,
  agentPageId,
  conversationId,
  name,
  deps,
}: {
  userId: string;
  /** null = a global-assistant session. */
  agentPageId: string | null;
  /** ≡ the sessionId. Client-minted; never generated here. */
  conversationId: string;
  /** Display label only. Absent leaves it null — a session with no label is not a session with no identity. */
  name?: string | null;
  deps: EnsureAgentSessionDeps;
}): Promise<EnsureAgentSessionResult> {
  const now = deps.now();
  try {
    // The conversation must exist first: `agent_sessions.conversationId` is a FK
    // (and the PK), so a session row can never dangle over a conversation that
    // was never claimed.
    await deps.ensureConversation({ conversationId, userId, agentPageId });
    await deps.store.insertIfAbsent({ conversationId, ownerId: userId, agentPageId, name: name ?? null, now });
  } catch (error) {
    return {
      ok: false,
      reason: 'conversation_unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const session = await deps.store.findById(conversationId);
  // Absent after an insert-if-absent means the insert did not land and no
  // concurrent one did either — the conversation row is not there (the squat
  // guard declined), so the FK had nothing to point at.
  if (!session) return { ok: false, reason: 'conversation_unavailable' };
  return { ok: true, session };
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
    row: row === null ? null : { ...row, sessionId: row.conversationId },
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
 * session with no label still renders, it just renders as its conversation.
 */
export function toAgentSessionDTO(row: AgentSessionRecord): AgentSessionDTO {
  return {
    sessionId: row.conversationId,
    ownerId: row.ownerId,
    agentPageId: row.agentPageId,
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
 * List sessions by agent page, drive, or owner.
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
