/**
 * The agent-session sandbox lifecycle, as a pure planner.
 *
 * Every `if` that decides whether a session gets a VM, keeps one, adopts one, or
 * kills one lives HERE, as data-in/data-out. The runtime wrapper owns no policy:
 * it reads the row, observes the live Sprite (when it has one), asks for a
 * verdict, executes it, and writes the verdict's stamps. Web and realtime call
 * the same function, so they cannot diverge.
 *
 * It absorbs the decision branches of two proven predecessors:
 *  - `planMachineLifecycle` (services/sandbox/machine-session-manager.ts) — the
 *    authorize → create/resume/teardown skeleton, including its two hard rules:
 *    re-authorize BEFORE handing back a warm session, and never gate CLEANUP on
 *    authorization.
 *  - `reconcileResumedSpriteInstance` (services/machines/agent-terminal-sprites.ts)
 *    — the CAS/ABA reconciliation: a Sprite re-provisioned under the session's
 *    deterministic name is a DIFFERENT VM answering to the SAME name, so a row
 *    still holding the predecessor's instance id must ADOPT the live one before
 *    anything treats the row as resumed. Otherwise every later teardown passes a
 *    stale expected instance, the kill politely misses, and the live replacement
 *    bills forever with nothing pointing at it.
 *
 * Two invariants this planner enforces structurally:
 *
 * **Idleness never destroys.** Sprites hibernate on their own — an idle VM costs
 * bytes-written storage, not compute — so there is no idle branch at all. The
 * only path to `teardown` is an explicit `end` intent. A row idle for years
 * still resumes.
 *
 * **A killed session keeps its row.** `end` stamps the row (`teardownRequestedAt`,
 * `spriteTornDownAt`, `endedAt`) and never deletes it, so a later `ensure`
 * re-provisions under the SAME key — same name, same identity, fresh filesystem.
 */

/**
 * The slice of an `agent_sessions` row the lifecycle decides on. Everything here
 * is a pointer or a stamp; nothing is derived.
 */
export interface AgentSessionLifecycleRow {
  /** ≡ the conversation id (see `contract.ts`). */
  sessionId: string;
  /**
   * The derived Sprite NAME this session provisions under. Deterministic, so it
   * is unchanged across a VM replacement — which is exactly why an identity CAS
   * needs it, and why a row that somehow lacks it cannot be reconciled.
   */
  sessionKey: string | null;
  /** The Sprite name currently recorded on the row; null = never provisioned, or torn down. */
  sandboxId: string | null;
  /** WHICH VM, as opposed to which name it answers to. Null when the platform reported none. */
  spriteInstanceId: string | null;
  egressPolicyToken: string | null;
  /** Durable teardown INTENT — recorded before the kill so a crash mid-teardown is still reclaimable. */
  teardownRequestedAt: Date | null;
  /** Stamped once a kill was CONFIRMED. */
  spriteTornDownAt: Date | null;
  endedAt: Date | null;
  lastActiveAt: Date | null;
}

/**
 * - `ensure` — the lazy first touch (first sandbox-using tool call, first shell
 *   open). May mint a VM.
 * - `attach` — a read-only resolve, e.g. a PTY reconnect that carries no
 *   provisioning deps. NEVER mints a VM: a missing, unprovisioned, or torn-down
 *   session is denied so a reconnect can never silently share or resurrect a
 *   Sprite (the failure a torn-down row caused in the predecessor system).
 * - `end` — explicit teardown. Unconditional on authorization.
 * - `reprovision` — deliberately replace an unusable Sprite under the same key.
 */
export type AgentSessionIntent = 'ensure' | 'attach' | 'end' | 'reprovision';

/** A Sprite the caller has actually observed under this session's name. */
export interface LiveSpriteInstance {
  sandboxId: string;
  spriteInstanceId: string | null;
}

/**
 * Row columns a verdict says to write. Applied by the runtime AFTER the verdict's
 * IO succeeds — with one deliberate exception: `teardownRequestedAt` on a
 * teardown is written BEFORE the kill, because its whole job is to survive a
 * crash between "we decided to kill" and "the kill was confirmed".
 *
 * `null` here always means "clear this column"; an absent key means "leave it".
 */
export interface AgentSessionRowStamps {
  lastActiveAt?: Date;
  endedAt?: Date | null;
  teardownRequestedAt?: Date | null;
  spriteTornDownAt?: Date | null;
  /**
   * Cleared whenever the VM behind the row CHANGES: a new instance has a fresh
   * disk, so the stored measurement describes a filesystem that no longer exists
   * and would otherwise bill the old size until some unrelated wake re-measured.
   */
  storageMeasuredBytes?: null;
  storageMeasuredAt?: null;
}

export type AgentSessionDenyReason =
  /** The actor may not run code here — re-checked on every intent that could hand back a sandbox. */
  | 'not_authorized'
  /** Nothing to attach to or reprovision. */
  | 'session_not_found'
  /** The session was explicitly ended; `ensure` revives it, `attach` must not. */
  | 'session_torn_down'
  /** `attach` found a session that has never acquired a sandbox — provisioning is `ensure`'s job. */
  | 'sandbox_not_provisioned'
  /**
   * The owner is at their plan's live-session ceiling. Deliberately NOT
   * `not_authorized`: the actor has every right to this session, they have run
   * out of allowance. Conflating the two tells a paying user they lack
   * permission (with no mention of the limit or how to clear it) and files
   * routine quota events as authorization denials in the security audit, where
   * a free-tier user clicking "new session" reads as repeated access violations.
   */
  | 'session_limit_reached'
  /** The live VM's identity moved but the row carries no key to CAS against — reconcile, never resume on a stale identity. */
  | 'missing_session_key';

export type AgentSessionNoopReason = 'no_session' | 'no_sandbox' | 'already_ended';

export type AgentSessionLifecyclePlan =
  /** Provision under the session's derived key. `previousSandboxId` is the pointer to CAS against (null when there is no row yet). */
  | { action: 'create'; previousSandboxId: string | null; stamps: AgentSessionRowStamps }
  /** Reconnect to the recorded Sprite. Covers warm AND hibernating VMs — waking is the platform's job, not a distinct verdict. */
  | { action: 'resume'; sandboxId: string; spriteInstanceId: string | null; stamps: AgentSessionRowStamps }
  /** CAS the live VM's identity onto the row, then treat it as resumed. Never a blind kill. */
  | {
      action: 'adopt';
      sandboxId: string;
      spriteInstanceId: string | null;
      previousSandboxId: string | null;
      previousSpriteInstanceId: string | null;
      stamps: AgentSessionRowStamps;
    }
  /** Kill, guarded by the INSTANCE the row records — a stale expectation must refuse, not silently miss. */
  | { action: 'teardown'; sandboxId: string; expectedInstanceId: string | null; stamps: AgentSessionRowStamps }
  | { action: 'deny'; reason: AgentSessionDenyReason; stamps: AgentSessionRowStamps }
  | { action: 'noop'; reason: AgentSessionNoopReason; stamps: AgentSessionRowStamps };

export interface PlanAgentSessionLifecycleInput {
  row: AgentSessionLifecycleRow | null;
  intent: AgentSessionIntent;
  /**
   * The caller's freshly-computed code-execution authorization (see
   * `decide-session-access.ts`), passed through rather than re-derived — every
   * request re-checks it, and a warm session is never handed back to an actor who
   * lost the right to it.
   */
  canRun: boolean;
  now: Date;
  /** The Sprite the caller observed under this session's name, when it probed for one. */
  liveInstance?: LiveSpriteInstance | null;
}

/**
 * A session is ended if either stamp is set. Both are checked because they land
 * at different moments: `endedAt` records the user's intent, `spriteTornDownAt`
 * records a CONFIRMED kill, and a crash between them must still read as ended.
 */
function isEnded(row: AgentSessionLifecycleRow): boolean {
  return row.endedAt !== null || row.spriteTornDownAt !== null;
}

/** Provisioning revives a row: the session is live again, and any teardown intent recorded against its predecessor is void. */
function reviveStamps(now: Date): AgentSessionRowStamps {
  return {
    lastActiveAt: now,
    endedAt: null,
    teardownRequestedAt: null,
    spriteTornDownAt: null,
    storageMeasuredBytes: null,
    storageMeasuredAt: null,
  };
}

/**
 * REOPEN a session's listing without provisioning anything — the stamp for
 * "a permitted actor put new work into this workspace" (a conversation
 * claimed into it after it was ended; issue #2335). Withdraws only the
 * user's end-INTENT (`endedAt`), so the session reappears in listings and
 * its cap/verbs work again.
 *
 * Deliberately narrower than `reviveStamps` (private, provisioning-only):
 * `spriteTornDownAt` — the CONFIRMED-kill record — is preserved, so
 * `isEnded` stays true for the lifecycle until an actual provision runs:
 * `ensure` still fresh-creates (never resumes onto the dead VM's stale
 * `sandboxId`), `attach` still refuses, and the orphan reconciler's
 * bookkeeping is untouched. Clearing it here, without a provision, would
 * recreate exactly the stale-attach hazard `resolveLiveInstance` documents.
 */
export function planSessionReopen(): AgentSessionRowStamps {
  return { endedAt: null };
}

/** Has the VM behind this session's name changed since the row last looked? */
function instanceMoved(row: AgentSessionLifecycleRow, live: LiveSpriteInstance): boolean {
  return live.sandboxId !== row.sandboxId || (live.spriteInstanceId ?? null) !== (row.spriteInstanceId ?? null);
}

/**
 * Resolve a provisioned row against the live Sprite the caller observed.
 *
 * Note the accepted risk in the "live instance is unidentified" case: adopting a
 * null instance id costs the row its ABA guard (later kills fall back to
 * comparing names). That is the platform's posture where it reports no identity —
 * the alternative, refusing to resume, would take the session down for a
 * condition the user cannot act on — and it is confined to this one branch.
 */
function resolveLiveInstance(
  row: AgentSessionLifecycleRow,
  sandboxId: string,
  liveInstance: LiveSpriteInstance | null | undefined,
  now: Date,
): AgentSessionLifecyclePlan {
  const activeStamps: AgentSessionRowStamps = { lastActiveAt: now, endedAt: null, teardownRequestedAt: null };

  if (!liveInstance || !instanceMoved(row, liveInstance)) {
    return { action: 'resume', sandboxId, spriteInstanceId: row.spriteInstanceId, stamps: activeStamps };
  }

  // The identity CAS is keyed on the row's deterministic session key. Without it
  // we cannot fence the write, and resuming on the stale identity is exactly what
  // strands a live VM — so hand the caller a denial to reconcile instead.
  if (row.sessionKey === null) {
    return { action: 'deny', reason: 'missing_session_key', stamps: {} };
  }

  return {
    action: 'adopt',
    sandboxId: liveInstance.sandboxId,
    spriteInstanceId: liveInstance.spriteInstanceId,
    previousSandboxId: row.sandboxId,
    previousSpriteInstanceId: row.spriteInstanceId,
    stamps: { ...activeStamps, spriteTornDownAt: null, storageMeasuredBytes: null, storageMeasuredAt: null },
  };
}

export function planAgentSessionLifecycle({
  row,
  intent,
  canRun,
  now,
  liveInstance = null,
}: PlanAgentSessionLifecycleInput): AgentSessionLifecyclePlan {
  // Cleanup first, and unconditionally: authorization gates ACQUIRING compute,
  // never releasing it. An actor who just lost the right to a session must still
  // be able to end it, and so must every automated path.
  if (intent === 'end') {
    if (!row) return { action: 'noop', reason: 'no_session', stamps: {} };
    // A CONFIRMED kill is checked BEFORE `sandboxId`, and specifically on
    // `spriteTornDownAt` rather than the broader `isEnded` — teardown never
    // clears `sandboxId` (the row outlives its Sprite, on purpose; see
    // `agent-sessions-store.ts`'s schema doc), so a NORMALLY-ended session —
    // the common shape, `sandboxId` still recorded — used to fall through to
    // `teardown` on every re-end, re-requesting teardown and re-killing an
    // already-confirmed-dead Sprite (review #2261/4). `isEnded` would be the
    // WRONG guard here: it also trips on `endedAt` alone, which is exactly
    // the crash-recovery shape below (`teardownRequestedAt`/`endedAt` stamped
    // together on a CONFIRMED kill, so `endedAt` set with `spriteTornDownAt`
    // still null means the kill was never confirmed) — that row must still
    // retry teardown, not read as already-ended.
    if (row.spriteTornDownAt !== null) {
      // Sprite confirmed dead — never re-kill it. But a REOPENED row
      // (`planSessionReopen` cleared `endedAt` when new work was claimed in)
      // must still be endable: record the fresh end-intent, kill nothing.
      if (row.endedAt !== null) return { action: 'noop', reason: 'already_ended', stamps: {} };
      return { action: 'noop', reason: 'no_sandbox', stamps: { endedAt: now } };
    }
    if (row.sandboxId !== null) {
      return {
        action: 'teardown',
        sandboxId: row.sandboxId,
        expectedInstanceId: row.spriteInstanceId,
        stamps: { teardownRequestedAt: now, spriteTornDownAt: now, endedAt: now },
      };
    }
    // No sandbox recorded: either explicitly ended already (nothing further
    // to stamp) or never acquired one, which still ends the session.
    if (row.endedAt !== null) return { action: 'noop', reason: 'already_ended', stamps: {} };
    return { action: 'noop', reason: 'no_sandbox', stamps: { endedAt: now } };
  }

  // Re-authorize BEFORE looking at any warm session, so an unauthorized actor is
  // never handed back another actor's state — or a VM to run code in.
  if (!canRun) return { action: 'deny', reason: 'not_authorized', stamps: {} };

  switch (intent) {
    case 'ensure': {
      if (!row) return { action: 'create', previousSandboxId: null, stamps: reviveStamps(now) };
      // A torn-down session re-provisions under the SAME key: same name, same
      // identity, fresh filesystem. This is the whole reason the row is retained.
      if (isEnded(row) || row.sandboxId === null) {
        return { action: 'create', previousSandboxId: row.sandboxId, stamps: reviveStamps(now) };
      }
      return resolveLiveInstance(row, row.sandboxId, liveInstance, now);
    }

    case 'attach': {
      if (!row) return { action: 'deny', reason: 'session_not_found', stamps: {} };
      // Denied rather than healed: this path has no provisioning deps, and the
      // predecessor's habit of falling through to a shared Sprite is precisely
      // how restored sessions ended up reading and overwriting each other's files.
      if (isEnded(row)) return { action: 'deny', reason: 'session_torn_down', stamps: {} };
      if (row.sandboxId === null) return { action: 'deny', reason: 'sandbox_not_provisioned', stamps: {} };
      return resolveLiveInstance(row, row.sandboxId, liveInstance, now);
    }

    case 'reprovision': {
      if (!row) return { action: 'deny', reason: 'session_not_found', stamps: {} };
      // Deliberate replacement — a live instance is irrelevant here: the caller
      // has already judged the current Sprite unusable.
      return { action: 'create', previousSandboxId: row.sandboxId, stamps: reviveStamps(now) };
    }

    default: {
      const exhaustive: never = intent;
      throw new Error(`unhandled agent-session intent: ${String(exhaustive)}`);
    }
  }
}
