import { pgTable, text, timestamp, boolean, bigint, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { pages } from './core';
import { conversations } from './conversations';

/**
 * Agent Sessions
 *
 * One row per conversation that has LAZILY acquired a sandbox. Most
 * conversations never touch one — no row exists until the first sandbox-using
 * tool call or the first shell open, and a session that never provisions is
 * simply a conversation with no row here.
 *
 * **sessionId ≡ conversationId**, which is why `conversationId` is the PRIMARY
 * KEY rather than a synthetic id beside a unique FK. A session and a
 * conversation are ONE object with two audiences: "session" is the backend word
 * (it owns a sandbox, it is the Sprite-key fold), "conversation" is the UI word
 * (what a user opens, `?c=` in the URL, what messages key on). Making the
 * conversation id the identity of this row is what makes a second
 * session-binding column impossible to add — there is nowhere to put one, and
 * the "which id?" question never arises. It also gives the 1:1 for free: a
 * conversation cannot accumulate two sandboxes.
 *
 * **Ids address, names label.** `name` is a display label with NO uniqueness
 * constraint of any kind — nothing ever looks a session up by it, so renaming
 * can never break a connection and two identically-named sessions are never
 * ambiguous. (Shell names do carry a uniqueness constraint, for unambiguous tab
 * titles only — see `agent_session_shells`.)
 *
 * `agentPageId` is NULLABLE: null means a global-assistant session, which has
 * no agent page to derive access or billing from — those paths fall back to
 * `ownerId`. It cascades off `pages` like every other page-scoped machine
 * table, so deleting the agent page takes its sessions with it (and the reclaim
 * trigger below rescues each one's Sprite pointer on the way out).
 *
 * The Sprite columns mirror `machine_agent_terminals` exactly — this table is
 * the thing that owns a sandbox now. The INVERSION versus that legacy model is
 * on the other side: `machine_agent_terminals` gave every PTY its own Sprite,
 * whereas here the SESSION owns the one Sprite and every shell in it shares
 * that filesystem (so `agent_session_shells` carries no Sprite columns at all).
 *
 * A killed session KEEPS its row: `end` stamps `teardownRequestedAt` /
 * `spriteTornDownAt` / `endedAt` and deletes nothing, so a later `ensure`
 * re-provisions under the SAME `sessionKey` — same name, same identity, fresh
 * filesystem. Idleness never destroys anything (Sprites hibernate on their own;
 * an idle VM costs bytes-written storage, not compute), so a row idle for years
 * still resumes.
 */
export const agentSessions = pgTable('agent_sessions', {
  /**
   * ≡ the conversation id. The session's whole identity: the tool address, the
   * `?c=` URL value, and the Sprite-key fold. Cascades so a deleted
   * conversation can never leave a session row — or a Sprite pointer — behind.
   */
  conversationId: text('conversationId')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),

  ownerId: text('ownerId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  /**
   * The AI_CHAT page this session belongs to, or NULL for a global-assistant
   * session (which has no page to derive access or billing from — both fall
   * back to `ownerId`).
   */
  agentPageId: text('agentPageId').references(() => pages.id, { onDelete: 'cascade' }),

  /** Display label only. Deliberately NOT unique and never an address. */
  name: text('name'),

  // ---------------------------------------------------------------------------
  // Per-session Sprite identity — the same column set `machine_agent_terminals`
  // carries, at the session tier. All NULLABLE: a row exists from the moment a
  // session is created, which is BEFORE (and possibly forever without) a Sprite,
  // and a torn-down session clears back toward this state while keeping its row.
  // ---------------------------------------------------------------------------

  /**
   * The opaque HMAC name this session's Sprite is provisioned under
   * (`deriveAgentSessionSpriteKey`, namespace `pgs-ses-`) — distinct per
   * session, so two sessions can never resolve to the same VM, and stable
   * across a replacement, which is what an identity CAS needs. NULL until first
   * provisioned.
   */
  sessionKey: text('sessionKey'),

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
   * is still reclaimable. NULL = nobody has asked for this Sprite to die. Same
   * marker semantics as `machine_agent_terminals.teardownRequestedAt`: the
   * orphan reconciler requires it before it destroys anything, since a mere
   * trash is reversible.
   */
  teardownRequestedAt: timestamp('teardownRequestedAt', { mode: 'date' }),

  /**
   * When this row's `sandboxId` Sprite was CONFIRMED destroyed. NULL = we
   * believe a live Sprite exists under `sandboxId`. The row OUTLIVES the Sprite
   * on purpose (see the table doc): a stamped row resolves as having no live
   * Sprite, and is re-provisionable under the same `sessionKey`.
   */
  spriteTornDownAt: timestamp('spriteTornDownAt', { mode: 'date' }),

  // ---------------------------------------------------------------------------
  // Storage attribution — the exact mirror of `machine_branches` /
  // `machine_agent_terminals`. A session's Sprite has its own persistent
  // filesystem, so it accrues storage cost independently; attribution resolves
  // to `agentPageId`, falling back to `ownerId` for a global-assistant session
  // that has no page.
  // ---------------------------------------------------------------------------

  /** Watermark for the storage reconcile — bill only the elapsed window, then advance, so overlapping runs never double-bill. Defaults to now() so a row never bills retroactively. */
  storageLastBilledAt: timestamp('storageLastBilledAt', { mode: 'date' }).defaultNow().notNull(),
  /** Measured used BYTES on this session Sprite's filesystem, captured while it is already awake — never by waking a hibernating Sprite. NULL = never measured. */
  storageMeasuredBytes: bigint('storageMeasuredBytes', { mode: 'number' }),
  /** When `storageMeasuredBytes` was captured — drives the measurement throttle and the reconcile's staleness signal. NULL alongside NULL bytes = never measured. */
  storageMeasuredAt: timestamp('storageMeasuredAt', { mode: 'date' }),

  /** Last time this session did anything a sandbox cared about. NULL = nothing since creation. Reported, never acted on — idleness does not destroy. */
  lastActiveAt: timestamp('lastActiveAt', { mode: 'date' }),
  /** Stamped when the session was EXPLICITLY ended; the row survives for re-provisioning. */
  endedAt: timestamp('endedAt', { mode: 'date' }),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  agentPageIdIdx: index('agent_sessions_agent_page_id_idx').on(table.agentPageId),
  ownerIdIdx: index('agent_sessions_owner_id_idx').on(table.ownerId),
}));

/**
 * Agent Session Shells
 *
 * A named PTY inside its session's sandbox. Every shell in a session shares
 * that ONE Sprite — the inversion versus `machine_agent_terminals`, where each
 * PTY owned a Sprite of its own. Hence this table carries NO Sprite columns and
 * NO storage columns: it has no VM to point at, no filesystem to measure, and
 * therefore nothing for a reclaim trigger to rescue (there is deliberately no
 * trigger on it). Killing a shell frees a process; the session's filesystem is
 * untouched.
 *
 * `id` IS the wire address — everything after the spawn addresses a shell by
 * `shellId` and nothing else, so the compound `(machineId, projectName,
 * branchName, name)` tuple the predecessor resolved against has no successor
 * here. `sessionId` FKs the owning session's `conversationId` (the session's
 * only id), cascading so ending a conversation takes its shells with it.
 *
 * `name` is a tab label. The `(sessionId, name)` unique index exists ONLY so
 * two tabs in one session can't wear the same title — never for lookups, which
 * always go through `id`.
 *
 * `agentType` selects a PTY launch spec and is PTY-only by construction
 * (`'shell'` today; future PTY agent CLIs are added as entries). The legacy
 * `'pagespace'` chat-surface type has no successor: a session's chat surface is
 * the conversation itself.
 *
 * `command` is an OPTIONAL per-shell program override — run an arbitrary
 * command in the PTY instead of the agent type's default binary.
 * `streamSessionId` is the Sprite exec session id this shell's PTY was
 * created/reattached under, set LAZILY by the realtime PTY bridge on first
 * connect, so a row can exist with `streamSessionId: null` before anyone has
 * connected to it.
 *
 * `coldTail`/`coldTailAt`/`coldTailHasOutput` are the tail of the LAST DEAD
 * incarnation's scrollback — overwritten IN PLACE on every teardown, never
 * appended to, and null until the first one. `coldTailHasOutput` is carried
 * separately from `coldTail` being non-empty because a burst larger than the
 * ring leaves an EMPTY tail on a shell that was screaming output, and empty
 * must never be misread as silence.
 */
export const agentSessionShells = pgTable('agent_session_shells', {
  /** ≡ `shellId`, the wire address. The ONLY way anything addresses a shell. */
  id: text('id').primaryKey().$defaultFn(() => createId()),

  /** ≡ the conversation id of the owning session (`agent_sessions.conversationId`). */
  sessionId: text('sessionId')
    .notNull()
    .references(() => agentSessions.conversationId, { onDelete: 'cascade' }),

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
  streamSessionId: text('streamSessionId'),

  coldTail: text('coldTail'),
  coldTailAt: timestamp('coldTailAt', { mode: 'date' }),
  coldTailHasOutput: boolean('coldTailHasOutput').notNull().default(false),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  sessionIdIdx: index('agent_session_shells_session_id_idx').on(table.sessionId),
  sessionNameUnique: uniqueIndex('agent_session_shells_session_name_idx').on(table.sessionId, table.name),
}));

export const agentSessionsRelations = relations(agentSessions, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [agentSessions.conversationId],
    references: [conversations.id],
  }),
  owner: one(users, {
    fields: [agentSessions.ownerId],
    references: [users.id],
  }),
  agentPage: one(pages, {
    fields: [agentSessions.agentPageId],
    references: [pages.id],
  }),
  shells: many(agentSessionShells),
}));

export const agentSessionShellsRelations = relations(agentSessionShells, ({ one }) => ({
  session: one(agentSessions, {
    fields: [agentSessionShells.sessionId],
    references: [agentSessions.conversationId],
  }),
  owner: one(users, {
    fields: [agentSessionShells.ownerId],
    references: [users.id],
  }),
}));

export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;
export type AgentSessionShell = typeof agentSessionShells.$inferSelect;
export type NewAgentSessionShell = typeof agentSessionShells.$inferInsert;
