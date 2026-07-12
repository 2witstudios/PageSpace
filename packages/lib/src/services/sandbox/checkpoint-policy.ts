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

/** Parse a non-negative integer env override; fall back on absence/garbage (mirrors machine-storage-measure.ts). */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return fallback;
  return Number.parseInt(raw, 10);
}

/**
 * Safety-net floor between two pre-batch checkpoints on the SAME sandbox, even
 * across DIFFERENT turns. The primary gate is "at most once per turn" (the
 * `turnId` comparison below); this additionally bounds checkpoint frequency if
 * turns are somehow generated in a tight loop (a caller bug, or a future turn
 * boundary that turns out to be finer-grained than intended) — a checkpoint is
 * cheap (~300ms, COW) but not free, and this keeps a runaway loop from hammering
 * the checkpoint API. Env-tunable; default well under any real agent turn's
 * cadence.
 */
export const CHECKPOINT_MIN_INTERVAL_MS = envInt('SANDBOX_CHECKPOINT_MIN_INTERVAL_MS', 30_000);

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
  /** When this sandbox was last checkpointed by this policy, or null if never. */
  lastCheckpointAt: Date | null;
  /** Stable id for the CURRENT agent turn (one streamText run). */
  turnId: string;
  /** The turnId the last checkpoint was taken for, or null if never checkpointed. */
  lastCheckpointTurnId: string | null;
  now: Date;
}

/**
 * Pure: should a pre-batch checkpoint be taken right now?
 *
 * - Flag off → never.
 * - Same turnId as the last checkpoint → never (at most once per agent turn;
 *   repeated tool batches within one turn must not pile up checkpoints).
 * - Otherwise → yes, UNLESS the last checkpoint (for a different, presumably
 *   fast-preceding turn) is still inside `CHECKPOINT_MIN_INTERVAL_MS` — the
 *   throttle safety net documented above.
 */
export function shouldCheckpoint({
  flagEnabled,
  lastCheckpointAt,
  turnId,
  lastCheckpointTurnId,
  now,
}: ShouldCheckpointInput): boolean {
  if (!flagEnabled) return false;
  if (lastCheckpointTurnId === turnId) return false;
  if (lastCheckpointAt !== null && now.getTime() - lastCheckpointAt.getTime() < CHECKPOINT_MIN_INTERVAL_MS) {
    return false;
  }
  return true;
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
