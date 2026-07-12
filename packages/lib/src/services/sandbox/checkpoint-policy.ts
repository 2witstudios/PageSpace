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
 * Pure core (this file): the throttle decision and the checkpoint's tagged
 * comment. IO — the actual SDK call, and where the per-sandbox bookkeeping is
 * read/written — lives in the shell (`tool-runners.ts`'s `SandboxCheckpointDeps`
 * seam, wired to the in-process state below by default).
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
 * In-process, per-sandbox checkpoint bookkeeping — mirrors `quota.ts`'s
 * `machineActivityByKey`: a plain Map, no persistence, no reaper. This is
 * intentionally NOT the platform's own checkpoint list (which the leaf
 * explicitly declines to reap — see the leaf spec's "rely on platform
 * auto-pruning" requirement); it only tracks enough to enforce the
 * at-most-once-per-turn throttle above. Scoped to the process lifetime: a
 * restart simply re-checkpoints on the next batch, which is harmless (COW,
 * ~300ms) and strictly safer than under-checkpointing.
 */
const stateBySandboxId = new Map<string, CheckpointState>();

/** Read the last-checkpoint bookkeeping for `sandboxId`, or the empty state if never recorded. */
export function getCheckpointState(sandboxId: string): CheckpointState {
  return stateBySandboxId.get(sandboxId) ?? EMPTY_STATE;
}

/** Record that `sandboxId` was just checkpointed for `lastCheckpointTurnId` at `lastCheckpointAt`. */
export function recordCheckpoint(sandboxId: string, state: CheckpointState): void {
  stateBySandboxId.set(sandboxId, state);
}

/** Clear all recorded checkpoint state. Test-only seam. */
export function resetCheckpointState(): void {
  stateBySandboxId.clear();
}
