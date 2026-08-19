/**
 * Deleting an environment, decided purely.
 *
 * An env delete is the one operation in this epic that destroys a SHARED
 * filesystem, and it has to answer three questions in a fixed order: is anyone
 * still working in here, is there a VM to kill, and only then may the row go.
 * All three are decided from facts a caller has already read — the env's pointer
 * columns, a live-session count, and the caller's `force` — so this module is a
 * pure function and the ordering it encodes is testable without a database, a
 * Sprite, or a clock.
 *
 * **Why the order is load-bearing.** `drive_envs` cascades to
 * `agent_workspaces.envId`, so DELETING THE ROW DELETES the sessions bound to
 * it. That is correct (an env owns its sessions) and it is also why the
 * live-session guard cannot be an afterthought at the end of the flow: by the
 * time the row is gone, the sessions someone was working in are gone with it.
 * The guard runs first, and `force` is the only thing that can pass it.
 *
 * **What the cascade CANNOT strand.** An env-bound session holds no Sprite
 * pointer of its own — `agent_workspaces_env_no_sprite_check` forbids it — so
 * cascading a session away can never orphan a VM, leave bytes unbilled, or hide
 * a machine from the reclaim outbox. The ONE Sprite in play is the env's own,
 * which is exactly what `teardown_then_delete` exists to kill before the row
 * (and its AFTER DELETE reclaim trigger) disappears.
 *
 * The verdicts, and nothing else:
 *
 *  - `deny_live_sessions` — sessions are still live in here and the caller did
 *    not force. Reports the count so the caller can say how many.
 *  - `teardown_then_delete` — the env believes it holds a live Sprite. Kill it
 *    (CAS on the instance) BEFORE the row goes, so the kill is confirmed by the
 *    thing that asked for it rather than left to the crash net.
 *  - `delete_only` — nothing to kill: never provisioned, or already torn down.
 *
 * A missing row is deliberately NOT a verdict here. "There is no such env" is a
 * lookup fact, not a deletion policy, and folding it in would make a 404 and a
 * refusal indistinguishable to the caller that has to choose a status code — the
 * same split `AgentSessionAccessCheck` draws around `session_not_found`.
 */

/** The env columns a delete decision reads. Pointers only; nothing derived, nothing named after a table. */
export interface DriveEnvDeleteRow {
  /** The env's own id — never read by the decision, carried so a verdict names the row it describes. */
  id: string;
  /** The Sprite name currently recorded; null = never provisioned. */
  sandboxId: string | null;
  /** WHICH VM, as opposed to which name it answers to. The teardown CAS keys on this. */
  spriteInstanceId: string | null;
  /** Stamped once a kill was CONFIRMED. Non-null = we do not believe a live Sprite exists. */
  spriteTornDownAt: Date | null;
}

export interface PlanEnvDeleteInput {
  row: DriveEnvDeleteRow;
  /**
   * Sessions still LIVE inside this env — not-ended rows carrying this `envId`.
   * Counted by the caller (`countLiveSessionsInEnv`) rather than derived here,
   * because it is a second table's fact.
   */
  liveSessionCount: number;
  /** The caller's explicit override of the live-session guard. Nothing else in this decision consults it. */
  force: boolean;
}

export type PlanEnvDeletePlan =
  /** Sessions are live and `force` was not given. The row and its Sprite are untouched. */
  | { action: 'deny_live_sessions'; liveSessionCount: number }
  /** Kill the env's Sprite (guarded by the instance the row records), then delete the row. */
  | { action: 'teardown_then_delete'; sandboxId: string; expectedInstanceId: string | null }
  /** No live Sprite to kill — delete the row. */
  | { action: 'delete_only' };

export function planEnvDelete({ row, liveSessionCount, force }: PlanEnvDeleteInput): PlanEnvDeletePlan {
  // FIRST, and before anything reads a pointer: the cascade that follows a row
  // delete takes live sessions with it, so this is the only moment the caller
  // can be told to stop.
  if (liveSessionCount > 0 && !force) {
    return { action: 'deny_live_sessions', liveSessionCount };
  }
  // "Believed live" is BOTH conditions, matching the partial index and every
  // other live-Sprite predicate in the epic: a teardown stamps
  // `spriteTornDownAt` and deliberately LEAVES `sandboxId` in place (the
  // pointer a reclaim would need), so testing the name alone would send every
  // already-torn-down env back through a kill of a VM that is already gone.
  if (row.sandboxId !== null && row.spriteTornDownAt === null) {
    return {
      action: 'teardown_then_delete',
      sandboxId: row.sandboxId,
      expectedInstanceId: row.spriteInstanceId,
    };
  }
  return { action: 'delete_only' };
}
