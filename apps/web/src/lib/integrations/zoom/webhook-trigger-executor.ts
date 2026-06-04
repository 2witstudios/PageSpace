import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { workflows } from '@pagespace/db/schema/workflows';
import type { ZoomConnection } from '@pagespace/db/schema/zoom';
import type { WebhookTrigger } from '@pagespace/db/schema/webhook-triggers';
import { executeWorkflow, type WorkflowExecutionResult, type WorkflowExecutionInput } from '@/lib/workflows/workflow-executor';
import { isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';

const logger = loggers.api.child({ module: 'webhook-trigger-executor' });

export interface ZoomWebhookEvent {
  event: string;
  payload: unknown;
}

/**
 * Execute a single webhook-triggered agent invocation.
 *
 * Mirrors executeCalendarTrigger: the webhook_triggers row holds only the
 * (connection, eventType → workflow) wiring, so we load the linked workflows
 * row for the execution payload, preflight access + agent page, consume a
 * usage credit on the connection owner's budget, and delegate to the shared
 * executor. Per-fire state lives in workflow_runs (written by the executor).
 */
export async function executeWebhookTrigger(
  trigger: WebhookTrigger,
  event: ZoomWebhookEvent,
  connection: ZoomConnection,
): Promise<WorkflowExecutionResult> {
  const startTime = Date.now();

  try {
    // 1. Load the linked workflows row (the trigger holds only the wiring)
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, trigger.workflowId));

    if (!workflow) {
      const error = `Linked workflow ${trigger.workflowId} not found`;
      return { success: false, durationMs: Date.now() - startTime, error };
    }

    // 2. Verify the connection owner still has access to the workflow's drive
    const hasDriveAccess = await isUserDriveMember(connection.userId, workflow.driveId);
    if (!hasDriveAccess) {
      const error = 'Connection owner no longer has access to the drive';
      return { success: false, durationMs: Date.now() - startTime, error };
    }

    // 3. Cheap preflight: verify agent page still exists
    const [agentPage] = await db
      .select({ id: pages.id, isTrashed: pages.isTrashed })
      .from(pages)
      .where(eq(pages.id, workflow.agentPageId));

    if (!agentPage || agentPage.isTrashed) {
      const error = `Trigger agent page ${workflow.agentPageId} not found or trashed`;
      return { success: false, durationMs: Date.now() - startTime, error };
    }

    // 4. Build the prompt from the workflow's stored prompt + Zoom event context
    const promptOverride = buildWebhookTriggerPrompt(workflow.prompt, event);

    // 5. Compose execution input — the executor writes workflow_runs
    const input: WorkflowExecutionInput = {
      workflowId: workflow.id,
      workflowName: `webhook-trigger-${trigger.id}`,
      driveId: workflow.driveId,
      createdBy: connection.userId,
      agentPageId: workflow.agentPageId,
      prompt: workflow.prompt,
      contextPageIds: (workflow.contextPageIds as string[] | null) ?? [],
      instructionPageId: workflow.instructionPageId,
      timezone: workflow.timezone,
      source: { table: 'webhookTriggers', id: trigger.id, triggerAt: new Date() },
      eventContext: { promptOverride },
    };

    const result = await executeWorkflow(input);

    logger.info('Webhook trigger executed', {
      triggerId: trigger.id,
      workflowId: workflow.id,
      eventType: event.event,
      success: result.success,
      durationMs: result.durationMs,
    });

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Webhook trigger execution failed', {
      triggerId: trigger.id,
      error: errorMessage,
      durationMs,
    });

    return { success: false, durationMs, error: errorMessage };
  }
}

function buildWebhookTriggerPrompt(workflowPrompt: string, event: ZoomWebhookEvent): string {
  const parts: string[] = [];
  parts.push('<zoom-event>');
  parts.push(`Event: ${event.event}`);
  parts.push(`Payload: ${JSON.stringify(event.payload)}`);
  parts.push('</zoom-event>');
  parts.push(`\n${workflowPrompt}`);
  return parts.join('\n');
}
