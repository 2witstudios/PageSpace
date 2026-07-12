/**
 * Checkpoint-before-agent-batch policy (Sprites Platform Alignment 5-2).
 *
 * Checkpoints are ~300ms copy-on-write filesystem snapshots
 * (docs.sprites.dev/concepts/checkpoints), designed for exactly this: a safety
 * net before destructive, unattended agent bash batches. `sprites.ts`'s own
 * `spawnWithSelfHealingCwd` doc already worries that "an agent that `rm -rf`s
 * /workspace would otherwise brick every later command" — a checkpoint turns
 * that from a bricked machine into a restore (restore itself is a separate,
 * manual/admin action; this leaf only creates the safety net, never uses it).
 *
 * Pure core (this file): the throttle decision (`shouldCheckpoint`) and the
 * checkpoint's tagged comment (`checkpointComment`). The rest of this file is
 * in-process, stateful bookkeeping (the per-sandbox state map + the
 * concurrent-attempt coalescing below it) — still no IO of its own, but not
 * pure either. The actual SDK call lives in the shell
 * (`tool-runners.ts`'s `SandboxCheckpointDeps` seam, wired to the state below
 * by default).
 */

/** Recognizable prefix for a pre-batch checkpoint's comment, so a human browsing
 *  `sprite checkpoint list` can tell an agent-safety checkpoint from a manual one. */
const CHECKPOINT_COMMENT_PREFIX = 'pagespace-pre-agent-';

/** Pure: the tagged comment for a pre-batch checkpoint taken during `turnId`. */
export function checkpointComment(turnId: string): string {
  return `${CHECKPOINT_COMMENT_PREFIX}${turnId}`;
}

/**
 * Pure: resolve the checkpoint-before-agent-batch flag from its raw env value
 * + NODE_ENV. Explicit 'true'/'false' always wins. Unset defaults ON outside
 * production (dev/test/staging get the safety net by default) and OFF in
 * production — the leaf spec explicitly defers the production default to PR
 * discussion; flip `SANDBOX_CHECKPOINT_BEFORE_AGENT_BATCH=true` to enable it
 * in prod once that's decided, with no code change needed.
 */
export function resolveCheckpointFlag({
  rawEnvValue,
  nodeEnv,
}: {
  rawEnvValue: string | undefined;
  nodeEnv: string | undefined;
}): boolean {
  if (rawEnvValue === 'true') return true;
  if (rawEnvValue === 'false') return false;
  return nodeEnv !== 'production';
}

/** The real flag read, wired to `process.env`. */
export function isCheckpointBeforeAgentBatchEnabled(): boolean {
  return resolveCheckpointFlag({
    rawEnvValue: process.env.SANDBOX_CHECKPOINT_BEFORE_AGENT_BATCH,
    nodeEnv: process.env.NODE_ENV,
  });
}

export interface ShouldCheckpointInput {
  /** The feature flag, re-checked fresh per batch. */
  flagEnabled: boolean;
  /** Stable id for the CURRENT agent turn (one streamText run). */
  turnId: string;
  /** The turnId the last checkpoint was taken for, or null if never checkpointed. */
  lastCheckpointTurnId: string | null;
}

/**
 * Pure: should a pre-batch checkpoint be taken right now?
 *
 * - Flag off → never.
 * - Same turnId as the last checkpoint → never (at most once per agent turn;
 *   repeated tool batches within one turn must not pile up checkpoints).
 * - A DIFFERENT turnId → always yes. There is deliberately NO additional
 *   time-based throttle here: an earlier revision added one (a floor between
 *   checkpoints regardless of turn, meant as a backstop against a hypothetical
 *   caller bug that regenerates turnId too eagerly) — but since this function
 *   only ever remembers the SINGLE most recent turnId, a turnId that differs
 *   from it is BY DEFINITION a turn that has never been checkpointed. Skipping
 *   it because a prior, different turn was checkpointed moments ago silently
 *   drops the very safety net this exists for: two legitimate turns close
 *   together (an ordinary rapid back-and-forth) would leave only the OLDER
 *   turn's checkpoint on record, so a later restore would discard the newer
 *   turn's real work along with whatever it was trying to undo. Do not
 *   reintroduce a cross-turn interval gate without solving that.
 */
export function shouldCheckpoint({
  flagEnabled,
  turnId,
  lastCheckpointTurnId,
}: ShouldCheckpointInput): boolean {
  if (!flagEnabled) return false;
  return turnId !== lastCheckpointTurnId;
}

export interface CheckpointState {
  lastCheckpointAt: Date | null;
  lastCheckpointTurnId: string | null;
}

const EMPTY_STATE: CheckpointState = { lastCheckpointAt: null, lastCheckpointTurnId: null };

/**
 * In-process, per-sandbox checkpoint bookkeeping — a plain Map, no
 * persistence. This is intentionally NOT the platform's own checkpoint list
 * (which the leaf explicitly declines to reap — see the leaf spec's "rely on
 * platform auto-pruning" requirement); it only tracks enough to enforce the
 * at-most-once-per-turn throttle above. Scoped to the process lifetime: a
 * restart simply re-checkpoints on the next batch, which is harmless (COW,
 * ~300ms) and strictly safer than under-checkpointing.
 */
const stateBySandboxId = new Map<string, CheckpointState>();

/**
 * How long a sandbox's checkpoint bookkeeping may sit unused before an
 * opportunistic sweep reclaims it — mirrors `quota.ts`'s
 * `evictStaleMachineActivity`/`MACHINE_ACTIVITY_GRACE_MS` pattern (this map
 * has no symmetric acquire/release either, so eviction has to be
 * opportunistic). Sandboxes are long-lived and reused across many turns, so
 * this is deliberately generous — the only failure mode of evicting too
 * early is one harmless redundant checkpoint on the next batch (same
 * "re-checkpointing after a restart is safe" property documented above),
 * never a missed one.
 */
const CHECKPOINT_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Opportunistic sweep: drop any entry whose last checkpoint is older than
 * `CHECKPOINT_STATE_TTL_MS`, so the map is bounded by recently-active
 * sandboxes rather than every sandbox ever checkpointed in this process's
 * lifetime. Run from `recordCheckpoint`, using ITS `now` as the reference
 * instant — every real checkpoint is a natural opportunity to reclaim other
 * long-idle entries.
 */
function evictStaleCheckpointState(now: Date): void {
  for (const [sandboxId, state] of stateBySandboxId) {
    if (state.lastCheckpointAt !== null && now.getTime() - state.lastCheckpointAt.getTime() > CHECKPOINT_STATE_TTL_MS) {
      stateBySandboxId.delete(sandboxId);
    }
  }
}

/** Read the last-checkpoint bookkeeping for `sandboxId`, or the empty state if never recorded. */
export function getCheckpointState(sandboxId: string): CheckpointState {
  return stateBySandboxId.get(sandboxId) ?? EMPTY_STATE;
}

/** Record that `sandboxId` was just checkpointed for `lastCheckpointTurnId` at `lastCheckpointAt`. */
export function recordCheckpoint(sandboxId: string, state: CheckpointState): void {
  if (state.lastCheckpointAt !== null) evictStaleCheckpointState(state.lastCheckpointAt);
  stateBySandboxId.set(sandboxId, state);
}

const inFlightBySandboxId = new Map<string, Promise<void>>();

/**
 * Coalesce concurrent checkpoint attempts for the SAME sandbox onto a single
 * in-flight promise.
 *
 * The AI SDK can execute multiple tool calls from one agent step
 * concurrently, so two bash calls in the same turn can both pass
 * `shouldCheckpoint`'s synchronous check before either finishes its
 * checkpoint — without this, both would independently call the checkpoint
 * SDK, producing two checkpoints for one turn (a real regression found in
 * review on PR #2025). `attempt`'s registration in `inFlightBySandboxId`
 * happens SYNCHRONOUSLY relative to the caller (no `await` before the
 * `.set()` below), so whichever concurrent caller's synchronous call stack
 * reaches this function first always wins the registration, and every other
 * concurrent caller for the same sandbox reuses that SAME promise instead of
 * starting a redundant attempt — closing the check-then-act race regardless
 * of exact timing between callers. The entry is removed once `attempt`
 * settles (success OR failure), so the next, non-overlapping attempt starts
 * fresh rather than being permanently coalesced onto a long-dead promise.
 */
export function coalesceCheckpointAttempt(sandboxId: string, attempt: () => Promise<void>): Promise<void> {
  const existing = inFlightBySandboxId.get(sandboxId);
  if (existing) return existing;
  const promise = attempt().finally(() => {
    if (inFlightBySandboxId.get(sandboxId) === promise) inFlightBySandboxId.delete(sandboxId);
  });
  inFlightBySandboxId.set(sandboxId, promise);
  return promise;
}

/** Clear all recorded checkpoint state (including in-flight coalescing). Test-only seam. */
export function resetCheckpointState(): void {
  stateBySandboxId.clear();
  inFlightBySandboxId.clear();
}
