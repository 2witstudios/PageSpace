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
  sandboxStatus: sandboxStatusSchema,
  createdAt: isoTimestamp,
  lastActiveAt: isoTimestamp.nullable(),
  /** Stamped when the session ended; the row survives so its conversations stay readable history. */
  endedAt: isoTimestamp.nullable(),
});

export type AgentSessionDTO = z.infer<typeof agentSessionDtoSchema>;
