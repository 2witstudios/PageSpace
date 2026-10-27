/**
 * Pure step planning: legacy-row synthesis, AI detection, and fail-fast
 * status transitions. The executor shell owns I/O; this module owns the
 * decisions.
 */

import type { WorkflowStep } from '@pagespace/db/schema/workflows';

export const MAX_WORKFLOW_STEPS = 20;

export type StepSource = {
  steps: WorkflowStep[] | null;
  prompt: string;
  agentPageId: string | null;
};

/**
 * A workflow's effective step list. Legacy rows (steps null/empty) synthesize
 * the single AI step that reproduces pre-steps behavior exactly.
 */
export function resolveSteps(workflow: StepSource): WorkflowStep[] {
  if (workflow.steps && workflow.steps.length > 0) return workflow.steps;
  return [
    {
      kind: 'ai',
      prompt: workflow.prompt,
      ...(workflow.agentPageId ? { agentPageId: workflow.agentPageId } : {}),
    },
  ];
}

export function hasAiStep(steps: readonly WorkflowStep[]): boolean {
  return steps.some((step) => step.kind === 'ai');
}

/**
 * Count of ai steps in a chain. A single credit-gate hold/ceiling-check
 * covers the whole run, not one call — the caller must size its reservation
 * by this count, not assume one AI invocation per fire (runStepChain calls
 * runExecution, and therefore bills provider usage, once per ai step).
 */
export function countAiSteps(steps: readonly WorkflowStep[]): number {
  return steps.filter((step) => step.kind === 'ai').length;
}

export type PlannedStepStatus = 'success' | 'error' | 'skipped';

/**
 * Fail-fast semantics as data: given the step count and the index of the
 * first failure (null = none), the settled status of every step.
 */
export function planStepStatuses(
  stepCount: number,
  failedIndex: number | null
): PlannedStepStatus[] {
  return Array.from({ length: stepCount }, (_, i) => {
    if (failedIndex === null || i < failedIndex) return 'success';
    return i === failedIndex ? 'error' : 'skipped';
  });
}
