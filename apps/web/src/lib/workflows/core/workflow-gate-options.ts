/**
 * Pure credit-gate sizing for a workflow run. `executeWorkflow` is the ONE
 * place a run is gated (every entry point — manual, cron, task trigger,
 * calendar, zoom and page webhooks — passes through it), so the policy that
 * used to be copied into each trigger executor lives here as data.
 *
 * - No ai step ⇒ no gate: deterministic-only chains never invoke a model.
 * - The hold covers the WHOLE run: runStepChain bills once per ai step.
 * - A manual run is interactive, so the concurrency cap always applies.
 * - A caller may add `skipDailyCap` (server-scheduled fires) or a
 *   `dailyCapCeilingCents` (bearer-forced webhook fires). Absent a policy the
 *   tier daily cap applies — a new caller that forgets one fails safe.
 */

export interface WorkflowGatePolicy {
  skipDailyCap?: boolean;
  dailyCapCeilingCents?: number;
}

interface WorkflowGateOptions {
  estCostCents: number;
  maxInFlight?: number;
  skipDailyCap?: boolean;
  dailyCapCeilingCents?: number;
}

interface WorkflowGateOptionsInput {
  sourceTable: string;
  aiStepCount: number;
  policy: WorkflowGatePolicy | undefined;
  holdEstimateCents: number;
  maxInteractiveInFlight: number;
}

export function workflowGateOptions(input: WorkflowGateOptionsInput): WorkflowGateOptions | null {
  if (input.aiStepCount === 0) return null;
  return {
    estCostCents: input.holdEstimateCents * input.aiStepCount,
    ...(input.sourceTable === 'manual' ? { maxInFlight: input.maxInteractiveInFlight } : {}),
    ...input.policy,
  };
}
