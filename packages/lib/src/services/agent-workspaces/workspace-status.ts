/**
 * Row → `SandboxStatus`, as a pure function (the ONE place the mapping exists).
 *
 * `contract.ts` defines the four states and what each MEANS; this module is the
 * single derivation of which one a stored row is in, so the list endpoint, the
 * single-session GET, and anything else that reports a session cannot each
 * invent their own reading of the same three columns.
 *
 * The semantics, restated against the columns that carry them:
 *
 *  - `'ended'` — the session was explicitly ended. Either stamp counts
 *    (`spriteTornDownAt` = a CONFIRMED kill, `endedAt` = the user's intent),
 *    because they land at different moments and a crash between them must still
 *    read as ended. Checked FIRST: an ended row still carries the `sandboxId` of
 *    the Sprite it used to own (that pointer is what a reclaim would need), so
 *    testing for a sandbox first would report a destroyed VM as running.
 *  - `'running'` — a Sprite is linked. This DELIBERATELY includes a hibernating
 *    one: idle Sprites hibernate and wake on demand, which is invisible to the
 *    user, so it is not a status of its own (and idleness never destroys — see
 *    `plan-workspace-lifecycle.ts`).
 *  - `'none'` — the session never acquired a Sprite. The common case: most
 *    conversations never touch one.
 *
 * `'starting'` is NOT derivable from a row and never returned here. Provisioning
 * happens INSIDE one `ensureAgentSessionSandbox` call — a row is written only
 * once a Sprite exists — so there is no persisted in-flight state to read. It is
 * a client-side transient: the UI shows it while its own ensure request is in
 * flight, and the answer that request returns is one of the three above.
 */

import type { SandboxStatus } from '../../agent-workspaces/session-contract';
import type { DriveEnvSpritePointers } from './agent-workspaces-store';

/** The only columns the status depends on — so any row shape can be classified. */
export interface SandboxStatusColumns {
  sandboxId: string | null;
  spriteTornDownAt: Date | null;
  endedAt: Date | null;
}

/**
 * An ENV-BOUND session reads its sandbox off the ENV's row, and this is the
 * whole of the difference.
 *
 * Such a session is CHECK-forbidden from holding Sprite pointers of its own
 * (`agent_workspaces_env_no_sprite_check`), so its own three columns say
 * "never provisioned" for its entire life no matter how live the machine it is
 * working on. Passing the env's pointers switches the reading to the row that
 * actually owns the VM.
 *
 * Two mappings are deliberate:
 *
 *  - **The session's `endedAt` still wins.** Ending a session is a fact about
 *    the session, and it is the only way an env-bound row can read `'ended'` —
 *    its `spriteTornDownAt` is structurally null.
 *  - **A torn-down ENV reads `'none'`, never `'ended'`.** `deriveDriveEnvStatus`
 *    calls that state `'stopped'`, but there is no such session status, and
 *    `'ended'` would tell the sidebar a live session had finished because
 *    somebody rebuilt the machine under it. `'none'` says what is actually
 *    true for the session: no live sandbox, and the next ensure provisions one
 *    — behaviorally identical to a session that never touched a Sprite.
 */
export function deriveSandboxStatus(
  row: SandboxStatusColumns,
  /**
   * The env's Sprite pointers when this session is env-bound; `null` for an
   * ordinary session that owns its own Sprite. An env-bound session whose env
   * could not be read (a delete racing the listing) also passes null, and
   * reads `'none'` — a machine we cannot see is not one to report as running.
   *
   * REQUIRED rather than optional, and that is the point: a default would let
   * a caller holding an env-bound row silently fall through to that row's
   * permanently-null Sprite columns and report a running machine as `'none'`.
   * A parameter that has to be answered makes every reader of a session say
   * which row they mean.
   */
  env: DriveEnvSpritePointers | null,
): SandboxStatus {
  if (row.spriteTornDownAt !== null || row.endedAt !== null) return 'ended';
  if (env !== null) {
    return env.spriteTornDownAt === null && env.sandboxId !== null ? 'running' : 'none';
  }
  if (row.sandboxId !== null) return 'running';
  return 'none';
}

/**
 * WHICH sandbox a session's work runs on — the ADDRESS of its machine, or null
 * when there is none.
 *
 * Anything that resolves a handle FROM A ROW needs this rather than
 * `row.sandboxId`: an env-bound session is CHECK-forbidden from holding a
 * pointer of its own, so that column reads null for its whole life however live
 * the machine it is working on. Reading it directly is a specific, quiet class
 * of bug — the caller concludes "no sandbox" and takes its nothing-to-do branch:
 * a shell close that skips `killSession` and drops the row anyway (leaving a PTY
 * on a SHARED, long-lived VM), or a file browser that reports `not_started`
 * against a running environment.
 *
 * **It deliberately does NOT consult `endedAt`, and that is the difference
 * between this and `deriveSandboxStatus`.** This answers "where is the
 * machine", which an ended session still needs answered: ending a session does
 * not kill an environment (that is the whole point of an environment), so the
 * PTYs it left behind are still running there and `killSessionShellById` must
 * still be able to reach them. An ended ORDINARY session resolves null anyway,
 * because ending one stamps `spriteTornDownAt` — so the two kinds agree without
 * this function having to know which it is looking at.
 *
 * "May this session still USE its machine" is a different question with a
 * different answer, and it is asked separately by the callers that need it —
 * `resolveSessionSandboxHandle` refuses an ended session outright, so the file,
 * diff and git-blob routes cannot read or write an environment's shared disk
 * under a session the UI reports as finished.
 *
 * `spriteTornDownAt` decides liveness for both kinds, because the pointer
 * deliberately outlives the VM.
 */
export function resolveLiveSandboxId(
  row: Pick<SandboxStatusColumns, 'sandboxId' | 'spriteTornDownAt'>,
  /** The env's pointers when the session is env-bound; `null` otherwise — same contract as `deriveSandboxStatus`. */
  env: DriveEnvSpritePointers | null,
): string | null {
  const holder = env ?? row;
  return holder.spriteTornDownAt === null ? holder.sandboxId : null;
}
