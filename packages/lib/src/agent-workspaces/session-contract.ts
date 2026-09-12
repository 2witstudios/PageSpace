/**
 * The SESSION half of the agent-workspace contract — a session's identity, its
 * sandbox lifecycle, the per-owner ceiling on active ones, and the DTO every
 * client is served. Shared by the web API routes, the realtime PTY bridge, and
 * the frontend hooks.
 *
 * Split out of `./contract`, which had grown to hold three unrelated concerns at
 * once (session identity, shells, and the old layout model) and so made a
 * boundary problem look like coupling. Shell and shell-bridge shapes are in
 * `./shells-contract`; what is left in `./contract` is the old layout model's
 * wire shape.
 *
 * The rule that governed the original module still governs this one: no shape in
 * this surface is ever declared twice. If a payload crosses a process boundary,
 * its schema lives here and every side parses with it.
 *
 * Two semantic invariants govern everything downstream — both concern session
 * identity, so this module is where they are written down once, for the split
 * contract as a whole:
 *
 * 1. **A session is NOT a conversation — it OWNS conversations.** A session is
 *    a drive-level workspace with its own id (`agent_workspaces.id`): it owns the
 *    one sandbox, its id is the Sprite-key fold, and it hosts MANY
 *    conversations (with any of the drive's agents, or the global assistant)
 *    plus any number of shells. `conversations.workspaceId` is the binding —
 *    nullable (a plain chat has no session) and write-once: set either at
 *    creation, or later by exactly one guarded claim of the caller's own
 *    still-unbound row (`apps/web/src/lib/agent-workspaces/claim-conversation-in-workspace.ts`).
 *    It never re-points an already-bound row — a thread moving to another
 *    session is a fork, never a rebind. A conversation-derived id must never
 *    become a session address again: the
 *    first cut had `workspaceId ≡ conversationId`, which forced one environment
 *    per chat thread and made it structurally impossible for two conversations
 *    to share a working context. The old "which id?" worry inverts cleanly:
 *    a DTO carries `workspaceId` when it means the workspace and
 *    `conversationId` when it means the thread, and the two are different
 *    kinds of thing, not two names for one. Sessions are USER-VISIBLE — the
 *    sidebar lists them — and the user-facing word is simply "session".
 *
 * 2. **Ids address, names label.** `workspaceId` and `shellId` are the addresses:
 *    every wire payload, every tool argument after the spawn, and every Sprite
 *    key folds one of them. `name` is a display label with no addressing role —
 *    session names carry no uniqueness constraint at all, and the
 *    shell-name uniqueness that does exist (`(workspaceId, name)`) is there for
 *    unambiguous tab titles, never for lookups. Renaming can therefore never
 *    break a connection, and two identically-named things are never ambiguous.
 */

import { z } from 'zod';

/**
 * The most NOT-ENDED workspaces (`agent_workspaces` rows) one owner may hold —
 * and, therefore, the most one listing ever returns. ONE constant on purpose
 * (epic Phase 1, D7): the spawn ceiling (`spawnAgentSession`'s required
 * `maxActiveSessions` dep — a per-owner advisory-locked count-and-insert, so
 * the cap is STRUCTURAL, not a pre-check) and the store's `list()` LIMIT used
 * to be two constants in two packages that had to stay equal by hand.
 * Because they are one number, a listing can never truncate an owner's real
 * set: no owner can HAVE more active workspaces than one page shows.
 * `listOwnWorkspaces`' post-cap exclusion (session-tools-runtime.ts) leans on
 * exactly that.
 */
export const MAX_ACTIVE_WORKSPACES_PER_OWNER = 100;

/**
 * Bound on a session's stored display label — it is rendered everywhere the
 * session appears (sidebar rows, listings, tool output).
 *
 * ONE constant, for the same reason `MAX_ACTIVE_WORKSPACES_PER_OWNER` above is
 * one: this used to live in the spawn route as a route-local literal, while
 * every other surface that accepts a name (the rename PATCH, the agent's
 * `rename_workspace` tool) would have had to restate it and keep it equal by
 * hand.
 *
 * Deliberately NOT the same number as `plan-spawn-worker.ts`'s own
 * `MAX_SESSION_NAME_LENGTH` (200), which bounds a WORKER's name — a
 * conversation title — not a workspace's. Two different objects, two bounds.
 */
export const MAX_SESSION_NAME_LENGTH = 120;

/**
 * A session name as accepted from ANY client — a human through the API, or an
 * agent through the tool surface. Trimmed first, then bounded, so
 * whitespace-only input is a refusal rather than a stored blank that renders
 * as the nameless fallback.
 *
 * A label, never an address (invariant 2): there is no uniqueness check here
 * and none in the store, so two sessions may hold the same name and a rename
 * can never break a connection.
 */
export const sessionNameSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(MAX_SESSION_NAME_LENGTH));

/** PATCH body for `/api/agent-workspaces/[workspaceId]` — the rename request. */
export const renameAgentSessionRequestSchema = z.object({ name: sessionNameSchema });
export type RenameAgentSessionRequest = z.infer<typeof renameAgentSessionRequestSchema>;

/**
 * A blank-name spawn's auto-label: the first collision-free of `base`,
 * `base 2`, `base 3`, … — starting at the bare label rather than always
 * suffixing a number, so no session is ever born "Agent 1".
 *
 * Shared BY DESIGN between the two spawn paths. The HTTP route has always
 * derived a label this way; the agent path (`spawn_session` with
 * `workspace: "new"`) did not, and wrote `null` instead — which is why an
 * agent-minted workspace rendered as the generic "Session" forever. Both call
 * this now, so a nameless workspace is no longer creatable from either side.
 *
 * Uniqueness here is COSMETIC, not structural: names carry no constraint, and
 * a collision would be legal — this only keeps a sidebar of ten sessions
 * readable.
 */
export function nextUniqueSessionName(base: string, existingNames: readonly string[]): string {
  const taken = new Set(existingNames);
  // LENGTH-AWARE, and the result is already bounded — callers must NOT truncate
  // it afterwards (review). Appending a suffix and letting the caller cut the
  // result back to the cap destroys the very thing the suffix was for: a
  // 120-character base yields "<base> 2", which truncates back to exactly
  // `base`, so every "unique" candidate collapses onto the name it was meant to
  // avoid and the loop hands back a duplicate. Room for the suffix has to be
  // made BEFORE the candidate is tested, not taken away after.
  const bounded = base.slice(0, MAX_SESSION_NAME_LENGTH);
  if (!taken.has(bounded)) return bounded;
  for (let index = 2; ; index += 1) {
    const suffix = ` ${index}`;
    const candidate = bounded.slice(0, MAX_SESSION_NAME_LENGTH - suffix.length) + suffix;
    // A pathological cap (shorter than the suffix itself) would make every
    // candidate identical; there is no such cap, and the slice above keeps the
    // result bounded regardless.
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The sandbox states the UI and tools discriminate between, and the ONLY four
 * that exist. `'none'` = the session has never acquired a Sprite (the common
 * case — most conversations never touch one); `'starting'` = provisioning is in
 * flight; `'running'` = a Sprite is linked (INCLUDING a hibernating one — idle
 * sandboxes hibernate and wake on demand, which is invisible to the user and so
 * is deliberately not a status of its own); `'ended'` = the session's Sprite was
 * explicitly torn down, the row retained and re-provisionable under the same key.
 */
export const SANDBOX_STATUSES = ['none', 'starting', 'running', 'ended'] as const;

export const sandboxStatusSchema = z.enum(SANDBOX_STATUSES);
export type SandboxStatus = z.infer<typeof sandboxStatusSchema>;

/**
 * Wire timestamps are ISO-8601 strings; `Date` never crosses the boundary.
 *
 * The same one-line primitive is declared in `./shells-contract`. Deliberately
 * duplicated rather than shared: it is a validator primitive, not a wire shape,
 * and making either concern import the other for one line would recreate the
 * cross-concern edge this split exists to remove.
 */
const isoTimestamp = z.string().datetime();

/**
 * One agent session as served to any client.
 *
 * `workspaceId` is the session's OWN id (invariant 1) — the workspace address,
 * never a conversation id. `driveId` is nullable: null means a
 * global-assistant session, which lives outside any drive — access and
 * billing fall back to `ownerId`. There is deliberately no agent field: a
 * session hosts conversations with MANY agents, so the agent association
 * lives on each conversation.
 */
export const agentSessionDtoSchema = z.object({
  /** `agent_workspaces.id` — the tool address, the `?workspace=` URL value, and the Sprite-key fold. */
  workspaceId: z.string().min(1),
  /**
   * @deprecated ROLLING-DEPLOY COMPAT, one release only. The identical value
   * under the pre-rename name, so a browser still running pre-rename JS during
   * the deploy window keeps working against the new server. Fly rolls
   * processor → realtime → web, so old and new web instances coexist for
   * minutes and a client can hold either bundle. The contract PR deletes this
   * field; nothing new may read it.
   */
  sessionId: z.string().min(1),
  /** The drive this workspace belongs to, or null for a global-assistant session. */
  driveId: z.string().min(1).nullable(),
  ownerId: z.string().min(1),
  /** Display label only — no uniqueness, never an address. */
  name: z.string(),
  /**
   * The persistent ENVIRONMENT this session runs inside, or null for the
   * ordinary ephemeral session that owns its own Sprite.
   *
   * Non-null changes what `sandboxStatus` below is a reading OF: an env-bound
   * session holds no Sprite pointer of its own (CHECK-enforced), so its status
   * is derived from the ENV's machine — which every session in that env shares,
   * along with its filesystem. Ending such a session therefore never stops a
   * machine, and two sessions carrying the same `envId` are two windows onto
   * one disk. A client that groups sessions by this field is grouping them by
   * the filesystem they see.
   */
  envId: z.string().min(1).nullable(),
  sandboxStatus: sandboxStatusSchema,
  createdAt: isoTimestamp,
  lastActiveAt: isoTimestamp.nullable(),
  /** Stamped when the session ended; the row survives so its conversations stay readable history. */
  endedAt: isoTimestamp.nullable(),
});

export type AgentSessionDTO = z.infer<typeof agentSessionDtoSchema>;
