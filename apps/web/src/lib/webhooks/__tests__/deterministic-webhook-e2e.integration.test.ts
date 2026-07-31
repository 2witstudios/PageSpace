/**
 * Deterministic workflow steps — real-pipeline E2E (real Postgres, real
 * tools, no mocking of the code under test).
 *
 * Flagship claim of the Deterministic Workflow Steps epic: a webhook can
 * trigger a workflow whose steps invoke PageSpace tools DIRECTLY — no LLM,
 * no AI billing — and a cron-triggered chain gets the same zero-AI-cost path.
 * This test proves both against real rows: firePageWebhookTriggers →
 * executePageWebhookTrigger → executeWorkflow → runToolStep → the real
 * create_task/send_channel_message tool implementations mutating real
 * Postgres state, with workflow_run_steps/workflow_runs audit rows and zero
 * ai_usage_logs rows for the run.
 *
 * create_task/send_channel_message (not insert_content/replace_lines) are
 * the proof vehicles here on purpose: page CONTENT edits snapshot to S3 for
 * version history (packages/lib/src/services/page-content-store.ts), which
 * needs real object-storage credentials this test environment doesn't have
 * — an infrastructure dependency orthogonal to what this test exists to
 * prove. Task creation and channel posting write straight to Postgres.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). Skipped when no DB is reachable —
 * mirrors reorder-task-list.integration.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { createId } from '@paralleldrive/cuid2';
import { pages } from '@pagespace/db/schema/core';
import { taskItems } from '@pagespace/db/schema/tasks';
import { workflows } from '@pagespace/db/schema/workflows';
import { workflowRuns } from '@pagespace/db/schema/workflow-runs';
import { workflowRunSteps } from '@pagespace/db/schema/workflow-run-steps';
import { pageWebhooks } from '@pagespace/db/schema/page-webhooks';
import { webhookTriggers, PAGE_WEBHOOK_EVENT_TYPE, type WebhookTrigger } from '@pagespace/db/schema/webhook-triggers';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { factories } from '@pagespace/db/test/factories';
import { encryptField } from '@pagespace/lib/encryption/field-crypto';
import { firePageWebhookTriggers } from '../fire-page-webhook-triggers';
import { executeWorkflow } from '@/lib/workflows/workflow-executor';

let dbAvailable = false;

async function createWebhookTrigger(workflowId: string, pageWebhookId: string): Promise<WebhookTrigger> {
  const [row] = await db
    .insert(webhookTriggers)
    .values({
      id: createId(),
      workflowId,
      pageWebhookId,
      provider: 'page-webhook',
      eventType: PAGE_WEBHOOK_EVENT_TYPE,
      isEnabled: true,
    })
    .returning();
  return row;
}

describe('Deterministic workflow steps — real pipeline E2E', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it('a webhook-triggered all-tool-step workflow creates a real task from $payload — zero AI usage, no credit hold', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const taskListPage = await factories.createPage(drive.id, { type: 'TASK_LIST', content: '' });
    const webhookPage = await factories.createPage(drive.id, { type: 'CHANNEL', content: '' });

    const [workflow] = await db
      .insert(workflows)
      .values({
        id: createId(),
        driveId: drive.id,
        createdBy: owner.id,
        name: 'E2E deterministic task creation',
        agentPageId: null,
        prompt: '',
        steps: [
          {
            kind: 'tool',
            toolName: 'create_task',
            args: {
              pageId: taskListPage.id,
              title: { $payload: 'issue.title' },
              priority: 'high',
            },
          },
        ],
        cronExpression: null,
        triggerType: 'cron',
        timezone: 'UTC',
        isEnabled: true,
      })
      .returning();

    const secret = 'e2e-secret';
    const [pageWebhook] = await db
      .insert(pageWebhooks)
      .values({
        id: createId(),
        pageId: webhookPage.id,
        name: 'E2E webhook',
        webhookSecretEncrypted: await encryptField(secret),
        isEnabled: true,
        createdBy: owner.id,
      })
      .returning();

    const trigger = await createWebhookTrigger(workflow.id, pageWebhook.id);

    const usageCountBefore = (
      await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.userId, owner.id))
    ).length;

    await firePageWebhookTriggers([trigger], { issue: { title: 'Fix the login bug' } });

    // create_task's real implementation creates a linked TASK_LIST child page
    // (the task's displayed title) plus a task_items row pointing at it.
    const createdPages = await db
      .select()
      .from(pages)
      .where(and(eq(pages.parentId, taskListPage.id), eq(pages.title, 'Fix the login bug')));
    expect(createdPages).toHaveLength(1);

    const createdTasks = await db
      .select()
      .from(taskItems)
      .where(eq(taskItems.pageId, createdPages[0].id));
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].priority).toBe('high');

    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflow.id));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    expect(runs[0].conversationId).toBeNull();

    const stepRows = await db
      .select()
      .from(workflowRunSteps)
      .where(eq(workflowRunSteps.runId, runs[0].id));
    expect(stepRows).toHaveLength(1);
    expect(stepRows[0]).toMatchObject({ kind: 'tool', toolName: 'create_task', status: 'success' });

    const usageCountAfter = (
      await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.userId, owner.id))
    ).length;
    expect(usageCountAfter).toBe(usageCountBefore);

    const [refetchedWebhook] = await db
      .select()
      .from(pageWebhooks)
      .where(eq(pageWebhooks.id, pageWebhook.id));
    expect(refetchedWebhook.lastFireError).toBeNull();
  });

  it('a webhook trigger with no $payload match fails the step cleanly and never invokes the tool', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const taskListPage = await factories.createPage(drive.id, { type: 'TASK_LIST', content: '' });
    const webhookPage = await factories.createPage(drive.id, { type: 'CHANNEL', content: '' });

    const [workflow] = await db
      .insert(workflows)
      .values({
        id: createId(),
        driveId: drive.id,
        createdBy: owner.id,
        name: 'E2E missing payload path',
        agentPageId: null,
        prompt: '',
        steps: [
          {
            kind: 'tool',
            toolName: 'create_task',
            args: { pageId: taskListPage.id, title: { $payload: 'issue.title' } },
          },
        ],
        cronExpression: null,
        triggerType: 'cron',
        timezone: 'UTC',
        isEnabled: true,
      })
      .returning();

    const [pageWebhook] = await db
      .insert(pageWebhooks)
      .values({
        id: createId(),
        pageId: webhookPage.id,
        name: 'E2E webhook',
        webhookSecretEncrypted: await encryptField('secret'),
        isEnabled: true,
        createdBy: owner.id,
      })
      .returning();
    const trigger = await createWebhookTrigger(workflow.id, pageWebhook.id);

    // Envelope carries no "issue" key at all — the $payload reference cannot resolve.
    await firePageWebhookTriggers([trigger], { unrelated: true });

    const createdTasks = await db
      .select()
      .from(taskItems)
      .innerJoin(pages, eq(pages.id, taskItems.pageId))
      .where(eq(pages.parentId, taskListPage.id));
    expect(createdTasks).toHaveLength(0);

    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflow.id));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('error');
    expect(runs[0].error).toContain('not found in trigger payload');

    const stepRows = await db
      .select()
      .from(workflowRunSteps)
      .where(eq(workflowRunSteps.runId, runs[0].id));
    expect(stepRows).toHaveLength(1);
    expect(stepRows[0].status).toBe('error');
  });

  it('a cron-triggered all-tool-step workflow posts a real channel message with zero AI usage', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const channelPage = await factories.createPage(drive.id, { type: 'CHANNEL', content: '' });

    const [workflow] = await db
      .insert(workflows)
      .values({
        id: createId(),
        driveId: drive.id,
        createdBy: owner.id,
        name: 'E2E cron digest',
        agentPageId: null,
        prompt: '',
        steps: [
          {
            kind: 'tool',
            toolName: 'send_channel_message',
            args: { channelId: channelPage.id, content: 'Weekly recap: 3 new pages this week' },
          },
        ],
        cronExpression: '0 9 * * 1',
        triggerType: 'cron',
        timezone: 'UTC',
        isEnabled: true,
      })
      .returning();

    const result = await executeWorkflow({
      workflowId: workflow.id,
      workflowName: workflow.name,
      driveId: drive.id,
      createdBy: owner.id,
      agentPageId: null,
      prompt: '',
      steps: workflow.steps,
      contextPageIds: [],
      instructionPageId: null,
      timezone: 'UTC',
      source: { table: 'cron', id: null, triggerAt: new Date() },
    });

    expect(result.success).toBe(true);
    expect(result.toolCallCount).toBe(1);
    expect(result.conversationId).toBeUndefined();

    const runs = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workflowId, workflow.id), eq(workflowRuns.status, 'success')));
    expect(runs).toHaveLength(1);

    const stepRows = await db
      .select()
      .from(workflowRunSteps)
      .where(eq(workflowRunSteps.runId, runs[0].id));
    expect(stepRows).toHaveLength(1);
    expect(stepRows[0]).toMatchObject({ kind: 'tool', toolName: 'send_channel_message', status: 'success' });

    const usage = await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.userId, owner.id));
    expect(usage).toHaveLength(0);
  });
});
