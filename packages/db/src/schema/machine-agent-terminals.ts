import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { machineBranches } from './machine-branches';

/**
 * Machine Agent Terminals
 *
 * The "Runtime" tier of the Terminal workspace navigator (Machine → Projects →
 * Branches → Runtime). An agent terminal is a named, pluggable-agent-typed PTY
 * session running INSIDE one branch-terminal's own Sprite (`machine_branches`)
 * — NOT a separate Sprite. A branch's Sprite can host many concurrent agent
 * terminals (e.g. a `pagespace-cli` one and a `claude` one side by side),
 * addressed by (machineBranchId, name).
 *
 * `agentType` selects a pluggable launch spec (binary + args — see
 * `services/machines/agent-terminal-types.ts`; first-party `pagespace-cli`,
 * adapters for `claude`/`codex`). `streamSessionId` is the Sprite exec
 * session id this agent terminal's PTY was created/reattached under — set
 * lazily by the realtime PTY bridge on first connect (mirrors how
 * `terminal_sessions` never eagerly opens a shell either), so a row can exist
 * with `streamSessionId: null` before anyone has connected to it yet.
 */
export const machineAgentTerminals = pgTable('machine_agent_terminals', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  ownerId: text('ownerId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  machineBranchId: text('machineBranchId')
    .notNull()
    .references(() => machineBranches.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  agentType: text('agentType').notNull(),
  streamSessionId: text('streamSessionId'),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  machineBranchIdIdx: index('machine_agent_terminals_branch_id_idx').on(table.machineBranchId),
  machineBranchNameUnique: uniqueIndex('machine_agent_terminals_branch_name_idx').on(
    table.machineBranchId,
    table.name,
  ),
}));

export const machineAgentTerminalsRelations = relations(machineAgentTerminals, ({ one }) => ({
  owner: one(users, {
    fields: [machineAgentTerminals.ownerId],
    references: [users.id],
  }),
  branch: one(machineBranches, {
    fields: [machineAgentTerminals.machineBranchId],
    references: [machineBranches.id],
  }),
}));

export type MachineAgentTerminal = typeof machineAgentTerminals.$inferSelect;
export type NewMachineAgentTerminal = typeof machineAgentTerminals.$inferInsert;
