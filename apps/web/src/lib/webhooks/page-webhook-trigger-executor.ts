import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { pages } from '@pagespace/db/schema/core';
import { workflows } from '@pagespace/db/schema/workflows';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import type { WebhookTrigger } from '@pagespace/db/schema/webhook-triggers';
import {
  executeWorkflow,
  type WorkflowExecutionResult,
  type WorkflowExecutionInput,
} from '@/lib/workflows/workflow-executor';
import { isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { WEBHOOK_DAILY_EXPOSURE_CAP_CENTS, CREDIT_HOLD_ESTIMATE_CENTS } from '@pagespace/lib/billing/credit-pricing';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { resolveSteps, hasAiStep, countAiSteps } from '@/lib/workflows/core/step-plan';
import { frameWebhookPayloadPrompt } from './webhook-payload-framing';

const logger = loggers.api.child({ module: 'page-webhook-trigger-executor' });

/**
 * Execute a single page-webhook-triggered agent invocation.
 *
 * The page-anchored counterpart to Zoom's executeWebhookTrigger: the
 * webhook_triggers row holds only the (pageWebhook → workflow) wiring, so we
 * load the linked workflows row for the execution payload, preflight
 * access/agent-page, gate credit, and delegate to the shared executor
 * UNMODIFIED. Two things differ from the Zoom path:
 *  - Billing resolves to `workflow.createdBy` (there is no OAuth connection
 *    owner); membership + credit gate + the released hold all key off them.
 *  - A page can be bulk-moved to a different drive AFTER a trigger is bound
 *    (rewriting pages.driveId), so the webhook page's CURRENT drive is the
 *    authoritative same-drive guard here — the create-time CRUD check cannot
 *    survive a later move. A mismatch is skipped and recorded, never executed.
 *
 * Per-fire state lives in workflow_runs (written by executeWorkflow). Never
 * throws — every failure is returned as a result so the fan-out records it.
 */
export async function executePageWebhookTrigger(
  trigger: WebhookTrigger,
  envelope: unknown,
): Promise<WorkflowExecutionResult> {
  const startTime = Date.now();

  try {
    // 1. Load the linked workflow (the trigger holds only the wiring).
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, trigger.workflowId));

    if (!workflow) {
      return {
        success: false,
        durationMs: Date.now() - startTime,
        error: `Linked workflow ${trigger.workflowId} not found`,
      };
    }

    // 2. Authoritative same-drive guard. The trigger must be page-anchored;
    //    resolve the webhook's page and compare its CURRENT drive to the
    //    workflow's drive. A page moved out of the workflow's drive after the
    //    binding was created is stale — skip + record, never execute.
    if (!trigger.pageWebhookId) {
      return {
        success: false,
        durationMs: Date.now() - startTime,
        error: 'Trigger is not anchored to a page webhook',
      };
    }
    const [webhook] = await db
      .select({ pageId: pageWebhooks.pageId })
      .from(pageWebhooks)
      .where(eq(pageWebhooks.id, trigger.pageWebhookId));
    if (!webhook) {
      return {
        success: false,
        durationMs: Date.now() - startTime,
        error: `Page webhook ${trigger.pageWebhookId} not found`,
      };
    }
    const [webhookPage] = await db
      .select({ driveId: pages.driveId, isTrashed: pages.isTrashed })
      .from(pages)
      .where(eq(pages.id, webhook.pageId));
    if (!webhookPage || webhookPage.isTrashed) {
      return {
        success: false,
        durationMs: Date.now() - startTime,
        error: `Webhook page ${webhook.pageId} not found or trashed`,
      };
    }
    if (webhookPage.driveId !== workflow.driveId) {
      const error =
        'Webhook page and workflow are in different drives (binding stale after a page move)';
      logger.warn('Page webhook trigger: skipped (drive mismatch)', {
        triggerId: trigger.id,
        webhookDriveId: webhookPage.driveId,
        workflowDriveId: workflow.driveId,
      });
      return { success: false, durationMs: Date.now() - startTime, error };
    }

    // 3. Billing resolves to workflow.createdBy — verify they still belong to
    //    the workflow's drive before spending their credit.
    const hasDriveAccess = await isUserDriveMember(workflow.createdBy, workflow.driveId);
    if (!hasDriveAccess) {
      return {
        success: false,
        durationMs: Date.now() - startTime,
        error: 'Workflow owner no longer has access to the drive',
      };
    }

    // 4. Resolve the step mix. AI resources (agent preflight, credit gate)
    //    are claimed only when an ai step exists; deterministic-only chains
    //    skip them entirely — no model is ever invoked.
    const steps = resolveSteps({
      steps: workflow.steps,
      prompt: workflow.prompt,
      agentPageId: workflow.agentPageId,
    });
    const needsAi = hasAiStep(steps);

    // 5. Preflight every effective agent page (ai steps only): each must
    //    still exist, be untrashed, AND live in the workflow's drive. Same
    //    authoritative fire-time guard as the webhook page (step 2) — an
    //    agent page can ALSO be bulk-moved after binding, and executeWorkflow
    //    loads it by id and writes the webhook prompt + AI response into it.
    //    The owner staying a member of workflow.driveId says nothing about a
    //    drive the agent was moved into, so a moved agent must be rejected,
    //    not written to across drives.
    if (needsAi) {
      const agentIds = [
        ...new Set(
          steps
            .filter((step): step is Extract<typeof step, { kind: 'ai' }> => step.kind === 'ai')
            .map((step) => step.agentPageId ?? workflow.agentPageId)
            .filter((id): id is string => Boolean(id))
        ),
      ];
      if (agentIds.length === 0) {
        return {
          success: false,
          durationMs: Date.now() - startTime,
          error: 'Workflow has ai steps but no effective agent page',
        };
      }
      for (const agentId of agentIds) {
        const [agentPage] = await db
          .select({ id: pages.id, isTrashed: pages.isTrashed, driveId: pages.driveId })
          .from(pages)
          .where(eq(pages.id, agentId));
        if (!agentPage || agentPage.isTrashed) {
          return {
            success: false,
            durationMs: Date.now() - startTime,
            error: `Trigger agent page ${agentId} not found or trashed`,
          };
        }
        if (agentPage.driveId !== workflow.driveId) {
          const error =
            'Agent page and workflow are in different drives (binding stale after a page move)';
          logger.warn('Page webhook trigger: skipped (agent page drive mismatch)', {
            triggerId: trigger.id,
            agentDriveId: agentPage.driveId,
            workflowDriveId: workflow.driveId,
          });
          return { success: false, durationMs: Date.now() - startTime, error };
        }
      }
    }

    // 6. Credit gate on the billed user (ai steps only) — blocks
    //    out-of-credits users before the model is invoked. Unlike the Zoom
    //    path (whose trigger source is an authenticated OAuth account), this
    //    run is forced by whoever holds the webhook secret — a bearer
    //    credential handed to external systems. The daily exposure cap
    //    therefore MUST apply, and because the env tier caps default to
    //    DISABLED, the webhook-specific ceiling (default-on) is what
    //    guarantees a hard per-day monetary bound on a leaked secret even on
    //    unconfigured deployments. Deterministic-only chains take no hold:
    //    their blast radius is bounded by the deterministic budget in the
    //    fan-out plus each tool's own permission checks.
    //
    //    A single gate call/hold covers the WHOLE run, not one AI call —
    //    runStepChain bills provider usage once per ai step (up to
    //    MAX_WORKFLOW_STEPS), so the reservation must be sized by the
    //    chain's ai-step count or a multi-step chain blows straight through
    //    the daily exposure ceiling this gate exists to enforce.
    let holdId: string | undefined;
    if (needsAi) {
      const [owner] = await db
        .select({ subscriptionTier: users.subscriptionTier })
        .from(users)
        .where(eq(users.id, workflow.createdBy));
      const gate = await canConsumeAI(
        workflow.createdBy,
        (owner?.subscriptionTier ?? 'free') as SubscriptionTier,
        {
          dailyCapCeilingCents: WEBHOOK_DAILY_EXPOSURE_CAP_CENTS,
          estCostCents: CREDIT_HOLD_ESTIMATE_CENTS * countAiSteps(steps),
        },
      );
      if (!gate.allowed) {
        logger.info('Page webhook trigger: skipped (credit gate denied)', {
          triggerId: trigger.id,
          reason: gate.reason,
        });
        return {
          success: false,
          durationMs: Date.now() - startTime,
          error: `AI credit gate denied: ${gate.reason}`,
        };
      }
      holdId = gate.holdId;
    }

    // 7. Compose execution input — executeWorkflow writes workflow_runs and
    //    owns the single-running claim. Legacy workflows get the F2-framed
    //    promptOverride (prompt first, nonce-fenced envelope last); explicit
    //    step chains get the raw parsed payload instead — deterministic steps
    //    consume it via $payload references, and the executor F2-frames it
    //    per ai step.
    const input: WorkflowExecutionInput = {
      workflowId: workflow.id,
      workflowName: `page-webhook-trigger-${trigger.id}`,
      driveId: workflow.driveId,
      createdBy: workflow.createdBy,
      agentPageId: workflow.agentPageId,
      prompt: workflow.prompt,
      steps: workflow.steps,
      contextPageIds: (workflow.contextPageIds as string[] | null) ?? [],
      instructionPageId: workflow.instructionPageId,
      timezone: workflow.timezone,
      source: { table: 'webhookTriggers', id: trigger.id, triggerAt: new Date() },
      eventContext:
        workflow.steps && workflow.steps.length > 0
          ? { payload: envelope }
          : { promptOverride: frameWebhookPayloadPrompt(workflow.prompt, envelope) },
    };

    // executeWorkflow calls AIMonitoring.trackUsage → consumeCredits internally.
    // Release the hold here so the user's spendable balance is accurate after
    // execution, whether it succeeds, fails, or throws.
    let result: WorkflowExecutionResult;
    try {
      result = await executeWorkflow(input);
    } finally {
      if (holdId) void releaseHold(holdId).catch(() => {});
    }

    logger.info('Page webhook trigger executed', {
      triggerId: trigger.id,
      workflowId: workflow.id,
      success: result.success,
      durationMs: result.durationMs,
    });

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Page webhook trigger execution failed', {
      triggerId: trigger.id,
      error: errorMessage,
      durationMs,
    });

    return { success: false, durationMs, error: errorMessage };
  }
}

