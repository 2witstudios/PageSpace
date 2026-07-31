import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import type { WorkflowStep } from '@pagespace/db/schema/workflows';
import { MAX_WORKFLOW_STEPS } from './core/step-plan';
import { validateSteps, stepsRequirePayload } from './core/step-validation';

/**
 * Request-shape schema for workflow steps (create + update routes). Structural
 * only — allowlist/schema/agent checks happen in validateStepsForApi.
 */
export const workflowStepsSchema = z
  .array(
    z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('ai'),
          prompt: z.string().min(1),
          agentPageId: z.string().min(1).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('tool'),
          toolName: z.string().min(1),
          args: z.record(z.string(), z.unknown()),
        })
        .strict(),
    ])
  )
  .min(1)
  .max(MAX_WORKFLOW_STEPS);

export type StepsApiValidation =
  | { ok: true; warnings: string[] }
  | { ok: false; error: string };

/**
 * Save-time validation for an explicit step chain: pure core checks
 * (allowlist, $payload path syntax, full schema parse when ref-free, ai-step
 * agent presence) plus the drive-scoped AI_CHAT check for every effective
 * agent page. Returns warnings for legal-but-suspicious configs — currently
 * cron/manual runs of chains that reference the trigger payload.
 */
export async function validateStepsForApi(
  steps: WorkflowStep[],
  options: { driveId: string; workflowAgentPageId: string | null }
): Promise<StepsApiValidation> {
  // Lazy import: the tool registry's module graph is heavy (every tool module
  // loads at import time) and API routes must not pay it — same pattern as
  // workflow-executor's integration-tool-resolver import.
  const { DETERMINISTIC_TOOL_ALLOWLIST, getDeterministicToolSchemas } = await import(
    '@/lib/ai/core/deterministic-tools'
  );
  const coreResult = validateSteps(steps, {
    allowlist: DETERMINISTIC_TOOL_ALLOWLIST,
    schemas: getDeterministicToolSchemas(),
    workflowAgentPageId: options.workflowAgentPageId,
  });
  if (!coreResult.ok) return coreResult;

  const agentIds = [
    ...new Set(
      steps
        .filter((step): step is Extract<WorkflowStep, { kind: 'ai' }> => step.kind === 'ai')
        .map((step) => step.agentPageId ?? options.workflowAgentPageId)
        .filter((id): id is string => Boolean(id))
    ),
  ];

  if (agentIds.length > 0) {
    const agentPages = await db
      .select({ id: pages.id, type: pages.type })
      .from(pages)
      .where(
        and(
          inArray(pages.id, agentIds),
          eq(pages.driveId, options.driveId),
          eq(pages.isTrashed, false)
        )
      );
    const found = new Map(agentPages.map((page) => [page.id, page.type]));
    for (const id of agentIds) {
      const type = found.get(id);
      if (!type) {
        return { ok: false, error: `ai step agent page ${id} not found in this drive` };
      }
      if (type !== 'AI_CHAT') {
        return { ok: false, error: `ai step agent page ${id} is not an AI agent` };
      }
    }
  }

  const warnings: string[] = [];
  if (stepsRequirePayload(steps)) {
    warnings.push(
      'This workflow references the trigger payload ($payload). Cron and manual runs carry no payload and will fail on those steps — bind the workflow to a webhook trigger to supply one.'
    );
  }
  return { ok: true, warnings };
}
