import { tool } from 'ai';
import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { eq, and, isNotNull } from '@pagespace/db/operators';
import { workflows } from '@pagespace/db/schema/workflows';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { type ToolExecutionContext } from '../core';
import { canActorManageDrive } from './actor-permissions';
import { agentTriggerBaseSchema, validateAgentTrigger } from '@/lib/workflows/agent-trigger-shared';
import {
  validateCronExpression,
  validateTimezone,
  getNextRunDate,
  getHumanReadableCron,
} from '@/lib/workflows/cron-utils';

const logger = loggers.api.child({ module: 'workflow-tools' });

const DEFAULT_TRIGGER_PROMPT = 'Execute instructions from linked page.';

/**
 * Tools for standalone, recurring (cron) agent workflows.
 *
 * A workflow runs an agent on a schedule with no host entity — distinct from
 * task triggers (bound to a task's due date / completion) and calendar triggers
 * (bound to an event's time), which stay inline on their entity tools. The
 * workflows table and the cron poller (app/api/cron/workflows) already exist;
 * these tools are the agent-facing surface for creating and managing them. The
 * shared agentTriggerBaseSchema / validateAgentTrigger keep "who runs, with what
 * context" identical to the task and calendar surfaces.
 */
export const workflowTools = {
  create_workflow: tool({
    description: `Create a standalone recurring workflow that runs an AI agent on a cron schedule.

Use this for scheduled, repeating agent work that isn't tied to a task due date or a calendar event — e.g. "every weekday at 9am, summarize new activity". For one-off or entity-bound scheduling, attach an agentTrigger to a task (update_task) or calendar event (create_calendar_event) instead.

The cron expression must not fire more often than every 5 minutes (the polling cadence). Times are interpreted in the workflow timezone.`,
    inputSchema: z.object({
      driveId: z.string().describe('Drive the workflow belongs to. The agent and any instruction/context pages must live in this drive.'),
      name: z.string().min(1).max(200).describe('Human-readable workflow name'),
      cronExpression: z.string().describe('Cron expression for the schedule, e.g. "0 9 * * 1-5" (weekdays at 9am). Minimum interval 5 minutes.'),
      timezone: z.string().optional().describe('IANA timezone for the schedule (e.g. "America/New_York"). Defaults to the user timezone, then UTC.'),
      agentTrigger: agentTriggerBaseSchema.describe('Who runs and with what context. Provide either a prompt or an instructionPageId.'),
    }),
    execute: async (
      { driveId, name, cronExpression, timezone, agentTrigger },
      { experimental_context: context },
    ) => {
      const ctx = context as ToolExecutionContext;
      const userId = ctx?.userId;
      if (!userId) throw new Error('User authentication required');

      if (!(await canActorManageDrive(ctx, driveId))) {
        throw new Error('No access to the specified drive');
      }

      const cronCheck = validateCronExpression(cronExpression);
      if (!cronCheck.valid) {
        throw new Error(cronCheck.error ?? 'Invalid cron expression');
      }

      const tz = timezone || ctx.timezone || 'UTC';
      const tzCheck = validateTimezone(tz);
      if (!tzCheck.valid) {
        throw new Error(tzCheck.error ?? `Invalid timezone: ${tz}`);
      }

      await validateAgentTrigger(db, { driveId, agentTrigger, entityLabel: 'workflow' });

      const nextRunAt = getNextRunDate(cronExpression, tz);

      const [created] = await db
        .insert(workflows)
        .values({
          driveId,
          createdBy: userId,
          name,
          agentPageId: agentTrigger.agentPageId,
          prompt: agentTrigger.prompt?.trim() || DEFAULT_TRIGGER_PROMPT,
          contextPageIds: agentTrigger.contextPageIds ?? [],
          instructionPageId: agentTrigger.instructionPageId ?? null,
          cronExpression,
          timezone: tz,
          triggerType: 'cron',
          isEnabled: true,
          nextRunAt,
        })
        .returning({ id: workflows.id });

      logger.info('Created cron workflow', {
        workflowId: created.id,
        driveId,
        agentPageId: agentTrigger.agentPageId,
        cronExpression,
        timezone: tz,
      });

      return {
        success: true,
        workflowId: created.id,
        name,
        schedule: getHumanReadableCron(cronExpression),
        cronExpression,
        timezone: tz,
        nextRunAt: nextRunAt.toISOString(),
        summary: `Created workflow "${name}" — ${getHumanReadableCron(cronExpression)} (${tz}). Next run ${nextRunAt.toISOString()}.`,
      };
    },
  }),

  list_workflows: tool({
    description: 'List the standalone cron workflows in a drive. Does not include task- or calendar-bound triggers, which are managed via update_task / calendar tools.',
    inputSchema: z.object({
      driveId: z.string().describe('Drive to list workflows for'),
    }),
    execute: async ({ driveId }, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext;
      if (!ctx?.userId) throw new Error('User authentication required');
      if (!(await canActorManageDrive(ctx, driveId))) {
        throw new Error('No access to the specified drive');
      }

      const rows = await db
        .select({
          id: workflows.id,
          name: workflows.name,
          agentPageId: workflows.agentPageId,
          cronExpression: workflows.cronExpression,
          timezone: workflows.timezone,
          isEnabled: workflows.isEnabled,
          nextRunAt: workflows.nextRunAt,
        })
        .from(workflows)
        .where(and(eq(workflows.driveId, driveId), isNotNull(workflows.cronExpression)));

      return {
        success: true,
        workflows: rows.map((w) => ({
          workflowId: w.id,
          name: w.name,
          agentPageId: w.agentPageId,
          schedule: w.cronExpression ? getHumanReadableCron(w.cronExpression) : null,
          cronExpression: w.cronExpression,
          timezone: w.timezone,
          isEnabled: w.isEnabled,
          nextRunAt: w.nextRunAt ? w.nextRunAt.toISOString() : null,
        })),
        summary: `Found ${rows.length} workflow${rows.length === 1 ? '' : 's'} in this drive.`,
      };
    },
  }),

  update_workflow: tool({
    description: `Update a standalone cron workflow: rename, reschedule (new cronExpression / timezone), pause or resume (isEnabled), or change which agent runs and with what context. Only standalone workflows can be edited here — task- and calendar-bound triggers are managed via their own tools.`,
    inputSchema: z.object({
      workflowId: z.string().describe('ID of the workflow to update'),
      name: z.string().min(1).max(200).optional().describe('New name'),
      cronExpression: z.string().optional().describe('New cron schedule (min 5-minute interval)'),
      timezone: z.string().optional().describe('New IANA timezone'),
      isEnabled: z.boolean().optional().describe('Pause (false) or resume (true) the workflow'),
      agentTrigger: agentTriggerBaseSchema.partial().optional().describe('Change the agent and/or its prompt, instruction page, or context pages. Omitted fields are left unchanged.'),
    }),
    execute: async (
      { workflowId, name, cronExpression, timezone, isEnabled, agentTrigger },
      { experimental_context: context },
    ) => {
      const ctx = context as ToolExecutionContext;
      if (!ctx?.userId) throw new Error('User authentication required');

      const [workflow] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
      if (!workflow) throw new Error('Workflow not found');
      if (!(await canActorManageDrive(ctx, workflow.driveId))) {
        throw new Error('No access to this workflow\'s drive');
      }
      if (!workflow.cronExpression) {
        throw new Error('This workflow is managed by a task or calendar event; edit it there.');
      }

      const updates: Partial<typeof workflows.$inferInsert> = {};

      if (name !== undefined) updates.name = name;
      if (isEnabled !== undefined) updates.isEnabled = isEnabled;

      if (agentTrigger) {
        const merged = {
          agentPageId: agentTrigger.agentPageId ?? workflow.agentPageId,
          prompt: agentTrigger.prompt ?? workflow.prompt,
          instructionPageId:
            agentTrigger.instructionPageId !== undefined ? agentTrigger.instructionPageId : workflow.instructionPageId,
          contextPageIds:
            agentTrigger.contextPageIds !== undefined ? agentTrigger.contextPageIds : (workflow.contextPageIds ?? []),
        };
        await validateAgentTrigger(db, { driveId: workflow.driveId, agentTrigger: merged, entityLabel: 'workflow' });
        updates.agentPageId = merged.agentPageId;
        updates.prompt = merged.prompt?.trim() || DEFAULT_TRIGGER_PROMPT;
        updates.instructionPageId = merged.instructionPageId ?? null;
        updates.contextPageIds = merged.contextPageIds ?? [];
      }

      const effectiveCron = cronExpression ?? workflow.cronExpression;
      const effectiveTz = timezone ?? workflow.timezone;

      if (cronExpression !== undefined) {
        const cronCheck = validateCronExpression(cronExpression);
        if (!cronCheck.valid) throw new Error(cronCheck.error ?? 'Invalid cron expression');
        updates.cronExpression = cronExpression;
      }
      if (timezone !== undefined) {
        const tzCheck = validateTimezone(timezone);
        if (!tzCheck.valid) throw new Error(tzCheck.error ?? `Invalid timezone: ${timezone}`);
        updates.timezone = timezone;
      }
      // Reschedule the next run whenever the schedule or timezone changes, or
      // when a paused workflow is resumed (a stale nextRunAt may be in the past).
      const resuming = isEnabled === true && !workflow.isEnabled;
      if (cronExpression !== undefined || timezone !== undefined || resuming) {
        updates.nextRunAt = getNextRunDate(effectiveCron, effectiveTz);
      }

      await db.update(workflows).set(updates).where(eq(workflows.id, workflowId));

      logger.info('Updated cron workflow', { workflowId, fields: Object.keys(updates) });

      return {
        success: true,
        workflowId,
        schedule: getHumanReadableCron(effectiveCron),
        timezone: effectiveTz,
        isEnabled: updates.isEnabled ?? workflow.isEnabled,
        nextRunAt: updates.nextRunAt ? updates.nextRunAt.toISOString() : (workflow.nextRunAt?.toISOString() ?? null),
        summary: `Updated workflow ${workflowId}.`,
      };
    },
  }),

  delete_workflow: tool({
    description: 'Delete a standalone cron workflow. Task- and calendar-bound triggers cannot be deleted here — remove them via their own tools.',
    inputSchema: z.object({
      workflowId: z.string().describe('ID of the workflow to delete'),
    }),
    execute: async ({ workflowId }, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext;
      if (!ctx?.userId) throw new Error('User authentication required');

      const [workflow] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
      if (!workflow) throw new Error('Workflow not found');
      if (!(await canActorManageDrive(ctx, workflow.driveId))) {
        throw new Error('No access to this workflow\'s drive');
      }
      if (!workflow.cronExpression) {
        throw new Error('This workflow is managed by a task or calendar event; remove it there.');
      }

      await db.delete(workflows).where(eq(workflows.id, workflowId));

      logger.info('Deleted cron workflow', { workflowId, driveId: workflow.driveId });

      return { success: true, workflowId, summary: `Deleted workflow "${workflow.name}".` };
    },
  }),
};
