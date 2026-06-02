/**
 * Conversation sandbox lifecycle planning (pure).
 *
 * Given the current actor's authorization, any existing session link, the clock,
 * and the request intent, `planSandboxLifecycle` decides what should happen to a
 * conversation's sandbox — without performing any IO. The effect layer
 * (`session-manager`) executes the returned plan against the sandbox client and
 * the session store.
 *
 * Two security invariants are encoded here, not left to the caller:
 *
 *  - **Resume re-authz.** A warm sandbox carries the prior turn's filesystem and
 *    process state. Resuming it for an unauthorized actor is a cross-actor
 *    data-bleed path, so an unauthorized actor is `deny`d EVEN WHEN a (non-expired)
 *    session already exists — the existing handle is never returned.
 *  - **Cleanup is unconditional.** On a session-end intent the plan is always
 *    `teardown`, regardless of authorization, so a revoked actor can never strand
 *    a warm sandbox. An IDLE-expired session is likewise reclaimed before the authz
 *    gate, so a stale warm sandbox never leaks just because the requesting actor is
 *    now unauthorized. Authorization gates *use*, never *cleanup*.
 */

import type { CanRunCodeResult, CodeExecutionDenialReason } from './can-run-code';

/** Why a sandbox is being torn down — recorded for audit/forensics. */
export type TeardownReason = 'idle' | 'session_end' | 'crash' | 'failure';

/** Whether this turn wants to use a sandbox, or the session is ending. */
export type LifecycleIntent = 'run' | 'end';

/** A persisted sandbox↔conversation link, as the planner needs to see it. */
export interface SandboxSessionRef {
  sandboxId: string;
  lastActiveAt: Date;
}

export type SandboxLifecyclePlan =
  | { action: 'create' }
  | { action: 'resume'; sandboxId: string }
  | { action: 'teardown'; sandboxId: string; reason: TeardownReason }
  | { action: 'noop' }
  | { action: 'deny'; reason: CodeExecutionDenialReason };

export interface PlanLifecycleInput {
  /** Result of re-running `canRunCode` for the CURRENT actor, this turn. */
  authorization: CanRunCodeResult;
  existingSession?: SandboxSessionRef | null;
  now: Date;
  /** A session older than this since last activity is torn down. */
  idleTimeoutMs?: number;
  intent?: LifecycleIntent;
}

// 15 minutes: long enough to keep a multi-turn conversation's shell warm, short
// enough that an abandoned conversation's VM is reclaimed promptly.
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export function planSandboxLifecycle({
  authorization,
  existingSession = null,
  now,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  intent = 'run',
}: PlanLifecycleInput): SandboxLifecyclePlan {
  // Cleanup first, and unconditionally: an ending session is reclaimed whether
  // or not the current actor is still authorized.
  if (intent === 'end') {
    return existingSession
      ? { action: 'teardown', sandboxId: existingSession.sandboxId, reason: 'session_end' }
      : { action: 'noop' };
  }

  // Reclaim an idle-expired session BEFORE the authz gate: a stale warm sandbox
  // must never leak just because the requesting actor is now unauthorized. The
  // teardown only reclaims the VM (stop + unlink); it never hands the handle back,
  // and the effect layer re-checks authorization before re-provisioning, so this
  // cannot leak another session's state to an unauthorized actor.
  if (existingSession) {
    const idleFor = now.getTime() - existingSession.lastActiveAt.getTime();
    if (idleFor >= idleTimeoutMs) {
      return { action: 'teardown', sandboxId: existingSession.sandboxId, reason: 'idle' };
    }
  }

  // Resume re-authz gate: deny before returning any warm (non-expired) sandbox, so
  // an unauthorized actor is never handed back another session's state.
  if (!authorization.ok) {
    return { action: 'deny', reason: authorization.reason };
  }

  if (!existingSession) {
    return { action: 'create' };
  }

  return { action: 'resume', sandboxId: existingSession.sandboxId };
}
