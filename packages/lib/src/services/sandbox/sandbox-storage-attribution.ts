/**
 * Storage attribution key — the ONE place that answers "whose bill does an
 * agent-session Sprite's persistent filesystem land on?".
 *
 * Narrowed by the Phase 8 teardown: this used to arbitrate FIVE subject kinds
 * — a Machine's own Sprite, a branch-terminal's, a promoted project's, a
 * per-session agent-terminal's, and an `agent_sessions` row's — one per tier
 * of the deleted Machine page type's tree, all unconditionally attributed to
 * an owning Machine page. Only the `agent_sessions` kind survives, and under
 * the un-conflated model a session is not page-anchored AT ALL: it is a
 * drive-level workspace, so the bill lands on the DRIVE's owner (`driveId`
 * set), or on the session's own `ownerId` for a user-scoped global-assistant
 * session (`driveId` null) — the payer of last resort, with no lookup at all
 * (mirrors `resolveSessionPayerId` in `billing/sandbox-payer.ts`, which
 * applies the same rule at charge time — both the runtime and storage charge
 * streams bill one payer for one session — with one deliberate difference: it
 * falls back to the session owner on a failed drive lookup, where the storage
 * reconcile skips instead).
 */

/** A billable agent-session Sprite. */
export interface StorageSubject {
  /** The `agent_sessions` row's own id. */
  sessionId: string;
  /** The session's drive; null for a user-scoped global-assistant session. */
  driveId: string | null;
  /** The session's own owner — the payer of last resort, and the ONLY payer when `driveId` is null. */
  ownerId: string;
}

/**
 * Who ultimately gets billed for a subject's storage. A drive-scoped session
 * bills its drive's owner; a global-assistant session (null `driveId`) has no
 * drive, so billing falls straight through to its `ownerId` with no lookup at
 * all (mirrors `resolveSessionPayerId` in `billing/sandbox-payer.ts`, which
 * the storage reconcile's IO composition uses for the `ownerId` case, and
 * which the runtime billing seam now uses for the SAME session-level rule).
 */
export function storageBillingTarget(subject: StorageSubject): { driveId: string } | { ownerId: string } {
  return subject.driveId ? { driveId: subject.driveId } : { ownerId: subject.ownerId };
}
