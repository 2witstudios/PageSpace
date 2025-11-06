import { pgTable, text, timestamp, jsonb, integer, boolean, pgEnum, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives } from './core';

// Enums for workflow execution status
export const workflowExecutionStatus = pgEnum('WorkflowExecutionStatus', [
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled'
]);

export const workflowExecutionStepStatus = pgEnum('WorkflowExecutionStepStatus', [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped'
]);

// Workflow Templates - The blueprint for a workflow
export const workflowTemplates = pgTable('workflow_templates', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  description: text('description'),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  createdBy: text('createdBy').notNull().references(() => users.id, { onDelete: 'cascade' }),
  category: text('category'),
  tags: text('tags').array(),
  isPublic: boolean('isPublic').default(false).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    driveIdx: index('workflow_templates_drive_id_idx').on(table.driveId),
    createdByIdx: index('workflow_templates_created_by_idx').on(table.createdBy),
    isPublicIdx: index('workflow_templates_is_public_idx').on(table.isPublic),
    categoryIdx: index('workflow_templates_category_idx').on(table.category),
  };
});

// Workflow Steps - Individual steps within a workflow template
export const workflowSteps = pgTable('workflow_steps', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  workflowTemplateId: text('workflowTemplateId').notNull().references(() => workflowTemplates.id, { onDelete: 'cascade' }),
  stepOrder: integer('stepOrder').notNull(),
  agentId: text('agentId').notNull(),
  promptTemplate: text('promptTemplate').notNull(),
  requiresUserInput: boolean('requiresUserInput').default(false).notNull(),
  inputSchema: jsonb('inputSchema'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    templateIdx: index('workflow_steps_template_id_idx').on(table.workflowTemplateId),
    templateOrderIdx: index('workflow_steps_template_id_order_idx').on(table.workflowTemplateId, table.stepOrder),
  };
});

// Workflow Executions - Running instances of workflow templates
export const workflowExecutions = pgTable('workflow_executions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  workflowTemplateId: text('workflowTemplateId').notNull().references(() => workflowTemplates.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  status: workflowExecutionStatus('status').default('running').notNull(),
  currentStepOrder: integer('currentStepOrder'),
  accumulatedContext: jsonb('accumulatedContext').default({}).notNull(),
  startedAt: timestamp('startedAt', { mode: 'date' }),
  pausedAt: timestamp('pausedAt', { mode: 'date' }),
  completedAt: timestamp('completedAt', { mode: 'date' }),
  failedAt: timestamp('failedAt', { mode: 'date' }),
  errorMessage: text('errorMessage'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    templateIdx: index('workflow_executions_template_id_idx').on(table.workflowTemplateId),
    userIdx: index('workflow_executions_user_id_idx').on(table.userId),
    driveIdx: index('workflow_executions_drive_id_idx').on(table.driveId),
    statusIdx: index('workflow_executions_status_idx').on(table.status),
    userStatusIdx: index('workflow_executions_user_id_status_idx').on(table.userId, table.status),
    driveStatusIdx: index('workflow_executions_drive_id_status_idx').on(table.driveId, table.status),
  };
});

// Workflow Execution Steps - Records of individual step executions
export const workflowExecutionSteps = pgTable('workflow_execution_steps', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  workflowExecutionId: text('workflowExecutionId').notNull().references(() => workflowExecutions.id, { onDelete: 'cascade' }),
  workflowStepId: text('workflowStepId').references(() => workflowSteps.id, { onDelete: 'set null' }),
  stepOrder: integer('stepOrder').notNull(),
  status: workflowExecutionStepStatus('status').default('pending').notNull(),
  agentInput: jsonb('agentInput'),
  agentOutput: jsonb('agentOutput'),
  userInput: jsonb('userInput'),
  startedAt: timestamp('startedAt', { mode: 'date' }),
  completedAt: timestamp('completedAt', { mode: 'date' }),
  errorMessage: text('errorMessage'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    executionIdx: index('workflow_execution_steps_execution_id_idx').on(table.workflowExecutionId),
    stepIdx: index('workflow_execution_steps_step_id_idx').on(table.workflowStepId),
    statusIdx: index('workflow_execution_steps_status_idx').on(table.status),
    executionOrderIdx: index('workflow_execution_steps_execution_id_order_idx').on(table.workflowExecutionId, table.stepOrder),
  };
});

// Relations
export const workflowTemplatesRelations = relations(workflowTemplates, ({ one, many }) => ({
  drive: one(drives, {
    fields: [workflowTemplates.driveId],
    references: [drives.id],
  }),
  creator: one(users, {
    fields: [workflowTemplates.createdBy],
    references: [users.id],
  }),
  steps: many(workflowSteps),
  executions: many(workflowExecutions),
}));

export const workflowStepsRelations = relations(workflowSteps, ({ one, many }) => ({
  template: one(workflowTemplates, {
    fields: [workflowSteps.workflowTemplateId],
    references: [workflowTemplates.id],
  }),
  executionSteps: many(workflowExecutionSteps),
}));

export const workflowExecutionsRelations = relations(workflowExecutions, ({ one, many }) => ({
  template: one(workflowTemplates, {
    fields: [workflowExecutions.workflowTemplateId],
    references: [workflowTemplates.id],
  }),
  user: one(users, {
    fields: [workflowExecutions.userId],
    references: [users.id],
  }),
  drive: one(drives, {
    fields: [workflowExecutions.driveId],
    references: [drives.id],
  }),
  steps: many(workflowExecutionSteps),
}));

export const workflowExecutionStepsRelations = relations(workflowExecutionSteps, ({ one }) => ({
  execution: one(workflowExecutions, {
    fields: [workflowExecutionSteps.workflowExecutionId],
    references: [workflowExecutions.id],
  }),
  stepDefinition: one(workflowSteps, {
    fields: [workflowExecutionSteps.workflowStepId],
    references: [workflowSteps.id],
  }),
}));
