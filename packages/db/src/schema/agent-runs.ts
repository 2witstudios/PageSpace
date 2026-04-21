import { pgTable, text, timestamp, jsonb, integer, index, pgEnum, primaryKey, bigint } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { conversations, messages } from './conversations';

export const agentRunStatus = pgEnum('AgentRunStatus', [
  'pending',
  'streaming',
  'completed',
  'failed',
  'aborted',
]);

export const agentRunEventType = pgEnum('AgentRunEventType', [
  'text-segment',
  'tool-input',
  'tool-result',
  'metadata',
  'finish',
  'error',
  'aborted',
]);

export const agentRuns = pgTable('agent_runs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  ownerUserId: text('ownerUserId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  conversationId: text('conversationId').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  agentScope: text('agentScope', { enum: ['workspace', 'page'] }).notNull(),
  agentContextId: text('agentContextId'),
  parentMessageId: text('parentMessageId').references(() => messages.id, { onDelete: 'set null' }),
  status: agentRunStatus('status').notNull().default('pending'),
  modelConfig: jsonb('modelConfig').$type<{
    provider: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    enabledTools?: string[];
  }>().notNull(),
  lastSeq: integer('lastSeq').default(0).notNull(),
  tokenUsageInput: integer('tokenUsageInput').default(0).notNull(),
  tokenUsageOutput: integer('tokenUsageOutput').default(0).notNull(),
  costCents: bigint('costCents', { mode: 'number' }).default(0).notNull(),
  startedAt: timestamp('startedAt', { mode: 'date' }).defaultNow().notNull(),
  lastHeartbeatAt: timestamp('lastHeartbeatAt', { mode: 'date' }).defaultNow().notNull(),
  completedAt: timestamp('completedAt', { mode: 'date' }),
  errorMessage: text('errorMessage'),
}, (table) => ({
  conversationIdx: index('agent_runs_conversation_id_idx').on(table.conversationId),
  ownerIdx: index('agent_runs_owner_user_id_idx').on(table.ownerUserId),
  statusHeartbeatIdx: index('agent_runs_status_heartbeat_idx').on(table.status, table.lastHeartbeatAt),
  parentMessageIdx: index('agent_runs_parent_message_id_idx').on(table.parentMessageId),
}));

export const agentRunEvents = pgTable('agent_run_events', {
  runId: text('runId').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  type: agentRunEventType('type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.runId, table.seq] }),
  runCreatedIdx: index('agent_run_events_run_id_created_at_idx').on(table.runId, table.createdAt),
}));

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  owner: one(users, {
    fields: [agentRuns.ownerUserId],
    references: [users.id],
  }),
  conversation: one(conversations, {
    fields: [agentRuns.conversationId],
    references: [conversations.id],
  }),
  parentMessage: one(messages, {
    fields: [agentRuns.parentMessageId],
    references: [messages.id],
  }),
  events: many(agentRunEvents),
}));

export const agentRunEventsRelations = relations(agentRunEvents, ({ one }) => ({
  run: one(agentRuns, {
    fields: [agentRunEvents.runId],
    references: [agentRuns.id],
  }),
}));
