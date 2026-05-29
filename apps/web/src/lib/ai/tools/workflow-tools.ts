import { tool } from 'ai';
import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { workflows } from '@pagespace/db/schema/workflows';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { type ToolExecutionContext } from '../core';
import { canActorAccessDrive } from './actor-permissions';
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

      if (!(await canActorAccessDrive(ctx, driveId))) {
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
};
