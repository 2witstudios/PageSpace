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
 *    data-bleed path, so an unauthorized actor is `deny`d EVEN WHEN a session
 *    already exists — the existing handle is never returned.
 *  - **Cleanup is unconditional.** On a session-end intent the plan is always
 *    `teardown`, regardless of authorization, so a revoked actor can never strand
 *    a warm sandbox. Authorization gates *use*, never *cleanup*.
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
  /**
   * Hard reclaim ceiling. A session untouched for longer than this is torn down
   * and re-provisioned — the only idle teardown. It is deliberately LONG: Sprites
   * hibernate when idle and wake on demand, so a normal multi-hour gap must
   * resume the hibernated VM (preserving its filesystem/process state), NOT
   * destroy it. This ceiling only reclaims genuinely abandoned sessions.
   */
  hardExpiryMs?: number;
  intent?: LifecycleIntent;
}

// 24 hours: well beyond any plausible conversation gap. Within this window an
// idle session RESUMES (the platform hibernated the VM and wakes it on the next
// command); only a session abandoned for a full day is reclaimed.
const DEFAULT_HARD_EXPIRY_MS = 24 * 60 * 60 * 1000;

export function planSandboxLifecycle({
  authorization,
  existingSession = null,
  now,
  hardExpiryMs = DEFAULT_HARD_EXPIRY_MS,
  intent = 'run',
}: PlanLifecycleInput): SandboxLifecyclePlan {
  // Cleanup first, and unconditionally: an ending session is reclaimed whether
  // or not the current actor is still authorized.
  if (intent === 'end') {
    return existingSession
      ? { action: 'teardown', sandboxId: existingSession.sandboxId, reason: 'session_end' }
      : { action: 'noop' };
  }

  // Resume re-authz gate: deny before considering any existing warm sandbox, so
  // an unauthorized actor is never handed back another session's state. We do
  // NOT opportunistically reclaim an idle-expired session for a denied actor
  // here: that would either re-provision for an unauthorized caller (wrong) or
  // split this planner's single-action contract for marginal benefit. Idle
  // sessions of now-unauthorized actors are reclaimed by the durable idle reaper
  // (an enablement gate before flag-on), which is the reclaim path regardless of
  // who next touches the conversation.
  if (!authorization.ok) {
    return { action: 'deny', reason: authorization.reason };
  }

  if (!existingSession) {
    return { action: 'create' };
  }

  const idleFor = now.getTime() - existingSession.lastActiveAt.getTime();
  if (idleFor >= hardExpiryMs) {
    // Abandoned past the hard ceiling — reclaim and re-provision.
    return { action: 'teardown', sandboxId: existingSession.sandboxId, reason: 'idle' };
  }

  // Within the hard-expiry window: resume. A hibernated VM wakes on the next exec
  // (and the driver's per-op cold-start retry recovers a dropped first wake), so we
  // keep the session and its state rather than destroying a sleeping (near-free) VM.
  return { action: 'resume', sandboxId: existingSession.sandboxId };
}
