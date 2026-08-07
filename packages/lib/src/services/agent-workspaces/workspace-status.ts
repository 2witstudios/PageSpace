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

import type { SandboxStatus } from '../../agent-workspaces/contract';

/** The only columns the status depends on — so any row shape can be classified. */
export interface SandboxStatusColumns {
  sandboxId: string | null;
  spriteTornDownAt: Date | null;
  endedAt: Date | null;
}

export function deriveSandboxStatus(row: SandboxStatusColumns): SandboxStatus {
  if (row.spriteTornDownAt !== null || row.endedAt !== null) return 'ended';
  if (row.sandboxId !== null) return 'running';
  return 'none';
}
