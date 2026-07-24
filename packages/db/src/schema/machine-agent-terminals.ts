import { pgTable, text, timestamp, boolean, bigint, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { pages } from './core';
import { machineBranches } from './machine-branches';

/**
 * Machine Agent Terminals
 *
 * A named, pluggable-agent-typed PTY session running at one of the three
 * universal Terminal scopes (tasks/terminal.md): `machine`, `project`, or
 * `branch`. EACH spawned session gets its OWN, SEPARATE Sprite — provisioned
 * at spawn under `sessionKey` (`deriveAgentTerminalSessionSpriteKey`) and
 * recorded on THIS row's own `sandboxId`/`spriteInstanceId`, exactly the way
 * `machine_branches` records a branch-terminal's Sprite. Two agent terminals
 * spawned at the same location are therefore two distinct Sprites, never a
 * shared filesystem. The credential login anchor stays the owning Machine's
 * root `machine_sessions` Sprite (where `claude login` happens); each session
 * Sprite gets a COPY propagated from it (`propagateClaudeCredential`). The
 * working directory per scope is the home dir / SANDBOX_ROOT (`machine`), the
 * project checkout at PROJECT_REPO_PATH (`project`), or the branch checkout at
 * BRANCH_REPO_PATH (`branch`). Legacy rows created before this migration have a
 * NULL `sandboxId` and fall back to the pre-per-session shared-Sprite
 * resolution until they are next respawned.
 *
 * `scope` is an EXPLICIT discriminant — `'machine' | 'project' | 'branch'` —
 * mirroring PurePoint's `AgentLocation::Root`/`AgentLocation::Worktree`
 * (`crates/pu-core/src/types/manifest.rs`): a caller (or a query) can read a
 * row's scope directly rather than re-deriving a union from a nullable-column
 * bag. It is set exactly once at creation (by
 * `deriveAgentTerminalScope`/`services/machines/agent-terminals-store.ts`,
 * the single write path — see `agent-terminals.ts`'s `spawnAgentTerminal`)
 * and never changes: `machine` ↔ both `projectName`/`machineBranchId` null,
 * `project` ↔ only `projectName` set, `branch` ↔ `machineBranchId` set.
 * `machineBranchId` implies its `projectName` (a branch always belongs to a
 * project), but `projectName` is stored redundantly alongside it rather than
 * requiring a join through `machine_branches` to resolve a branch-scoped
 * row's project — the same denormalization `machine_branches` itself uses
 * against `machine_projects`.
 *
 * Addressed by (machineId, projectName, machineBranchId, name) for
 * spawn/list, or by the row's OWN `id` alone for attach/kill — level-agnostic,
 * exactly like PurePoint's `Attach{agent_id}` (no scope path required to
 * resolve an existing agent terminal's Sprite once you have its id). A
 * machine can have at most one agent terminal named `name` per scope,
 * enforced by `machine_agent_terminals_scope_name_idx` (coalescing the two
 * nullable scope columns so two NULLs still collide as the SAME machine
 * scope, which a plain multi-column unique index would not do — Postgres
 * treats NULL <> NULL).
 *
 * `agentType` selects a pluggable launch spec (binary + args — see
 * `services/machines/agent-terminal-types.ts`; adapters for `claude`/`codex`,
 * and `shell` — a bare interactive shell is just a machine-scope agent
 * terminal of this type, not a separate concept).
 * `command` is an OPTIONAL per-terminal program override — an agent terminal
 * can run an arbitrary command in its PTY instead of `agentType`'s default
 * binary (mirrors PurePoint's `AgentEntry.command`). `streamSessionId` is the
 * Sprite exec session id this agent terminal's PTY was created/reattached
 * under — set lazily by the realtime PTY bridge on first connect (mirrors how
 * `machine_sessions` never eagerly opens a shell either), so a row can exist
 * with `streamSessionId: null` before anyone has connected to it yet.
 *
 * `coldTail`/`coldTailAt`/`coldTailHasOutput` (issue #2205) are the tail of the
 * LAST DEAD incarnation's scrollback — overwritten IN PLACE by
 * `recordColdTail` on every teardown, never appended to. `coldTail` is null
 * until the first teardown, and capped at
 * `MAX_SCROLLBACK_TAIL_BYTES` (`services/machines/session-scrollback.ts`).
 * `coldTailHasOutput` is carried separately from `coldTail` being non-empty
 * for the same reason `TerminalSession.hasOutput` is: a burst larger than the
 * ring leaves an EMPTY tail on a session that was screaming output, and empty
 * must never be misread as silence.
 */
export const machineAgentTerminals = pgTable('machine_agent_terminals', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  ownerId: text('ownerId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  machineId: text('machineId')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),

  scope: text('scope').notNull(),
  projectName: text('projectName'),
  machineBranchId: text('machineBranchId').references(() => machineBranches.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  agentType: text('agentType').notNull(),
  command: text('command'),
  streamSessionId: text('streamSessionId'),

  // ---------------------------------------------------------------------------
  // Per-session Sprite identity — the direct mirror of `machine_branches`'
  // per-Sprite columns. Every spawned session gets its OWN Sprite (see the
  // table doc); these columns are how a row points at, reconnects to, and tears
  // down that Sprite. All NULLABLE: legacy rows predating per-session Sprites
  // carry NULLs and resolve via the shared-Sprite fallback until respawned.
  // ---------------------------------------------------------------------------

  /**
   * The opaque HMAC name this session's Sprite is provisioned under
   * (`deriveAgentTerminalSessionSpriteKey`) — distinct per row (folds the
   * terminal's own id), so two sessions never resolve to the same Sprite. NULL
   * on legacy rows.
   */
  sessionKey: text('sessionKey'),

  /** The Sprite's NAME (reused across re-creates) — see `spriteInstanceId` for the actual identity. NULL until first provisioned. */
  sandboxId: text('sandboxId'),

  /**
   * The platform's id for the Sprite INSTANCE this row points at — the VM's
   * actual identity. NULL for legacy/unprovisioned rows. Comparing `sandboxId`
   * cannot distinguish a replacement Sprite from the one we meant to act on
   * (same name), so every teardown CAS keys on this.
   */
  spriteInstanceId: text('spriteInstanceId'),

  /** Proof of the egress lockdown confirmed for THIS session's VM, handed back on the next provision — see `machine_branches`/`egress-lockdown.ts`. NULL when unproven. */
  egressPolicyToken: text('egressPolicyToken'),

  /**
   * When a teardown of this session's Sprite was REQUESTED (`deleteMachine`
   * ran). NULL = nobody has asked for this Sprite to die. Same intent-marker
   * semantics as `machine_branches.teardownRequestedAt` — the orphan reconciler
   * requires it before it destroys anything, since a mere trash is reversible.
   */
  teardownRequestedAt: timestamp('teardownRequestedAt', { mode: 'date' }),

  /**
   * When this row's `sandboxId` Sprite was CONFIRMED destroyed. NULL = we
   * believe a live Sprite exists under `sandboxId`. A CONFIRMED-gone row keeps
   * its columns (the row is dropped by its own kill path or FK-cascade), but a
   * resolve treats a stamped row as having no live Sprite. Mirrors
   * `machine_branches.spriteTornDownAt`.
   */
  spriteTornDownAt: timestamp('spriteTornDownAt', { mode: 'date' }),

  // ---------------------------------------------------------------------------
  // Storage attribution — the exact mirror of `machine_branches`' columns. A
  // per-session Sprite has its own persistent filesystem, so it accrues storage
  // cost independently; attribution bills to the owning Machine page. Present
  // for schema parity with the branch tier; the reconcile wiring is a follow-up.
  // ---------------------------------------------------------------------------
  storageLastBilledAt: timestamp('storageLastBilledAt', { mode: 'date' }).defaultNow().notNull(),
  storageMeasuredBytes: bigint('storageMeasuredBytes', { mode: 'number' }),
  storageMeasuredAt: timestamp('storageMeasuredAt', { mode: 'date' }),

  coldTail: text('coldTail'),
  coldTailAt: timestamp('coldTailAt', { mode: 'date' }),
  coldTailHasOutput: boolean('coldTailHasOutput').notNull().default(false),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  machineIdIdx: index('machine_agent_terminals_machine_id_idx').on(table.machineId),
  machineBranchIdIdx: index('machine_agent_terminals_branch_id_idx').on(table.machineBranchId),
  scopeNameUnique: uniqueIndex('machine_agent_terminals_scope_name_idx').on(
    table.machineId,
    sql`coalesce(${table.projectName}, '')`,
    sql`coalesce(${table.machineBranchId}, '')`,
    table.name,
  ),
}));

export const machineAgentTerminalsRelations = relations(machineAgentTerminals, ({ one }) => ({
  owner: one(users, {
    fields: [machineAgentTerminals.ownerId],
    references: [users.id],
  }),
  machine: one(pages, {
    fields: [machineAgentTerminals.machineId],
    references: [pages.id],
  }),
  branch: one(machineBranches, {
    fields: [machineAgentTerminals.machineBranchId],
    references: [machineBranches.id],
  }),
}));

export type MachineAgentTerminal = typeof machineAgentTerminals.$inferSelect;
export type NewMachineAgentTerminal = typeof machineAgentTerminals.$inferInsert;
