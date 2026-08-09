import { convertToModelMessages, generateText, stepCountIs, hasToolCall, type ToolSet } from 'ai';
import { finishTool, FINISH_TOOL_NAME } from '@/lib/ai/tools/finish-tool';
import { mergeToolSets } from '@/lib/ai/core/tool-utils';
import { createId } from '@paralleldrive/cuid2';
import { createAIProvider, isProviderError, type ProviderRequest } from '@/lib/ai/core/provider-factory';
import { pageSpaceTools } from '@/lib/ai/core/ai-tools';
import { filterToolsForDispatchCredentials, filterToolsForImageGen, filterToolsForSandboxEnablement, filterToolsForSandboxTier, SANDBOX_COMPUTE_TOOL_NAMES } from '@/lib/ai/core/tool-filtering';
import { resolveSandboxToolEligibility } from '@/lib/ai/core/sandbox-tool-eligibility';
import { spawnSession, createConversationInSession, endSession } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { buildTimestampSystemPrompt } from '@/lib/ai/core/timestamp-utils';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '@/lib/ai/core/ai-providers-config';
import type { ToolExecutionContext } from '@/lib/ai/core/types';
import { messageRepository } from '@/lib/repositories/message-repository';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { db } from '@pagespace/db/db'
import { eq, and, inArray } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { decryptField } from '@pagespace/lib/encryption/field-crypto'
import { pages, drives } from '@pagespace/db/schema/core'
import { taskItems, taskLists, taskAssignees, taskStatusConfigs } from '@pagespace/db/schema/tasks'
import { workflowRuns } from '@pagespace/db/schema/workflow-runs'
import { workflowRunSteps } from '@pagespace/db/schema/workflow-run-steps'
import type { WorkflowStep, WorkflowToolStep } from '@pagespace/db/schema/workflows'
import { isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { MAX_WORKFLOW_STEPS } from './core/step-plan';
import { resolveStepArgs } from './core/resolve-step-args';
import { applyImplicitStepArgs } from './core/implicit-step-args';
import { frameWebhookPayloadPrompt } from '@/lib/webhooks/webhook-payload-framing';
import { DETERMINISTIC_TOOL_ALLOWLIST, getDeterministicTools } from '@/lib/ai/core/deterministic-tools';
import type { z } from 'zod';

export type WorkflowRunSource =
  | { table: 'cron'; id: null; triggerAt: Date | null }
  | { table: 'manual'; id: null; triggerAt: null }
  | { table: 'taskTriggers'; id: string; triggerAt: Date | null }
  | { table: 'calendarTriggers'; id: string; triggerAt: Date }
  | { table: 'webhookTriggers'; id: string; triggerAt: Date | null };

export interface WorkflowExecutionResult {
  success: boolean;
  responseText?: string;
  toolCallCount?: number;
  durationMs: number;
  error?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  conversationId?: string;
  /** ID of the workflow_runs row written for this fire, when one was claimed. */
  runId?: string;
  /** True iff the partial unique index rejected the claim (another in-flight run). */
  claimConflict?: boolean;
  /**
   * Set when execution itself completed but the end-of-run UPDATE on
   * workflow_runs failed. The row is left in 'running' state and the
   * stuck-run sweeper will mark it as 'error' after the timeout. Callers
   * should surface this so persisted state divergence is observable.
   */
  finalizeError?: string;
}

/**
 * Minimum execution-relevant shape consumed by executeWorkflow().
 *
 * Decoupled from the workflows table row so callers (cron pollers,
 * task-trigger fires, calendar-trigger fires, manual /run) can compose
 * input from their own source of truth without forging fake rows.
 *
 * `taskContext` and `eventContext` are optional, mutually exclusive
 * augmentations injected by the trigger-fire path so executeWorkflow
 * doesn't need to know which kind of trigger it serves.
 */
export interface WorkflowExecutionInput {
  workflowId: string;
  workflowName: string;
  driveId: string;
  createdBy: string;
  /** Null only for step-based workflows whose ai steps carry their own agent. */
  agentPageId: string | null;
  prompt: string;
  /**
   * Explicit step chain. Null/absent = legacy single-AI-prompt workflow —
   * executed exactly as before, with no workflow_run_steps rows.
   */
  steps?: WorkflowStep[] | null;
  contextPageIds: string[];
  instructionPageId: string | null;
  timezone: string;
  /** Identifies the originating trigger so workflow_runs can be joined back to it. */
  source: WorkflowRunSource;
  taskContext?: { taskItemId: string; triggerType: 'due_date' | 'completion' };
  /**
   * promptOverride replaces the prompt of legacy runs / ai steps (the webhook
   * path builds it with the F2 nonce-fenced payload framing). `payload` is
   * the raw parsed trigger payload consumed by deterministic steps' $payload
   * references; absent for cron/manual runs (refs then strict-fail).
   */
  eventContext?: { promptOverride?: string; payload?: unknown };
}

export async function executeWorkflow(input: WorkflowExecutionInput): Promise<WorkflowExecutionResult> {
  const startTime = Date.now();

  // 0. Atomic claim via workflow_runs partial unique index. The
  //    workflow_runs_running_claim_idx ensures only one row with
  //    status='running' exists per workflowId; ON CONFLICT DO NOTHING
  //    means a concurrent caller losing the race gets zero rows back.
  const [runRow] = await db
    .insert(workflowRuns)
    .values({
      workflowId: input.workflowId,
      sourceTable: input.source.table,
      sourceId: input.source.id,
      triggerAt: input.source.triggerAt,
      status: 'running',
    })
    .onConflictDoNothing()
    .returning({ id: workflowRuns.id });

  if (!runRow) {
    return {
      success: false,
      durationMs: Date.now() - startTime,
      error: 'Workflow already running',
      claimConflict: true,
    };
  }

  const runId = runRow.id;
  let result: WorkflowExecutionResult;

  try {
    const explicitSteps = input.steps && input.steps.length > 0 ? input.steps : null;
    if (explicitSteps) {
      result = await runStepChain(input, explicitSteps, runId, startTime);
    } else if (input.agentPageId) {
      // Legacy single-AI-prompt path, byte-for-byte pre-steps behavior.
      result = await runExecution(input, startTime, {
        prompt: input.eventContext?.promptOverride ?? input.prompt,
        agentPageId: input.agentPageId,
      });
    } else {
      result = {
        success: false,
        durationMs: Date.now() - startTime,
        error: 'workflow has no steps and no agentPageId',
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result = {
      success: false,
      durationMs: Date.now() - startTime,
      error: errorMessage,
    };
  }

  const finalizeError = await finalizeRun(runId, result);

  return finalizeError
    ? { ...result, runId, finalizeError }
    : { ...result, runId };
}

/**
 * Update the workflow_runs row with the end-of-run state. Returns the error
 * message string if the UPDATE failed (caller surfaces it on the result so
 * persisted-state divergence is observable); returns null on success. The
 * row is left in 'running' if this fails — the stuck-run sweeper marks it
 * 'error' after STUCK_RUN_TIMEOUT_MS.
 */
async function finalizeRun(runId: string, result: WorkflowExecutionResult): Promise<string | null> {
  try {
    await db
      .update(workflowRuns)
      .set({
        status: result.success ? 'success' : 'error',
        endedAt: new Date(),
        durationMs: result.durationMs,
        error: result.error ?? null,
        conversationId: result.conversationId ?? null,
      })
      .where(eq(workflowRuns.id, runId));
    return null;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    loggers.api.error('Failed to finalize workflow_run', {
      runId,
      error: errorMessage,
    });
    return errorMessage;
  }
}

/**
 * Execute an explicit step chain: sequential, fail-fast, per-step
 * workflow_run_steps audit rows. Deterministic (tool) steps invoke the
 * allowlisted registry tool directly — no LLM, no AI billing. AI steps reuse
 * the legacy execution body with the step's own prompt/agent.
 */
async function runStepChain(
  input: WorkflowExecutionInput,
  steps: WorkflowStep[],
  runId: string,
  startTime: number
): Promise<WorkflowExecutionResult> {
  if (steps.length > MAX_WORKFLOW_STEPS) {
    return {
      success: false,
      durationMs: Date.now() - startTime,
      error: `workflow has ${steps.length} steps (max ${MAX_WORKFLOW_STEPS})`,
    };
  }

  const summaries: string[] = [];
  let toolCallCount = 0;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let conversationId: string | undefined;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepStart = Date.now();
    const [stepRow] = await db
      .insert(workflowRunSteps)
      .values({
        runId,
        position: i,
        kind: step.kind,
        toolName: step.kind === 'tool' ? step.toolName : null,
        status: 'running',
      })
      .returning({ id: workflowRunSteps.id });

    let stepError: string | null = null;

    if (step.kind === 'tool') {
      const result = await runToolStep(step, i, input);
      if (result.ok) {
        toolCallCount += 1;
        summaries.push(`[step ${i + 1}: ${step.toolName}] ok`);
      } else {
        stepError = result.error;
      }
    } else {
      const effectiveAgentPageId = step.agentPageId ?? input.agentPageId;
      if (!effectiveAgentPageId) {
        stepError = 'ai step has no agentPageId (step or workflow)';
      } else {
        // Webhook-triggered chains carry the raw payload; ai steps receive it
        // F2-framed (prompt first, nonce-fenced envelope last, marked
        // untrusted) — same containment as the legacy promptOverride path.
        const payload = input.eventContext?.payload;
        const aiResult = await runExecution(input, stepStart, {
          prompt:
            payload !== undefined
              ? frameWebhookPayloadPrompt(step.prompt, payload)
              : step.prompt,
          agentPageId: effectiveAgentPageId,
        });
        if (aiResult.success) {
          if (aiResult.responseText) summaries.push(aiResult.responseText);
          toolCallCount += aiResult.toolCallCount ?? 0;
          conversationId = conversationId ?? aiResult.conversationId;
          if (aiResult.usage) {
            usage = {
              inputTokens: (usage?.inputTokens ?? 0) + (aiResult.usage.inputTokens ?? 0),
              outputTokens: (usage?.outputTokens ?? 0) + (aiResult.usage.outputTokens ?? 0),
            };
          }
        } else {
          stepError = aiResult.error ?? 'ai step failed';
        }
      }
    }

    await db
      .update(workflowRunSteps)
      .set({
        status: stepError === null ? 'success' : 'error',
        error: stepError,
        durationMs: Date.now() - stepStart,
        endedAt: new Date(),
      })
      .where(eq(workflowRunSteps.id, stepRow.id));

    if (stepError !== null) {
      // Fail-fast: record the remaining steps as skipped, fail the run.
      if (i + 1 < steps.length) {
        await db.insert(workflowRunSteps).values(
          steps.slice(i + 1).map((rest, offset) => ({
            runId,
            position: i + 1 + offset,
            kind: rest.kind,
            toolName: rest.kind === 'tool' ? rest.toolName : null,
            status: 'skipped' as const,
            endedAt: new Date(),
          }))
        );
      }
      return {
        success: false,
        durationMs: Date.now() - startTime,
        error: `step ${i + 1} (${step.kind === 'tool' ? step.toolName : 'ai'}): ${stepError}`,
        toolCallCount,
        usage,
        conversationId,
      };
    }
  }

  return {
    success: true,
    responseText: summaries.join('\n'),
    toolCallCount,
    durationMs: Date.now() - startTime,
    usage,
    conversationId,
  };
}

type ToolStepResult = { ok: true } | { ok: false; error: string };

/**
 * Direct tool invocation (execute-tool.ts pattern): allowlist re-check →
 * $payload resolution → zod safeParse → execute as workflow.createdBy. The
 * tool's own internal permission checks (canActorEditPage etc.) are the
 * authorization backstop. No locationContext is provided, so tools requiring
 * a pageId must receive it explicitly in args — default-page resolution is
 * deliberately unavailable to deterministic steps.
 */
async function runToolStep(
  step: WorkflowToolStep,
  index: number,
  input: WorkflowExecutionInput
): Promise<ToolStepResult> {
  if (!(DETERMINISTIC_TOOL_ALLOWLIST as readonly string[]).includes(step.toolName)) {
    return { ok: false, error: `tool "${step.toolName}" is not deterministically invocable` };
  }
  const tool = getDeterministicTools()[step.toolName];
  if (!tool || typeof tool.execute !== 'function') {
    return { ok: false, error: `tool "${step.toolName}" is unavailable in the registry` };
  }

  const resolved = resolveStepArgs(step.args, input.eventContext?.payload);
  if (!resolved.ok) return resolved;
  const effectiveArgs = applyImplicitStepArgs(step.toolName, resolved.args, input.driveId);

  const schema = tool.inputSchema as z.ZodType | undefined;
  if (!schema || typeof schema.safeParse !== 'function') {
    return { ok: false, error: `tool "${step.toolName}" has no input schema` };
  }
  const parsed = schema.safeParse(effectiveArgs);
  if (!parsed.success) {
    return {
      ok: false,
      error: `resolved args do not match the "${step.toolName}" input schema`,
    };
  }

  const executionContext: ToolExecutionContext = {
    userId: input.createdBy,
    timezone: input.timezone,
  };

  try {
    const execute = tool.execute as (
      args: unknown,
      options: { toolCallId: string; messages: never[]; experimental_context: ToolExecutionContext }
    ) => Promise<unknown>;
    const result = await execute(parsed.data, {
      toolCallId: `wf-step-${index}`,
      messages: [],
      experimental_context: executionContext,
    });
    const failed =
      typeof result === 'object' &&
      result !== null &&
      'success' in result &&
      (result as { success: unknown }).success === false;
    if (failed) {
      const message =
        'error' in (result as Record<string, unknown>)
          ? String((result as Record<string, unknown>).error)
          : 'tool reported failure';
      return { ok: false, error: message };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Release a run-scoped workflow session, with one bounded retry for transient
 * faults. Durable safety does NOT depend on this succeeding: `endSession`
 * (`endAgentSession`) stamps `teardownRequestedAt` BEFORE it kills, so a
 * failed or half-finished teardown is reclaimed by the
 * `reconcile-orphaned-sprites` cron on its next tick — this helper's job is
 * to make the common case immediate and the residual case loudly observable
 * (error-level, not a swallowed warn), never to be a second reaper.
 */
async function releaseWorkflowSession(workspaceId: string, workflowId: string): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // `endSession` reports most failures as a RESOLVED `{ ok: false }`
      // (teardown_failed keeps the Sprite live and billing), not a throw —
      // both shapes get the same bounded retry + error-level residual log
      // (codex round 10: the old unconditional return treated a resolved
      // failure as success and skipped both).
      const result = await endSession(workspaceId);
      if (result && result.ok === false) {
        if (attempt === 2) {
          loggers.api.error(
            'Workflow executor: run-scoped session teardown failed after retry — the orphan-Sprite reconcile cron will reclaim it',
            undefined,
            { workspaceId, workflowId, reason: result.reason, detail: result.detail },
          );
        }
        continue;
      }
      return;
    } catch (error) {
      if (attempt === 2) {
        loggers.api.error(
          'Workflow executor: run-scoped session teardown failed after retry — the orphan-Sprite reconcile cron will reclaim it',
          error instanceof Error ? error : undefined,
          { workspaceId, workflowId },
        );
      }
    }
  }
}

async function runExecution(
  input: WorkflowExecutionInput,
  startTime: number,
  exec: { prompt: string; agentPageId: string }
): Promise<WorkflowExecutionResult> {
  // The run-scoped agent session backing this execution's sandbox tools, if
  // one was minted (see step 6c). Declared outside the try so the `finally`
  // can release its compute on EVERY exit, success or thrown.
  let workflowSessionId: string | null = null;
  try {
    // 1. Load agent page
    const [agent] = await db
      .select()
      .from(pages)
      .where(eq(pages.id, exec.agentPageId));

    if (!agent) {
      return { success: false, durationMs: Date.now() - startTime, error: 'Agent page not found' };
    }
    if (agent.type !== 'AI_CHAT') {
      return { success: false, durationMs: Date.now() - startTime, error: 'Agent page is not an AI_CHAT type' };
    }
    if (agent.isTrashed) {
      return { success: false, durationMs: Date.now() - startTime, error: 'Agent page is in trash' };
    }

    // 2. Load drive
    const [drive] = await db
      .select()
      .from(drives)
      .where(eq(drives.id, input.driveId));

    if (!drive) {
      return { success: false, durationMs: Date.now() - startTime, error: 'Drive not found' };
    }

    // 3. Build system prompt
    const systemPrompt = agent.systemPrompt || 'You are a helpful AI assistant.';
    let enhancedSystemPrompt = systemPrompt;

    if (agent.includeDrivePrompt && drive.drivePrompt) {
      enhancedSystemPrompt += `\n\n${drive.drivePrompt}`;
    }

    enhancedSystemPrompt += `\n\n${buildTimestampSystemPrompt(input.timezone)}`;

    enhancedSystemPrompt += `\n\nCONTEXT AWARENESS:\n`;
    enhancedSystemPrompt += `- Current Drive: ${drive.name} (${drive.slug})\n`;
    enhancedSystemPrompt += `- Drive ID: ${drive.id}\n`;
    enhancedSystemPrompt += `\nYou are operating within this drive. Use this drive ID (${drive.id}) as the default when using tools like list_pages, create_page, etc. unless explicitly told otherwise.`;
    enhancedSystemPrompt += `\n\nThis is an automated workflow execution. Execute the requested task thoroughly and completely.`;

    // 4. Build user message — the caller resolved override/step prompt already
    let userMessage = exec.prompt;

    const contextPageIds = input.contextPageIds ?? [];
    if (contextPageIds.length > 0) {
      const validContextPages = await db
        .select({ id: pages.id, title: pages.title, content: pages.content })
        .from(pages)
        .where(
          and(
            inArray(pages.id, contextPageIds),
            eq(pages.driveId, input.driveId),
            eq(pages.isTrashed, false)
          )
        );

      if (validContextPages.length > 0) {
        userMessage += '\n\n--- Reference Documents ---';
        for (const page of validContextPages) {
          userMessage += `\n\n## ${page.title}\n${page.content || '(empty)'}`;
        }
      }
    }

    // 4b. Inject task context when this fire was triggered by a task event
    if (input.taskContext) {
      const taskContext = await buildTaskContext(input.taskContext.taskItemId, input.taskContext.triggerType);
      if (taskContext) {
        userMessage = taskContext + '\n\n' + userMessage;
      }
    }

    // 4c. Load instruction page content if present
    if (input.instructionPageId) {
      const instrContent = await loadInstructionPage(input.instructionPageId, input.createdBy);
      if (instrContent) {
        userMessage += '\n\n--- Detailed Instructions ---\n' + instrContent;
      }
    }

    // 5. Resolve AI provider using workflow creator's keys
    const selectedProvider = agent.aiProvider || DEFAULT_PROVIDER;
    const selectedModel = agent.aiModel || DEFAULT_MODEL;

    const providerRequest: ProviderRequest = {
      selectedProvider,
      selectedModel,
    };

    const providerResult = await createAIProvider(input.createdBy, providerRequest);

    if (isProviderError(providerResult)) {
      return { success: false, durationMs: Date.now() - startTime, error: `AI provider error: ${providerResult.error}` };
    }

    // 6. Filter tools based on agent's enabled tools
    const enabledTools = (agent.enabledTools as string[] | null) ?? [];
    // Image generation is in an ADMIN-ONLY rollout and is exposed solely through the
    // chat/global routes' explicit toggle — never through scheduled workflows.
    const workflowTools = filterToolsForImageGen(pageSpaceTools, false);
    let availableTools: ToolSet = enabledTools.length > 0
      ? Object.fromEntries(
          Object.entries(workflowTools).filter(([toolName]) =>
            enabledTools.includes(toolName)
          )
        ) as ToolSet
      : {};

    // 6b. The per-agent sandbox switch AND payer-tier eligibility — same gate
    // interactive chat applies (chat/route.ts Step 3b). `enabledTools` alone
    // cannot re-grant the sandbox families: an agent with sandboxEnabled off,
    // or whose drive's payer isn't sandbox-eligible, must not get bash/git
    // tools just because a workflow happens to list them. The real security
    // boundary is still canRunCode (kill-switch + tier + drive role),
    // re-checked at call time; this is agent configuration + UX, matching
    // Step 3b's own reasoning.
    const workflowSandboxEnabled = Boolean(agent.sandboxEnabled);
    const workflowSandboxTierEligible = workflowSandboxEnabled
      ? await resolveSandboxToolEligibility(agent.driveId ?? null, input.createdBy)
      : false;
    availableTools = filterToolsForSandboxEnablement(availableTools, workflowSandboxEnabled) as ToolSet;
    // Tier strips only COMPUTE tools — the chat-only session family stays
    // (sessions/chat are free on every plan).
    availableTools = filterToolsForSandboxTier(availableTools, workflowSandboxTierEligible) as ToolSet;

    // Workflows execute the same page agent used in chat, so they should also
    // inherit integration grants such as GitHub/Notion tools.
    try {
      const { resolvePageAgentIntegrationTools } = await import('@/lib/ai/core/integration-tool-resolver');
      const integrationTools = await resolvePageAgentIntegrationTools({
        agentId: agent.id,
        userId: input.createdBy,
        driveId: input.driveId,
        currentTools: availableTools,
      });

      if (Object.keys(integrationTools).length > 0) {
        availableTools = mergeToolSets(availableTools, integrationTools);
        loggers.api.info('Workflow executor: merged integration tools', {
          workflowId: input.workflowId,
          agentId: agent.id,
          integrationToolCount: Object.keys(integrationTools).length,
          totalTools: Object.keys(availableTools).length,
        });
      }
    } catch (error) {
      loggers.api.error('Workflow executor: failed to resolve integration tools', error as Error, {
        workflowId: input.workflowId,
        agentId: agent.id,
      });
    }

    // 6c. Session-backed execution (review #2326, three rounds). The session
    // runtime resolves a conversation's BOUND SESSION and refuses session-less
    // callers — a synthetic `workflow-…` id has no conversation row at all,
    // so EVERY session-backed tool the gates above admitted (bash/file/git
    // compute AND the chat-only session family, which free-tier and
    // kill-switch-off runs keep) would answer `no_session` and never execute.
    //
    // spawn_session/send_session are stripped from EVERY workflow run —
    // two structural mismatches, not a credential nuance (codex rounds 7, 8
    // and 11): (1) dispatch relays a live browser request's cookie, which
    // cron/task/calendar/webhook fires never have; (2) even a manual run
    // executes against a RUN-SCOPED session that the `finally` below ends
    // the moment the run finishes — a fire-and-forget worker dispatched
    // without `wait: true` would outlive its own workspace, losing its
    // Sprite mid-call or re-provisioning after cleanup already ran. A
    // workflow run is a single bounded turn; it delegates by finishing, not
    // by leaving detached workers behind.
    //
    // A session is minted only when a surviving COMPUTE tool can act in a
    // fresh run-scoped workspace. When none survived, the chat-side
    // leftovers (list/read/kill_session, which could only ever report an
    // empty just-born workspace) are stripped instead of spending a session
    // row + owner cap slot on them. When compute did survive: mint the same
    // thing an interactive spawn would — a REAL session in the agent's
    // drive plus a REAL conversation bound to it (the run's messages then
    // land in that conversation, inspectable like any other), released in
    // `finally` when the run ends. A spawn refusal (owner at their session
    // cap, transient fault) degrades to running WITHOUT the session-backed
    // families rather than failing the workflow — the same posture as an
    // agent with the sandbox toggled off.
    let conversationId = `workflow-${input.workflowId}-${Date.now()}`;
    availableTools = filterToolsForDispatchCredentials(availableTools, false) as ToolSet;
    const sessionBackedToolsActive =
      workflowSandboxEnabled &&
      Object.keys(availableTools).some((name) => SANDBOX_COMPUTE_TOOL_NAMES.has(name));
    if (!sessionBackedToolsActive) {
      availableTools = filterToolsForSandboxEnablement(availableTools, false) as ToolSet;
    }
    if (sessionBackedToolsActive) {
      const spawned = await spawnSession({
        userId: input.createdBy,
        driveId: agent.driveId ?? input.driveId,
        name: `Workflow: ${input.workflowName}`.slice(0, 100),
      });
      if (spawned.ok) {
        const boundConversationId = createId();
        try {
          await createConversationInSession({
            conversationId: boundConversationId,
            userId: input.createdBy,
            agentPageId: agent.id,
            workspaceId: spawned.session.id,
            title: `Workflow: ${input.workflowName}`.slice(0, 100),
          });
          conversationId = boundConversationId;
          workflowSessionId = spawned.session.id;
        } catch (error) {
          await releaseWorkflowSession(spawned.session.id, input.workflowId);
          // No session ⇒ the WHOLE session-backed surface is unusable, the
          // chat-only family included — the enablement filter (not the tier
          // filter, which deliberately preserves chat-only session tools)
          // strips all three families.
          availableTools = filterToolsForSandboxEnablement(availableTools, false) as ToolSet;
          loggers.api.warn('Workflow executor: session conversation bind failed — running without session-backed tools', {
            workflowId: input.workflowId,
            workspaceId: spawned.session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        availableTools = filterToolsForSandboxEnablement(availableTools, false) as ToolSet;
        loggers.api.warn('Workflow executor: session spawn refused — running without session-backed tools', {
          workflowId: input.workflowId,
          reason: spawned.reason,
        });
      }
    }

    // 7. Build execution context
    const executionContext: ToolExecutionContext = {
      userId: input.createdBy,
      timezone: input.timezone,
      aiProvider: agent.aiProvider ?? undefined,
      aiModel: agent.aiModel ?? undefined,
      conversationId,
      // The run's agent identity, exactly as the chat route passes it: the
      // session tools' `callerAgentPageId` reads `chatSource.agentPageId` so
      // an agent-less `spawn_session` inherits THIS agent (not the Global
      // Assistant), and channel messages attribute to the agent (codex
      // round 10).
      chatSource: {
        type: 'page' as const,
        agentPageId: agent.id,
        agentTitle: agent.title ?? undefined,
      },
      locationContext: {
        currentPage: {
          id: agent.id,
          title: agent.title,
          type: agent.type,
          path: `/${agent.title}`,
        },
        currentDrive: {
          id: drive.id,
          name: drive.name,
          slug: drive.slug,
        },
      },
    };

    const messages = [{ role: 'user' as const, content: userMessage }];

    // 8. Call generateText
    const result = Object.keys(availableTools).length > 0
      ? await generateText({
          model: providerResult.model,
          system: enhancedSystemPrompt,
          messages: await convertToModelMessages(messages.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
            parts: [{ type: 'text' as const, text: m.content }],
          }))),
          tools: { ...availableTools, ...finishTool },
          toolChoice: 'auto',
          maxRetries: 3,
          experimental_context: executionContext,
          stopWhen: [hasToolCall(FINISH_TOOL_NAME), stepCountIs(100)],
        })
      : await generateText({
          model: providerResult.model,
          system: enhancedSystemPrompt,
          messages: await convertToModelMessages(messages.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
            parts: [{ type: 'text' as const, text: m.content }],
          }))),
          maxRetries: 3,
          experimental_context: executionContext,
          stopWhen: stepCountIs(100),
        });

    // Collect text from all steps — result.text only returns the final step,
    // which may be empty if the model's last action was calling the finish tool
    const responseText = result.steps?.map(s => s.text).filter(Boolean).join('') || '';
    const toolCallCount = result.steps?.reduce(
      (count, step) => count + (step.toolCalls?.length || 0),
      0
    ) || 0;

    // 9. Save user prompt + AI response as chat messages
    const userMessageId = createId();
    const assistantMessageId = createId();

    await messageRepository.savePageMessage({
      messageId: userMessageId,
      pageId: agent.id,
      conversationId,
      userId: input.createdBy,
      role: 'user',
      content: userMessage,
    });

    await messageRepository.savePageMessage({
      messageId: assistantMessageId,
      pageId: agent.id,
      conversationId,
      userId: null,
      role: 'assistant',
      content: responseText,
      mentionNotify: {
        driveId: input.driveId,
        triggeredByUserId: input.createdBy,
        mentionerName: agent.title,
      },
    });

    // 10. Track usage. AWAITED per trackAIUsage's contract: the usage log (and
    // the billing settle it drives) must be durable before this run reports
    // completion — callers release credit-gate holds as soon as we return, and
    // the webhook path's daily-ceiling accounting reads aiUsageLogs, so a
    // detached write here would open a window where neither the hold nor the
    // landed cost is visible to the next gate check.
    const usage = result.usage;
    await AIMonitoring.trackUsage({
      userId: input.createdBy,
      provider: providerResult.provider,
      model: providerResult.modelName,
      source: 'workflow',
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage ? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) : undefined,
      pageId: agent.id,
      driveId: input.driveId,
      success: true,
    });

    const durationMs = Date.now() - startTime;

    loggers.api.info('Workflow executed successfully', {
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      agentId: agent.id,
      agentTitle: agent.title,
      responseLength: responseText.length,
      toolCallCount,
      durationMs,
    });

    return {
      success: true,
      responseText,
      toolCallCount,
      durationMs,
      usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : undefined,
      conversationId,
    };

  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    loggers.api.error('Workflow execution failed', {
      workflowId: input.workflowId,
      error: errorMessage,
      durationMs,
    });

    return {
      success: false,
      durationMs,
      error: errorMessage,
    };
  } finally {
    // Release the run-scoped session's compute on every exit. `endSession`
    // tears the Sprite down (billing stops); the bound conversation and its
    // messages persist as the run's inspectable record. Retried once, with
    // the orphan-Sprite reconcile cron as the durable backstop (see
    // `releaseWorkflowSession`).
    if (workflowSessionId) {
      await releaseWorkflowSession(workflowSessionId, input.workflowId);
    }
  }
}

/**
 * Build a task context block for task trigger workflows.
 */
async function buildTaskContext(taskItemId: string, triggerType: 'due_date' | 'completion'): Promise<string | null> {
  const task = await db.query.taskItems.findFirst({
    where: eq(taskItems.id, taskItemId),
    with: {
      page: {
        columns: { title: true, parentId: true },
      },
    },
  });

  if (!task) return null;

  const taskListPageId = task.page?.parentId;
  const taskList = taskListPageId
    ? await db.query.taskLists.findFirst({
        where: eq(taskLists.pageId, taskListPageId),
        columns: { id: true, title: true },
      })
    : undefined;

  const parts: string[] = ['<task-context>'];
  parts.push(`Title: ${task.page?.title ?? ''}`);
  parts.push(`Status: ${task.status}`);
  parts.push(`Priority: ${task.priority}`);
  if (task.dueDate) parts.push(`Due Date: ${task.dueDate.toISOString()}`);
  if (task.completedAt) parts.push(`Completed At: ${task.completedAt.toISOString()}`);

  // Status group context
  if (taskList) {
    parts.push(`Task List: ${taskList.title}`);
    const statusConfig = await db.query.taskStatusConfigs.findFirst({
      where: and(
        eq(taskStatusConfigs.taskListId, taskList.id),
        eq(taskStatusConfigs.slug, task.status),
      ),
      columns: { group: true, name: true },
    });
    if (statusConfig) {
      parts.push(`Status Label: ${statusConfig.name} (${statusConfig.group})`);
    }
  }

  // Assignees (avoid email PII — use names/titles only)
  const assignees = await db
    .select({
      userName: users.name,
      agentTitle: pages.title,
    })
    .from(taskAssignees)
    .leftJoin(users, eq(taskAssignees.userId, users.id))
    .leftJoin(pages, eq(taskAssignees.agentPageId, pages.id))
    .where(eq(taskAssignees.taskId, taskItemId));

  if (assignees.length > 0) {
    // Decrypt PII at the edge (GDPR #965) so assignee names in the prompt are plaintext.
    const names = await Promise.all(
      assignees.map(async a => (await decryptField(a.userName)) || a.agentTitle || 'Unknown assignee'),
    );
    parts.push(`Assignees: ${names.join(', ')}`);
  }

  if (triggerType === 'due_date') {
    parts.push('Trigger: This task\'s due date has arrived.');
  } else if (triggerType === 'completion') {
    parts.push('Trigger: This task was just completed.');
  }

  parts.push('</task-context>');
  return parts.join('\n');
}

async function loadInstructionPage(pageId: string, userId: string): Promise<string | null> {
  const [instrPage] = await db
    .select({ title: pages.title, content: pages.content, driveId: pages.driveId, isTrashed: pages.isTrashed })
    .from(pages)
    .where(eq(pages.id, pageId));

  if (!instrPage || instrPage.isTrashed || !instrPage.content) return null;

  if (instrPage.driveId) {
    const hasAccess = await isUserDriveMember(userId, instrPage.driveId);
    if (!hasAccess) return null;
  } else {
    return null;
  }

  return `## ${instrPage.title}\n${instrPage.content}`;
}
