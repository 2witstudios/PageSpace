import { pgTable, text, timestamp, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { pages } from './core';
import { machineBranches } from './machine-branches';

/**
 * Machine Agent Terminals
 *
 * A named, pluggable-agent-typed PTY session running at one of the three
 * universal Terminal scopes (tasks/terminal.md): `machine` (the owning
 * Machine's OWN persistent Sprite, cwd = its home dir), `project` (the SAME
 * Machine Sprite, cwd = a cloned project's checkout), or `branch` (the
 * branch-terminal's OWN isolated Sprite, `machine_branches`). Isolation is by
 * Machine vs Branch — machine- and project-scoped agent terminals share the
 * owning Machine's Sprite; only a branch-scoped one gets a separate Sprite.
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
