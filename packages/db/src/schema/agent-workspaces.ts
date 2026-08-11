import { pgTable, text, timestamp, boolean, bigint, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives } from './core';

/**
 * Agent Sessions
 *
 * A session is a WORKING CONTEXT: a drive-level workspace that owns one sandbox
 * and hosts many conversations (with any of the drive's agents, or the global
 * assistant) plus any number of shells. It is the successor to the old Machine
 * in exactly one respect — the environment is primary, and what runs inside it
 * (chats, PTYs) lives inside it — while keeping everything the machine model
 * got wrong out: no git topology, no project/branch tiers, lazy provisioning.
 *
 * **A session is NOT a conversation.** The first cut of this table conflated
 * them: `conversationId` was the PRIMARY KEY and the Sprite name was folded
 * from it, which forced one environment per chat thread and made it
 * structurally impossible for two conversations to share a working context
 * (it is why panes could not share a sandbox). A session and a conversation
 * have different lifecycles and a genuine one-to-many relationship: a thread's
 * membership is a node in `agent_workspace_nodes` whose `rootId` is this row,
 * so a thread's history and its filesystem always agree. Moving a thread
 * elsewhere is a FORK (a new node in another tree), never a rebind (a
 * retroactive mutation).
 *
 * That membership USED to be `conversations.workspaceId`, a FK pointing here,
 * with pane rows saying separately where the thread appeared on screen. Two
 * structures for one fact; the column and the pane tables were dropped at
 * migration 0256 and the node tree is now the only record of either.
 *
 * **A session is born non-empty, and stays open until it is ended.** It is born
 * with its first conversation (spawning a session spawns an agent). It is NOT
 * ended by its last pane going away: closing the last pane leaves the session
 * open holding an empty tree, and ending is its own act aimed at the session
 * (`endedAt`), so closing something can never end more than was asked. An
 * earlier cut of this docblock claimed the reverse, and the reclaim machinery
 * must not assume a live session holds at least one node.
 *
 * **Ids address, names label.** `name` is a display label with NO uniqueness
 * constraint of any kind — nothing ever looks a session up by it, so renaming
 * can never break a connection and two identically-named sessions are never
 * ambiguous. (Shell names do carry a uniqueness constraint, for unambiguous
 * tab titles only — see `agent_workspace_shells`.)
 *
 * `driveId` is NULLABLE: null means a global-assistant session, which lives
 * outside any drive — access and billing fall back to `ownerId` (the user is
 * their own isolation boundary, same rule as `resolveSandboxActorContext`).
 * There is deliberately NO `agentPageId` here: a session hosts conversations
 * with MANY agents, so the agent association lives on each conversation
 * (`conversations.contextId`), never on the session.
 *
 * A killed session KEEPS its row: `end` stamps `teardownRequestedAt` /
 * `spriteTornDownAt` / `endedAt` and deletes nothing, so its conversations
 * remain reachable as history. Idleness never destroys anything (Sprites
 * hibernate on their own; an idle VM costs bytes-written storage, not
 * compute), so a row idle for years still resumes.
 */
export const agentWorkspaces = pgTable('agent_workspaces', {
  /**
   * The session's own identity — the tool address, the `?session=` URL value,
   * and the Sprite-key fold. Deliberately NOT a conversation id: the sandbox's
   * name derives from this, so every conversation and shell in the session
   * resolves the same sandbox BY CONSTRUCTION.
   */
  id: text('id').primaryKey().$defaultFn(() => createId()),

  /**
   * The drive this workspace belongs to, or NULL for a global-assistant
   * session (user-scoped, no drive). Cascades: deleting a drive takes its
   * sessions with it, and the reclaim trigger rescues each Sprite pointer on
   * the way out.
   */
  driveId: text('driveId').references(() => drives.id, { onDelete: 'cascade' }),

  ownerId: text('ownerId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  /** Display label only (auto-named at spawn). Deliberately NOT unique and never an address. */
  name: text('name'),

  // The session's pane tree lives in `agent_workspace_nodes` behind
  // `agent_workspace_node_revs` — see `agent-workspace-nodes.ts`. It was a
  // `workspaceState` jsonb blob here, then four `agent_workspace_pane_*` /
  // `_layout_*` tables; all of it is gone, because a client-authored blob with
  // three writers, and then a grid reconciled with a membership column by
  // convention, are the same drift bug class stated twice.

  // ---------------------------------------------------------------------------
  // Per-session Sprite identity. All NULLABLE: a row exists from the moment a
  // session is spawned, which is BEFORE (and possibly forever without) a
  // Sprite, and a torn-down session clears back toward this state while
  // keeping its row.
  // ---------------------------------------------------------------------------

  /**
   * The opaque HMAC name this session's Sprite is provisioned under
   * (`deriveAgentSessionSpriteKey`, folded on `id`) — distinct per session, so
   * two sessions can never resolve to the same VM, and stable across a
   * replacement, which is what an identity CAS needs. NULL until first
   * provisioned.
   */
  spriteKey: text('spriteKey'),

  /** The Sprite's NAME (reused across re-creates) — see `spriteInstanceId` for the actual identity. NULL until first provisioned. */
  sandboxId: text('sandboxId'),

  /**
   * The platform's id for the Sprite INSTANCE this row points at — the VM's
   * actual identity. Comparing `sandboxId` cannot distinguish a replacement
   * Sprite from the one we meant to act on (same name), so every teardown CAS
   * keys on this. NULL when the platform reported none.
   */
  spriteInstanceId: text('spriteInstanceId'),

  /** Proof of the egress lockdown confirmed for THIS session's VM, handed back on the next provision. NULL when unproven. */
  egressPolicyToken: text('egressPolicyToken'),

  /**
   * Durable teardown INTENT — recorded BEFORE the kill so a crash mid-teardown
   * is still reclaimable. NULL = nobody has asked for this Sprite to die. The
   * orphan reconciler requires it before it destroys anything.
   */
  teardownRequestedAt: timestamp('teardownRequestedAt', { mode: 'date' }),

  /**
   * When this row's `sandboxId` Sprite was CONFIRMED destroyed. NULL = we
   * believe a live Sprite exists under `sandboxId`. The row OUTLIVES the
   * Sprite on purpose: a stamped row resolves as having no live Sprite, and
   * its conversations remain readable history.
   */
  spriteTornDownAt: timestamp('spriteTornDownAt', { mode: 'date' }),

  // ---------------------------------------------------------------------------
  // Storage attribution. A session's Sprite has its own persistent filesystem,
  // so it accrues storage cost independently; attribution resolves to the
  // drive's owner via `driveId`, falling back to `ownerId` for a
  // global-assistant session.
  // ---------------------------------------------------------------------------

  /** Watermark for the storage reconcile — bill only the elapsed window, then advance, so overlapping runs never double-bill. Defaults to now() so a row never bills retroactively. */
  storageLastBilledAt: timestamp('storageLastBilledAt', { mode: 'date' }).defaultNow().notNull(),
  /** Measured used BYTES on this session Sprite's filesystem, captured while it is already awake — never by waking a hibernating Sprite. NULL = never measured. */
  storageMeasuredBytes: bigint('storageMeasuredBytes', { mode: 'number' }),
  /** When `storageMeasuredBytes` was captured — drives the measurement throttle and the reconcile's staleness signal. NULL alongside NULL bytes = never measured. */
  storageMeasuredAt: timestamp('storageMeasuredAt', { mode: 'date' }),

  /** Last time this session did anything a sandbox cared about. NULL = nothing since creation. Reported, never acted on — idleness does not destroy. */
  lastActiveAt: timestamp('lastActiveAt', { mode: 'date' }),
  /** Stamped when the session ended (explicitly, or via its last pane closing); the row survives as history. */
  endedAt: timestamp('endedAt', { mode: 'date' }),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  driveIdIdx: index('agent_workspaces_drive_id_idx').on(table.driveId),
  ownerIdIdx: index('agent_workspaces_owner_id_idx').on(table.ownerId),
  // The cron scans this exact predicate (`sandbox-storage-billing.ts`,
  // `workspace-orphan-reconcile-runtime.ts`): "still believed live". A
  // partial index keeps it to the live slice rather than a seq scan over
  // every ended/never-provisioned row, which is the overwhelming majority at
  // any real scale.
  liveSpriteIdx: index('agent_workspaces_live_sprite_idx')
    .on(table.sandboxId, table.spriteTornDownAt)
    .where(sql`${table.sandboxId} IS NOT NULL AND ${table.spriteTornDownAt} IS NULL`),
}));

/**
 * Agent Session Shells
 *
 * A named PTY inside its session's sandbox. Every shell in a session shares
 * that ONE Sprite — hence this table carries NO Sprite columns and NO storage
 * columns: it has no VM to point at, no filesystem to measure, and therefore
 * nothing for a reclaim trigger to rescue (there is deliberately no trigger on
 * it). Killing a shell frees a process; the session's filesystem is untouched.
 *
 * `id` IS the wire address — everything after the spawn addresses a shell by
 * `shellId` and nothing else. `workspaceId` FKs the owning session, cascading so
 * ending a session takes its shells with it.
 *
 * `name` is a tab label. The `(workspaceId, name)` unique index exists ONLY so
 * two tabs in one session can't wear the same title — never for lookups, which
 * always go through `id`.
 *
 * `agentType` selects a PTY launch spec and is PTY-only by construction
 * (`'shell'` today; future PTY agent CLIs are added as entries). That is a
 * fact about THIS table — a chat surface is a conversation, which lives in
 * `conversations`, not here.
 *
 * `command` is an OPTIONAL per-shell program override — run an arbitrary
 * command in the PTY instead of the agent type's default binary.
 * `spriteExecId` is the Sprite exec session id this shell's PTY was
 * created/reattached under, set LAZILY by the realtime PTY bridge on first
 * connect, so a row can exist with `spriteExecId: null` before anyone has
 * connected to it.
 *
 * `coldTail`/`coldTailAt`/`coldTailHasOutput` are the tail of the LAST DEAD
 * incarnation's scrollback — overwritten IN PLACE on every teardown, never
 * appended to, and null until the first one. `coldTailHasOutput` is carried
 * separately from `coldTail` being non-empty because a burst larger than the
 * ring leaves an EMPTY tail on a shell that was screaming output, and empty
 * must never be misread as silence.
 */
export const agentWorkspaceShells = pgTable('agent_workspace_shells', {
  /** ≡ `shellId`, the wire address. The ONLY way anything addresses a shell. */
  id: text('id').primaryKey().$defaultFn(() => createId()),

  /** The owning session (`agent_workspaces.id`). */
  workspaceId: text('workspaceId')
    .notNull()
    .references(() => agentWorkspaces.id, { onDelete: 'cascade' }),

  ownerId: text('ownerId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  /** Tab label. Unique within a session for tab clarity — still not an address. */
  name: text('name').notNull(),
  /** PTY launch spec selector — `'shell'` today; PTY-only by construction. */
  agentType: text('agentType').notNull(),
  /** Optional per-shell program override; NULL runs the agent type's default binary. */
  command: text('command'),
  /** The Sprite exec session id this PTY was created/reattached under. NULL until the bridge's first connect. */
  spriteExecId: text('spriteExecId'),

  coldTail: text('coldTail'),
  coldTailAt: timestamp('coldTailAt', { mode: 'date' }),
  coldTailHasOutput: boolean('coldTailHasOutput').notNull().default(false),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  workspaceIdIdx: index('agent_workspace_shells_workspace_id_idx').on(table.workspaceId),
  workspaceNameUnique: uniqueIndex('agent_workspace_shells_workspace_name_idx').on(table.workspaceId, table.name),
}));

export const agentWorkspacesRelations = relations(agentWorkspaces, ({ one, many }) => ({
  drive: one(drives, {
    fields: [agentWorkspaces.driveId],
    references: [drives.id],
  }),
  owner: one(users, {
    fields: [agentWorkspaces.ownerId],
    references: [users.id],
  }),
  // NO `conversations: many(...)`. A workspace hosts threads, but the row that
  // says so is a node in `agent_workspace_nodes` (`targetKind = 'chat'`), not a
  // FK on `conversations` — that column was dropped at 0256. Membership is not
  // a relation Drizzle can infer, and asking it to would resurrect the second
  // structure this epic exists to delete.
  shells: many(agentWorkspaceShells),
}));

export const agentWorkspaceShellsRelations = relations(agentWorkspaceShells, ({ one }) => ({
  workspace: one(agentWorkspaces, {
    fields: [agentWorkspaceShells.workspaceId],
    references: [agentWorkspaces.id],
  }),
  owner: one(users, {
    fields: [agentWorkspaceShells.ownerId],
    references: [users.id],
  }),
}));

export type AgentWorkspace = typeof agentWorkspaces.$inferSelect;
export type NewAgentWorkspace = typeof agentWorkspaces.$inferInsert;
export type AgentWorkspaceShell = typeof agentWorkspaceShells.$inferSelect;
export type NewAgentWorkspaceShell = typeof agentWorkspaceShells.$inferInsert;
